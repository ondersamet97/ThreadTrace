"use strict";

/*
 * Shared view-side client. Content script and popup both talk to the
 * service worker through this one safe write path; neither writes to
 * storage directly and neither sends a whole state copy.
 *
 * If a response is lost (sendMessage rejects or returns nothing), the
 * SAME message — same opId — is retried once. The worker recognises
 * the opId, so a retry can never roll back a newer value.
 *
 * If both attempts lose their response, the outcome is genuinely
 * uncertain (the write may or may not have landed). The client then
 * throws an error with code "UNCERTAIN_OUTCOME" that carries the
 * opId and the exact message, and keeps that pending operation so
 * the caller can later retry it verbatim via retryPendingOperation()
 * (or by resending getPendingOperation().message) — never by minting
 * a fresh opId for the same write. Definitive server answers
 * (including VERSION_CONFLICT) are not uncertain and are not kept.
 * The worker remembers only the last 50 opIds per field; beyond
 * that, a retry is treated as a new write and may conflict.
 */

let opCounter = 0;

function generateOpId() {
  opCounter += 1;
  const cryptoLike = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoLike && typeof cryptoLike.randomUUID === "function") return cryptoLike.randomUUID();
  return "op-" + Date.now().toString(36) + "-" + opCounter + "-" + Math.random().toString(36).slice(2, 10);
}

function createExtensionClient({ sendMessage } = {}) {
  if (typeof sendMessage !== "function") {
    throw new TypeError("sendMessage(message) function is required");
  }

  async function sendOnce(message) {
    const response = await sendMessage(message);
    if (response === undefined || response === null) {
      throw new Error("Yanıt kayboldu (boş yanıt)");
    }
    return response;
  }

  // Uncertain operations are kept per target+field, never in one
  // global slot: labels and notes for the same person (or entirely
  // different targets) can both be uncertain at once, each with its
  // own opId and exact sent payload, ready for its own retry.
  const pendingOperations = new Map();

  // One shared target-key rule for storing and looking up pending
  // operations: person handles are normalized (case/@ insensitive),
  // post IDs and URLs are case-sensitive identities and are kept
  // byte-for-byte.
  const PERSON_MESSAGE_TYPES = new Set(["tm.person.setLabels", "tm.person.setNote"]);

  function targetKeyFor(type, target) {
    const raw = String(target || "").trim();
    if (PERSON_MESSAGE_TYPES.has(type)) {
      return type + ":" + raw.replace(/^@+/, "").toLowerCase();
    }
    if (type === "tm.labels.setColor") return type + ":" + raw.toLocaleLowerCase("tr-TR");
    return type + ":" + raw;
  }

  function pendingKeyFor(message) {
    if (!message || typeof message.type !== "string") return null;
    if (typeof message.handle === "string") {
      return targetKeyFor(message.type, message.handle);
    }
    if (typeof message.label === "string") {
      return targetKeyFor(message.type, message.label);
    }
    if (message.post && typeof message.post === "object") {
      const postId = message.post.id || message.post.url || "";
      return targetKeyFor(message.type, postId);
    }
    return message.opId ? message.type + ":" + message.opId : null;
  }

  function rememberPending(message, cause) {
    const key = pendingKeyFor(message);
    const operation = {
      key,
      opId: message.opId || null,
      type: message.type,
      message: JSON.parse(JSON.stringify(message)),
    };
    if (key) pendingOperations.set(key, operation);
    const error = new Error(
      "Sonuç belirsiz: yazımın uygulanıp uygulanmadığı doğrulanamadı. " +
        "Aynı işlem kimliğiyle tekrar deneyin (pendingOperation / retryPendingOperation). " +
        "Neden: " +
        (cause && cause.message)
    );
    error.code = "UNCERTAIN_OUTCOME";
    error.opId = operation.opId;
    error.operation = operation;
    error.pendingKey = key;
    error.cause = cause;
    return error;
  }

  function clearPendingFor(message) {
    const key = pendingKeyFor(message);
    if (!key) return;
    const existing = pendingOperations.get(key);
    if (existing && message.opId && existing.opId === message.opId) {
      pendingOperations.delete(key);
    }
  }

  async function send(message) {
    try {
      const response = await sendOnce(message);
      clearPendingFor(message);
      return response;
    } catch (firstError) {
      try {
        // Single automatic idempotent retry with the identical opId.
        const response = await sendOnce(message);
        clearPendingFor(message);
        return response;
      } catch (secondError) {
        if (message && typeof message.opId === "string") {
          throw rememberPending(message, secondError);
        }
        throw secondError;
      }
    }
  }

  function unwrap(response) {
    if (!response || response.ok !== true) {
      const error = new Error(
        response && response.error ? response.error.message : "Uzantı yanıt vermedi"
      );
      error.code = response && response.error ? response.error.code : "NO_RESPONSE";
      error.details = (response && response.error && response.error.details) || {};
      throw error;
    }
    return response.result;
  }

  return {
    async ping() {
      return unwrap(await send({ type: "tm.ping" }));
    },
    async savePost(post, options) {
      const opId = (options && options.opId) || generateOpId();
      return unwrap(await send({ type: "tm.posts.save", opId, post }));
    },
    async listPosts() {
      return (await unwrap(await send({ type: "tm.posts.list" }))).posts;
    },
    async getSnapshot() {
      return (await unwrap(await send({ type: "tm.snapshot.get" }))).snapshot;
    },
    async getPerson(handle) {
      return (await unwrap(await send({ type: "tm.people.get", handle }))).view;
    },
    async listPeople() {
      return (await unwrap(await send({ type: "tm.people.list" }))).people;
    },
    async listLabelStyles() {
      return (await unwrap(await send({ type: "tm.labels.listStyles" }))).styles;
    },
    async getLabelStyle(label) {
      return (await unwrap(await send({ type: "tm.labels.getStyle", label }))).style;
    },
    async setLabelColor(label, color, baseVersion, options) {
      const opId = (options && options.opId) || generateOpId();
      return unwrap(await send({ type: "tm.labels.setColor", label, color, opId, baseVersion }));
    },
    async setLabels(handle, labels, baseVersion, options) {
      const opId = (options && options.opId) || generateOpId();
      return unwrap(await send({ type: "tm.person.setLabels", opId, handle, labels, baseVersion }));
    },
    async setNote(handle, note, baseVersion, options) {
      const opId = (options && options.opId) || generateOpId();
      return unwrap(await send({ type: "tm.person.setNote", opId, handle, note, baseVersion }));
    },
    async removePost(post, baseVersion, options) {
      const opId = (options && options.opId) || generateOpId();
      return unwrap(await send({ type: "tm.posts.remove", opId, post, baseVersion }));
    },
    async restorePost(post, baseVersion, options) {
      const opId = (options && options.opId) || generateOpId();
      return unwrap(await send({ type: "tm.posts.restore", opId, post, baseVersion }));
    },
    async listRemovedPosts() {
      return (await unwrap(await send({ type: "tm.posts.listRemoved" }))).posts;
    },
    async getPostState(post) {
      return (await unwrap(await send({ type: "tm.posts.getState", post }))).state;
    },
    async setPostReason(post, reason, baseVersion, options) {
      const opId = (options && options.opId) || generateOpId();
      return unwrap(await send({ type: "tm.posts.setReason", opId, post, reason, baseVersion }));
    },
    /** options: { opId?, followUp?: { mode, durationDays } }.
     * Omitting followUp preserves any existing local preference. */
    async setWatchDraft(post, draft, baseVersion, options) {
      const opId = (options && options.opId) || generateOpId();
      const message = { type: "tm.watch.setDraft", opId, post, draft, baseVersion };
      const followUp = options && options.followUp;
      if (followUp !== undefined && options) {
        // Snapshot the new preference so a caller edit cannot change
        // the payload between the first send and an uncertain retry.
        message.followUp = followUp && typeof followUp === "object"
          ? (Array.isArray(followUp) ? [...followUp] : { ...followUp })
          : followUp;
      }
      return unwrap(await send(message));
    },
    async removeWatch(post, baseVersion, options) {
      const opId = (options && options.opId) || generateOpId();
      return unwrap(await send({ type: "tm.watch.remove", opId, post, baseVersion }));
    },
    async listWatches() {
      return (await unwrap(await send({ type: "tm.watch.list" }))).watches;
    },
    async getWatch(post) {
      return (await unwrap(await send({ type: "tm.watch.get", post }))).state;
    },
    async researchSetupStatus() {
      return unwrap(await sendOnce({ type: "tm.research.setupStatus" }));
    },
    async saveSessionKey(apiKey) {
      return unwrap(await sendOnce({ type: "tm.settings.saveKey", apiKey }));
    },
    async clearSessionKey() {
      return unwrap(await sendOnce({ type: "tm.settings.clearKey" }));
    },
    async settingsStatus() {
      return unwrap(await sendOnce({ type: "tm.settings.status" }));
    },
    /**
     * One-shot research. Deliberately NO automatic retry and no
     * pending-operation storage: a lost response is reported as
     * an explicit uncertain outcome, never a second paid call.
     */
    async researchOnce({ eventText, startDate, sourceUrl, opId } = {}) {
      const operationId = opId || generateOpId();
      let response;
      try {
        response = await sendOnce({
          type: "tm.research.once",
          opId: operationId,
          eventText,
          startDate,
          sourceUrl: sourceUrl || null,
        });
      } catch (cause) {
        const error = new Error(
          "Araştırma sonucu belirsiz: yanıt alınamadı. Otomatik tekrar yapılmadı ve bu oturumda yeni ücretli çağrı önerilmez."
        );
        error.code = "UNCERTAIN_OUTCOME";
        error.opId = operationId;
        error.cause = cause;
        throw error;
      }
      return unwrap(response);
    },
    /**
     * All writes whose outcome is uncertain (both responses lost),
     * keyed per target+field. Each message can be resent verbatim;
     * its opId is stable, so the worker can deduplicate it.
     */
    getPendingOperations() {
      return [...pendingOperations.values()].map((operation) => ({
        ...operation,
        message: JSON.parse(JSON.stringify(operation.message)),
      }));
    },
    /** One pending operation by type + target (handle or post id), or null. */
    getPendingOperationFor(type, target) {
      const key = targetKeyFor(type, target);
      const operation = pendingOperations.get(key);
      return operation
        ? { ...operation, message: JSON.parse(JSON.stringify(operation.message)) }
        : null;
    },
    /** Backward compatible: the most recent pending operation, or null. */
    getPendingOperation() {
      const all = [...pendingOperations.values()];
      if (!all.length) return null;
      const operation = all[all.length - 1];
      return { ...operation, message: JSON.parse(JSON.stringify(operation.message)) };
    },
    /**
     * Retries one pending operation with its original opId/message.
     * Accepts a pending key (preferred), or nothing to retry the
     * most recent one. Only that operation's own record is cleared
     * on completion; other pending operations are untouched.
     */
    async retryPendingOperation(key) {
      const operation = key
        ? pendingOperations.get(key)
        : [...pendingOperations.values()].at(-1);
      if (!operation) return null;
      const result = unwrap(await send(operation.message));
      const current = pendingOperations.get(operation.key);
      if (current && current.opId === operation.opId) {
        pendingOperations.delete(operation.key);
      }
      return result;
    },
    clearPendingOperation(key) {
      if (key) pendingOperations.delete(key);
      else pendingOperations.clear();
    },
    /**
     * Retries an EXACT preserved operation (same type, opId,
     * payload and baseVersion) — used when the pending record was
     * kept outside this client instance (e.g. a reopened panel).
     * Never mints a new opId and never changes the message.
     */
    async retryExactOperation(operation) {
      if (!operation || !operation.message) {
        throw new TypeError("operation.message gerekli");
      }
      if (operation.key && pendingOperations.has(operation.key)) {
        return this.retryPendingOperation(operation.key);
      }
      const result = unwrap(await send(operation.message));
      return result;
    },
    _pendingKeyFor: pendingKeyFor,
    _targetKeyFor: targetKeyFor,
    // Exposed so a caller retrying after a lost response can reuse
    // the exact same message/opId instead of minting a new one.
    _send: send,
    _generateOpId: generateOpId,
  };
}

/**
 * Draft-preservation rule for change notifications: an external
 * update refreshes an open view, but never overwrites an unsaved
 * draft. Pure and unit-tested; views apply the returned value.
 */
function resolveExternalDraftUpdate({ draft, dirty, incomingValue }) {
  const hasExternalChange = incomingValue !== draft;
  if (dirty) {
    return { value: draft, applied: false, externalChangePending: hasExternalChange };
  }
  return { value: incomingValue, applied: true, externalChangePending: false };
}

/** Registers a chrome.storage.onChanged listener for our keys, if available. */
function onStorageChanged(chromeLike, prefix, callback) {
  const events = chromeLike && chromeLike.storage && chromeLike.storage.onChanged;
  if (!events || typeof events.addListener !== "function") return () => {};
  const listener = (changes, areaName) => {
    if (areaName !== "local") return;
    const relevant = {};
    for (const [key, change] of Object.entries(changes || {})) {
      if (key.startsWith(prefix)) relevant[key] = change;
    }
    if (Object.keys(relevant).length) callback(relevant);
  };
  events.addListener(listener);
  return () => events.removeListener && events.removeListener(listener);
}

const ThreadsMemoryClientApi = {
  createExtensionClient,
  generateOpId,
  resolveExternalDraftUpdate,
  onStorageChanged,
};

if (typeof module !== "undefined" && module.exports) module.exports = ThreadsMemoryClientApi;
if (typeof window !== "undefined") window.ThreadsMemoryClient = ThreadsMemoryClientApi;
if (typeof self !== "undefined") self.ThreadsMemoryClient = ThreadsMemoryClientApi;
