"use strict";

/*
 * Field-level persistent store (stage 2).
 *
 * One storage key per entity/field, e.g.
 *   tm.v2.post.<postKey> / tm.v2.person.<personKey>
 *   tm.v2.labels.<personKey> / tm.v2.notes.<personKey>
 * so a note write never rewrites labels and vice versa.
 *
 * Every operation is serialized through one queue and does a fresh
 * read -> modify -> write of only the affected keys. In-memory state
 * is never pre-committed: callers see success only after the storage
 * write resolves, and a failed write leaves nothing behind.
 * Label/note records carry { value, version, lastOpId }:
 *  - a retry with the same opId after a lost response succeeds
 *    idempotently without overwriting a newer value;
 *  - a write based on a stale version fails with VERSION_CONFLICT.
 *
 * Runs in Node (tests), in a service worker (no window), and in a
 * page. The storage area is chrome.storage.local-shaped:
 * get(keysOrNull) / set(object) returning promises.
 */

const FieldModel =
  typeof module !== "undefined" && module.exports
    ? require("./model.js")
    : self.ThreadsMemoryModel;

const STORAGE_PREFIX = "tm.v2.";
const KEYS = {
  post: (postKey) => STORAGE_PREFIX + "post." + postKey,
  postState: (postKey) => STORAGE_PREFIX + "postState." + postKey,
  postReason: (postKey) => STORAGE_PREFIX + "postReason." + postKey,
  watch: (postKey) => STORAGE_PREFIX + "watch." + postKey,
  person: (personKey) => STORAGE_PREFIX + "person." + personKey,
  labels: (personKey) => STORAGE_PREFIX + "labels." + personKey,
  labelStyle: (labelKey) => STORAGE_PREFIX + "labelStyle." + labelKey,
  notes: (personKey) => STORAGE_PREFIX + "notes." + personKey,
};

class StoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.details = details || {};
  }
}

function validationError(error) {
  return new StoreError("VALIDATION_ERROR", error.message);
}

function normalizeHandleOrThrow(handle) {
  try {
    return FieldModel.normalizeHandle(handle);
  } catch (error) {
    throw validationError(error);
  }
}

const MAX_OP_LOG = 50;

function defaultFieldRecord() {
  return { value: null, version: 0, lastOpId: null, opLog: [], updatedAt: null };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** In-memory chrome.storage.local-shaped area, for tests/demos. */
function createMemoryStorageArea(options) {
  const opts = options || {};
  const data = new Map();
  let failNextSetWith = null;
  let setDelayMs = typeof opts.setDelayMs === "number" ? opts.setDelayMs : 0;
  const wait = () =>
    setDelayMs > 0 ? new Promise((r) => setTimeout(r, setDelayMs)) : Promise.resolve();
  return {
    _data: data,
    failNextSet(error) {
      failNextSetWith = error || new Error("injected storage failure");
    },
    setDelay(ms) {
      setDelayMs = ms;
    },
    async get(keys) {
      if (keys === null || keys === undefined) {
        return Object.fromEntries([...data.entries()].map(([k, v]) => [k, clone(v)]));
      }
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) if (data.has(key)) out[key] = clone(data.get(key));
      return out;
    },
    async set(items) {
      await wait();
      if (failNextSetWith) {
        const error = failNextSetWith;
        failNextSetWith = null;
        throw error;
      }
      for (const [key, value] of Object.entries(items)) data.set(key, clone(value));
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) data.delete(key);
    },
  };
}

/** Adapts real chrome.storage.local. Only used inside the extension. */
function createChromeStorageArea(chromeLike) {
  const area = chromeLike && chromeLike.storage && chromeLike.storage.local;
  if (!area) throw new Error("chrome.storage.local is not available");
  return {
    get: (keys) => area.get(keys),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
  };
}

function createFieldStore({ storage, now } = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new TypeError("a storage area with get()/set() is required");
  }
  const clock = typeof now === "function" ? now : () => new Date().toISOString();

  // Serial read-modify-write queue. A rejected operation must not jam
  // the queue, so the tail swallows errors after returning them.
  let tail = Promise.resolve();
  function enqueue(task) {
    const run = tail.then(() => task());
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function storageGet(keys) {
    try {
      return (await storage.get(keys)) || {};
    } catch (error) {
      throw new StoreError("STORAGE_ERROR", "Depolama okunamadı: " + error.message);
    }
  }

  async function storageSet(items) {
    try {
      await storage.set(items);
    } catch (error) {
      // Nothing was committed anywhere; report a real failure.
      throw new StoreError("STORAGE_ERROR", "Depolama yazılamadı: " + error.message);
    }
  }

  async function readField(kind, personKey) {
    const key = KEYS[kind](personKey);
    const result = await storageGet(key);
    const record = result[key];
    if (!record || typeof record !== "object") {
      const empty = defaultFieldRecord();
      empty.value = kind === "labels" ? [] : "";
      return empty;
    }
    const opLog = Array.isArray(record.opLog)
      ? record.opLog.filter((e) => e && typeof e.opId === "string")
      : record.lastOpId
        ? [{ opId: record.lastOpId, version: record.version }]
        : [];
    return {
      value: record.value,
      version: Number.isInteger(record.version) ? record.version : 0,
      lastOpId: record.lastOpId || null,
      opLog,
      updatedAt: record.updatedAt || null,
    };
  }

  async function readPerson(personKey) {
    const key = KEYS.person(personKey);
    const result = await storageGet(key);
    return result[key] || null;
  }

  function personRecord(handle, displayName, existing) {
    const at = clock();
    if (existing) {
      const next = { ...existing };
      if (displayName && displayName.trim() && displayName.trim() !== next.displayName) {
        next.displayName = displayName.trim();
        next.updatedAt = at;
      }
      return next;
    }
    return {
      key: FieldModel.personKeyFor(handle),
      handle,
      displayName: displayName && displayName.trim() ? displayName.trim() : "@" + handle,
      createdAt: at,
      updatedAt: at,
    };
  }

  async function writeField(kind, { handle, opId, baseVersion, value }) {
    const normalized = normalizeHandleOrThrow(handle);
    const personKey = FieldModel.personKeyFor(normalized);
    const current = await readField(kind, personKey);

    // Lost-response retry: this exact operation already landed
    // (checked against the bounded op history, not only the latest
    // op, so an intervening newer write does not hide it). Succeed
    // without touching a possibly newer value.
    if (opId && current.opLog.some((entry) => entry.opId === opId)) {
      return {
        ok: true,
        deduplicated: true,
        personKey,
        value: clone(current.value),
        version: current.version,
      };
    }
    if (baseVersion !== current.version) {
      throw new StoreError(
        "VERSION_CONFLICT",
        "Çatışma: bu " +
          (kind === "notes" ? "not" : "etiket") +
          " siz düzenlerken başka bir görünümde güncellendi (mevcut sürüm " +
          current.version +
          ", sizin dayandığınız sürüm " +
          baseVersion +
          "). Güncel değeri yükleyip tekrar deneyin; değişiklik sessizce ezilmedi.",
        {
          field: kind,
          personKey,
          baseVersion,
          currentVersion: current.version,
          currentValue: clone(current.value),
        }
      );
    }

    const changes = {};
    const existingPerson = await readPerson(personKey);
    if (!existingPerson) {
      changes[KEYS.person(personKey)] = personRecord(normalized, undefined, null);
    }
    const record = {
      value: clone(value),
      version: current.version + 1,
      lastOpId: opId || null,
      opLog: opId
        ? [...current.opLog, { opId, version: current.version + 1 }].slice(-MAX_OP_LOG)
        : current.opLog,
      updatedAt: clock(),
    };
    changes[KEYS[kind](personKey)] = record;
    await storageSet(changes);
    return { ok: true, deduplicated: false, personKey, value: clone(value), version: record.version };
  }

  async function readKeyedRecord(key, initialValue) {
    const result = await storageGet(key);
    const record = result[key];
    if (!record || typeof record !== "object") {
      return { value: clone(initialValue), version: 0, lastOpId: null, opLog: [], updatedAt: null };
    }
    return {
      value: record.value,
      version: Number.isInteger(record.version) ? record.version : 0,
      lastOpId: record.lastOpId || null,
      opLog: Array.isArray(record.opLog) ? record.opLog : [],
      updatedAt: record.updatedAt || null,
    };
  }

  async function writeKeyedRecord({ key, fieldLabel, initialValue, opId, baseVersion, value }) {
    const current = await readKeyedRecord(key, initialValue);
    if (opId && current.opLog.some((entry) => entry.opId === opId)) {
      return { ok: true, deduplicated: true, value: clone(current.value), version: current.version };
    }
    if (baseVersion !== current.version) {
      throw new StoreError(
        "VERSION_CONFLICT",
        "Çatışma: bu " + fieldLabel + " siz düzenlerken başka bir görünümde güncellendi (mevcut sürüm " +
          current.version + ", sizin dayandığınız sürüm " + baseVersion +
          "). Güncel değeri yükleyip tekrar deneyin; değişiklik sessizce ezilmedi.",
        { field: fieldLabel, baseVersion, currentVersion: current.version, currentValue: clone(current.value) }
      );
    }
    const record = {
      value: clone(value),
      version: current.version + 1,
      lastOpId: opId || null,
      opLog: opId ? [...current.opLog, { opId, version: current.version + 1 }].slice(-MAX_OP_LOG) : current.opLog,
      updatedAt: clock(),
    };
    await storageSet({ [key]: record });
    return { ok: true, deduplicated: false, value: clone(value), version: record.version };
  }

  function postIdentityOrThrow(post) {
    if (!post || typeof post !== "object") throw new StoreError("VALIDATION_ERROR", "post gerekli");
    let url;
    let authorHandle;
    try {
      url = FieldModel.normalizePostUrl(post.url);
      authorHandle = FieldModel.normalizeHandle(post.authorHandle);
    } catch (error) {
      throw validationError(error);
    }
    const id = post.id === undefined || post.id === null ? "" : String(post.id).trim();
    return { id, url, authorHandle };
  }

  async function findSavedPost(post) {
    const identity = postIdentityOrThrow(post);
    const all = await storageGet(null);
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(STORAGE_PREFIX + "post.")) continue;
      if ((identity.id && value.id === identity.id) || value.url === identity.url) return value;
    }
    return null;
  }

  const store = {
    savePost({ post, opId } = {}) {
      return enqueue(async () => {
        let candidate;
        try {
          candidate = FieldModel.validatePostInput(post);
        } catch (error) {
          throw validationError(error);
        }
        const all = await storageGet(null);
        const posts = {};
        for (const [key, value] of Object.entries(all)) {
          if (key.startsWith(STORAGE_PREFIX + "post.")) posts[key.slice((STORAGE_PREFIX + "post.").length)] = value;
        }
        const duplicate = FieldModel.findDuplicatePost({ posts }, candidate);
        if (duplicate) {
          const sameOperation = Boolean(opId) && duplicate.savedByOpId === opId;
          const stateRecord = await readKeyedRecord(KEYS.postState(duplicate.key), { status: "active" });
          const isRemoved = stateRecord.value && stateRecord.value.status === "removed";
          if (!isRemoved) {
            return {
              ok: true,
              saved: false,
              deduplicated: sameOperation,
              reason: "duplicate",
              post: duplicate,
            };
          }
          // A save NEVER auto-reactivates a tombstone — no matter
          // whether the opId is the original save's, an older
          // non-original one, or a brand-new one. The only way
          // back is the explicit, versioned restore (Geri al).
          return {
            ok: true,
            saved: false,
            deduplicated: sameOperation,
            reason: "duplicate-removed",
            post: duplicate,
          };
        }
        const postKey = FieldModel.postKeyFor(candidate);
        const personKey = FieldModel.personKeyFor(candidate.authorHandle);
        const record = {
          key: postKey,
          ...candidate,
          authorPersonKey: personKey,
          savedAt: clock(),
          savedByOpId: opId || null,
        };
        const changes = { [KEYS.post(postKey)]: record };
        changes[KEYS.postState(postKey)] = {
          value: { status: "active" },
          version: 1,
          lastOpId: opId || null,
          opLog: opId ? [{ opId, version: 1 }] : [],
          updatedAt: clock(),
        };
        const existingPerson = all[KEYS.person(personKey)] || null;
        const nextPerson = personRecord(candidate.authorHandle, candidate.authorDisplayName, existingPerson);
        if (JSON.stringify(nextPerson) !== JSON.stringify(existingPerson)) {
          changes[KEYS.person(personKey)] = nextPerson;
        }
        await storageSet(changes);
        return { ok: true, saved: true, deduplicated: false, post: record };
      });
    },

    setLabels(input) {
      return enqueue(() => {
        let value;
        try {
          value = FieldModel.normalizeLabels(input && input.labels);
        } catch (error) {
          throw validationError(error);
        }
        return writeField("labels", { ...input, value });
      });
    },

    setNote(input) {
      return enqueue(() => {
        if (!input || typeof input.note !== "string") {
          throw new StoreError("VALIDATION_ERROR", "note must be a string");
        }
        return writeField("notes", { ...input, value: input.note });
      });
    },

    /**
     * Recoverable removal: a versioned tombstone over the post's
     * memory state only. The post record, its reason, the
     * person's labels/notes and any watch draft are preserved.
     */
    removePost({ post, opId, baseVersion } = {}) {
      return enqueue(async () => {
        const saved = await findSavedPost(post);
        if (!saved) throw new StoreError("POST_NOT_FOUND", "Kaldırılacak kayıtlı gönderi bulunamadı.");
        const result = await writeKeyedRecord({
          key: KEYS.postState(saved.key),
          fieldLabel: "hafıza durumu",
          initialValue: { status: "active" },
          opId,
          baseVersion,
          value: { status: "removed" },
        });
        return { ...result, removed: result.value.status === "removed", postKey: saved.key, post: saved };
      });
    },

    /** Explicit user undo of a removal (never automatic). */
    restorePost({ post, opId, baseVersion } = {}) {
      return enqueue(async () => {
        const saved = await findSavedPost(post);
        if (!saved) throw new StoreError("POST_NOT_FOUND", "Geri alınacak gönderi bulunamadı.");
        const result = await writeKeyedRecord({
          key: KEYS.postState(saved.key),
          fieldLabel: "hafıza durumu",
          initialValue: { status: "active" },
          opId,
          baseVersion,
          value: { status: "active" },
        });
        return {
          ...result,
          removed: Boolean(result.value && result.value.status === "removed"),
          postKey: saved.key,
          post: saved,
        };
      });
    },

    /**
     * Single-identity current state read: post, memory status,
     * state version and reason from one storage snapshot (views
     * must not race an active list against a removed list).
     */
    async getPostState(post) {
      const identity = postIdentityOrThrow(post);
      const all = await storageGet(null);
      let saved = null;
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(STORAGE_PREFIX + "post.")) continue;
        if ((identity.id && value.id === identity.id) || value.url === identity.url) {
          saved = value;
          break;
        }
      }
      if (!saved) return { postKey: null, status: "none", version: 0, post: null, reason: "", reasonVersion: 0 };
      const stateRecord = all[KEYS.postState(saved.key)];
      const reasonRecord = all[KEYS.postReason(saved.key)];
      return {
        postKey: saved.key,
        status: stateRecord && stateRecord.value.status ? stateRecord.value.status : "active",
        version: stateRecord ? stateRecord.version : 0,
        post: saved,
        reason: reasonRecord ? reasonRecord.value : "",
        reasonVersion: reasonRecord ? reasonRecord.version : 0,
      };
    },

    /** Optional "why I saved this" note, attached to a saved post. */
    setPostReason({ post, reason, opId, baseVersion } = {}) {
      return enqueue(async () => {
        if (typeof reason !== "string") {
          throw new StoreError("VALIDATION_ERROR", "reason must be a string");
        }
        const saved = await findSavedPost(post);
        if (!saved) throw new StoreError("POST_NOT_FOUND", "Kayıt gerekçesi yalnız kayıtlı gönderiye eklenebilir.");
        const result = await writeKeyedRecord({
          key: KEYS.postReason(saved.key),
          fieldLabel: "kayıt gerekçesi",
          initialValue: "",
          opId,
          baseVersion,
          value: reason,
        });
        return { ...result, postKey: saved.key };
      });
    },

    async getPostReason(post) {
      const saved = await findSavedPost(post);
      if (!saved) return { postKey: null, value: "", version: 0 };
      const record = await readKeyedRecord(KEYS.postReason(saved.key), "");
      return { postKey: saved.key, value: record.value, version: record.version };
    },

    /** Local watch draft only: pending-connection, never researched. */
    setWatchDraft({ post, draft, opId, baseVersion, followUp } = {}) {
      return enqueue(async () => {
        if (typeof draft !== "string") {
          throw new StoreError("VALIDATION_ERROR", "draft must be a string");
        }
        let preferences;
        try {
          preferences = FieldModel.normalizeFollowUp(followUp);
        } catch (error) {
          throw validationError(error);
        }
        const identity = postIdentityOrThrow(post);
        const postKey = FieldModel.postKeyFor(identity);
        const existing = await readKeyedRecord(KEYS.watch(postKey), null);
        // Older callers only edit the draft. Omission must retain a
        // preference already saved, including after a tombstone.
        if (preferences === undefined && existing.value) {
          preferences = clone(existing.value.followUp);
        }
        const createdAt =
          existing.value && existing.value.createdAt ? existing.value.createdAt : clock();
        const value = {
          postKey,
          postId: identity.id,
          url: identity.url,
          authorHandle: identity.authorHandle,
          authorDisplayName:
            typeof post.authorDisplayName === "string" && post.authorDisplayName.trim()
              ? post.authorDisplayName.trim()
              : "@" + identity.authorHandle,
          draft,
          status: "pending-connection",
          createdAt,
        };
        if (preferences !== undefined) value.followUp = preferences;
        const result = await writeKeyedRecord({
          key: KEYS.watch(postKey),
          fieldLabel: "takip taslağı",
          initialValue: null,
          opId,
          baseVersion,
          value,
        });
        return { ...result, postKey, watch: result.value };
      });
    },

    /**
     * Versioned tombstone delete. The record is never physically
     * removed: it becomes { status: "removed", draft: "" } at the
     * next version, keeping the op history alive. A lost-response
     * delete retry is recognised by opId and cannot delete a watch
     * another view recreated meanwhile; an old create retry cannot
     * resurrect the tombstone (its opId is still in the history,
     * and a fresh write needs the tombstone's current version).
     */
    removeWatch({ post, opId, baseVersion } = {}) {
      return enqueue(async () => {
        const identity = postIdentityOrThrow(post);
        const postKey = FieldModel.postKeyFor(identity);
        const key = KEYS.watch(postKey);
        const current = await readKeyedRecord(key, null);
        if (opId && current.opLog.some((entry) => entry.opId === opId)) {
          const stillRemoved = Boolean(current.value && current.value.status === "removed");
          return {
            ok: true,
            removed: stillRemoved,
            deduplicated: true,
            postKey,
            value: clone(current.value),
            version: current.version,
          };
        }
        const tombstone = {
          ...(current.value || {}),
          postKey,
          postId: identity.id,
          url: identity.url,
          authorHandle: identity.authorHandle,
          authorDisplayName:
            current.value && current.value.authorDisplayName
              ? current.value.authorDisplayName
              : "@" + identity.authorHandle,
          draft: "",
          status: "removed",
          createdAt: current.value && current.value.createdAt ? current.value.createdAt : clock(),
        };
        const result = await writeKeyedRecord({
          key,
          fieldLabel: "takip taslağı (silme)",
          initialValue: null,
          opId,
          baseVersion,
          value: tombstone,
        });
        return { ...result, removed: !result.deduplicated, postKey };
      });
    },

    /**
     * Current watch state for one verified post identity, including
     * a removed tombstone's version — without listing tombstones
     * in the follow center. Reopening after a delete uses this
     * version as the base for a fresh draft.
     */
    async getWatchState(post) {
      const identity = postIdentityOrThrow(post);
      const postKey = FieldModel.postKeyFor(identity);
      const record = await readKeyedRecord(KEYS.watch(postKey), null);
      if (!record || record.version === 0 && !record.value) {
        return { postKey, status: "none", version: 0, watch: null };
      }
      if (record.value && record.value.status === "removed") {
        return { postKey, status: "removed", version: record.version, watch: null };
      }
      return {
        postKey,
        status: record.value ? record.value.status : "none",
        version: record.version,
        watch: record.value ? { ...record.value, version: record.version } : null,
      };
    },

    async listWatches() {
      const all = await storageGet(null);
      return Object.entries(all)
        .filter(([key]) => key.startsWith(STORAGE_PREFIX + "watch."))
        .map(([, record]) => ({ ...record.value, version: record.version }))
        .filter((watch) => watch.status !== "removed")
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },

    /** One global style per normalized label; person string[] stays untouched. */
    setLabelColor({ label, color, opId, baseVersion } = {}) {
      return enqueue(async () => {
        let labelKey;
        let value;
        try {
          labelKey = FieldModel.normalizeLabelKey(label);
          value = FieldModel.normalizeLabelColor(color);
        } catch (error) {
          throw validationError(error);
        }
        const result = await writeKeyedRecord({
          key: KEYS.labelStyle(labelKey), fieldLabel: "etiket rengi", initialValue: null,
          opId, baseVersion, value,
        });
        return { ...result, labelKey, color: result.value };
      });
    },

    async getLabelStyle(label) {
      let labelKey;
      try { labelKey = FieldModel.normalizeLabelKey(label); } catch (error) { throw validationError(error); }
      const record = await readKeyedRecord(KEYS.labelStyle(labelKey), null);
      return {
        labelKey,
        color: record.value === null ? null : FieldModel.normalizeLabelColor(record.value),
        version: record.version,
      };
    },

    async listLabelStyles() {
      const all = await storageGet(null);
      const styles = [];
      for (const [key, record] of Object.entries(all)) {
        if (!key.startsWith(STORAGE_PREFIX + "labelStyle.")) continue;
        try {
          const rawKey = key.slice((STORAGE_PREFIX + "labelStyle.").length);
          const labelKey = FieldModel.normalizeLabelKey(rawKey);
          if (rawKey !== labelKey) continue;
          styles.push({
            labelKey,
            color: FieldModel.normalizeLabelColor(record.value),
            version: Number.isInteger(record.version) ? record.version : 0,
          });
        } catch { /* Invalid stored styles never become CSS. */ }
      }
      return styles.sort((a, b) => a.labelKey.localeCompare(b.labelKey, "tr"));
    },

    /** Read-only people list for views; never writes or migrates. */
    async listPeople() {
      const snapshot = await store.getSnapshot();
      return Object.values(snapshot.people)
        .map((person) => ({
          ...person,
          labels: [...(snapshot.labels[person.key] || [])],
          note: snapshot.notes[person.key] || "",
          versions: {
            labels: snapshot.versions.labels[person.key] || 0,
            notes: snapshot.versions.notes[person.key] || 0,
          },
        }))
        .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), "tr"));
    },

    async getPersonView(handle) {
      const normalized = normalizeHandleOrThrow(handle);
      const personKey = FieldModel.personKeyFor(normalized);
      const [person, labels, notes] = await Promise.all([
        readPerson(personKey),
        readField("labels", personKey),
        readField("notes", personKey),
      ]);
      return {
        person,
        labels: clone(labels.value),
        note: notes.value,
        versions: { labels: labels.version, notes: notes.version },
      };
    },

    async listPosts() {
      const all = await storageGet(null);
      return Object.entries(all)
        .filter(([key]) => key.startsWith(STORAGE_PREFIX + "post."))
        .map(([, value]) => {
          // Backward compatible: older saved posts have no reason
          // or state record yet and read as active, reason "".
          const reasonRecord = all[KEYS.postReason(value.key)];
          const stateRecord = all[KEYS.postState(value.key)];
          return {
            ...value,
            reason: reasonRecord ? reasonRecord.value : "",
            reasonVersion: reasonRecord ? reasonRecord.version : 0,
            memoryStatus: stateRecord ? stateRecord.value.status : "active",
            stateVersion: stateRecord ? stateRecord.version : 0,
          };
        })
        .filter((post) => post.memoryStatus !== "removed")
        .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    },

    /** Removed posts, kept recoverable (never hard-deleted). */
    async listRemovedPosts() {
      const all = await storageGet(null);
      return Object.entries(all)
        .filter(([key]) => key.startsWith(STORAGE_PREFIX + "post."))
        .map(([, value]) => {
          const reasonRecord = all[KEYS.postReason(value.key)];
          const stateRecord = all[KEYS.postState(value.key)];
          return {
            ...value,
            reason: reasonRecord ? reasonRecord.value : "",
            reasonVersion: reasonRecord ? reasonRecord.version : 0,
            memoryStatus: stateRecord ? stateRecord.value.status : "active",
            stateVersion: stateRecord ? stateRecord.version : 0,
          };
        })
        .filter((post) => post.memoryStatus === "removed")
        .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    },

    /** Fresh read from persistent storage (used after worker restart). */
    async getSnapshot() {
      const all = await storageGet(null);
      const snapshot = {
        posts: {},
        postStates: {},
        postReasons: {},
        watches: {},
        people: {},
        labels: {},
        notes: {},
        versions: { labels: {}, notes: {}, postReasons: {} },
      };
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(STORAGE_PREFIX)) continue;
        const rest = key.slice(STORAGE_PREFIX.length);
        if (rest.startsWith("postState.")) {
          snapshot.postStates[rest.slice("postState.".length)] = {
            status: value.value.status,
            version: value.version,
          };
        } else if (rest.startsWith("postReason.")) {
          const postKey = rest.slice("postReason.".length);
          snapshot.postReasons[postKey] = value.value;
          snapshot.versions.postReasons[postKey] = value.version;
        } else if (rest.startsWith("watch.")) {
          if (value.value && value.value.status !== "removed") {
            snapshot.watches[rest.slice("watch.".length)] = { ...value.value, version: value.version };
          }
        } else if (rest.startsWith("post.")) snapshot.posts[rest.slice(5)] = value;
        else if (rest.startsWith("person.")) snapshot.people[rest.slice(7)] = value;
        else if (rest.startsWith("labels.")) {
          const personKey = rest.slice(7);
          snapshot.labels[personKey] = value.value;
          snapshot.versions.labels[personKey] = value.version;
        } else if (rest.startsWith("notes.")) {
          const personKey = rest.slice(6);
          snapshot.notes[personKey] = value.value;
          snapshot.versions.notes[personKey] = value.version;
        }
      }
      return snapshot;
    },
  };
  return store;
}

const ThreadsMemoryFieldStoreApi = {
  STORAGE_PREFIX,
  KEYS,
  StoreError,
  createFieldStore,
  createMemoryStorageArea,
  createChromeStorageArea,
};

if (typeof module !== "undefined" && module.exports) module.exports = ThreadsMemoryFieldStoreApi;
if (typeof window !== "undefined") window.ThreadsMemoryFieldStore = ThreadsMemoryFieldStoreApi;
if (typeof self !== "undefined") self.ThreadsMemoryFieldStore = ThreadsMemoryFieldStoreApi;
