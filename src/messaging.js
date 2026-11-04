"use strict";

/*
 * Validated runtime-message boundary between views (content script,
 * popup) and the service worker that owns storage.
 *
 * Rules:
 *  - sender identity must match this extension (sender.id);
 *  - message must be a plain object with a whitelisted `type`;
 *  - only whitelisted fields per type, with type/length checks;
 *  - writes carry a client-generated opId (idempotent retry) and,
 *    for label/note fields, the baseVersion the editor started from;
 *  - success is returned only after the persistent write resolves.
 * Views never send a whole state copy; each message is one limited
 * field/entity operation.
 */

const MessagingModel =
  typeof module !== "undefined" && module.exports
    ? require("./model.js")
    : self.ThreadsMemoryModel;

const MESSAGE_TYPES = {
  PING: "tm.ping",
  POSTS_SAVE: "tm.posts.save",
  POSTS_LIST: "tm.posts.list",
  POSTS_SET_REASON: "tm.posts.setReason",
  POSTS_REMOVE: "tm.posts.remove",
  POSTS_RESTORE: "tm.posts.restore",
  POSTS_LIST_REMOVED: "tm.posts.listRemoved",
  POSTS_GET_STATE: "tm.posts.getState",
  WATCH_SET_DRAFT: "tm.watch.setDraft",
  WATCH_GET: "tm.watch.get",
  WATCH_REMOVE: "tm.watch.remove",
  WATCH_LIST: "tm.watch.list",
  PEOPLE_GET: "tm.people.get",
  PEOPLE_LIST: "tm.people.list",
  PERSON_SET_LABELS: "tm.person.setLabels",
  LABEL_STYLES_LIST: "tm.labels.listStyles",
  LABEL_STYLE_GET: "tm.labels.getStyle",
  LABEL_COLOR_SET: "tm.labels.setColor",
  PERSON_SET_NOTE: "tm.person.setNote",
  SNAPSHOT_GET: "tm.snapshot.get",
  RESEARCH_ONCE: "tm.research.once",
  RESEARCH_SETUP_STATUS: "tm.research.setupStatus",
  SETTINGS_SAVE_KEY: "tm.settings.saveKey",
  SETTINGS_CLEAR_KEY: "tm.settings.clearKey",
  SETTINGS_STATUS: "tm.settings.status",
};

const OP_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX = { handle: 100, opId: 128, note: 5000, label: 64, labels: 30, url: 2048, text: 5000, name: 200 };

function fail(code, message, details) {
  return { ok: false, error: { code, message, details: details || {} } };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function checkAllowedKeys(object, allowed) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) return "Beklenmeyen alan: " + key;
  }
  return null;
}

function validateOpId(opId) {
  return typeof opId === "string" && OP_ID_PATTERN.test(opId);
}

function validateBaseVersion(value) {
  return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - 1;
}

function validateHandleField(handle) {
  if (typeof handle !== "string" || handle.length > MAX.handle) return null;
  try {
    return MessagingModel.normalizeHandle(handle);
  } catch {
    return null;
  }
}

const ALLOWED_THREADS_HOSTS = new Set(["www.threads.net", "www.threads.com"]);
// Observed public URL shape: /@HANDLE/post/POSTID (no DOM selector
// is involved; this only checks the supplied source link).
const POST_PATH_PATTERN = /^\/@([^/]+)\/post\/([^/]+)\/?$/;

function validatePost(post) {
  if (!isPlainObject(post)) return "post nesne olmalı";
  const keyError = checkAllowedKeys(post, ["id", "url", "authorHandle", "authorDisplayName", "text"]);
  if (keyError) return keyError;
  if (typeof post.url !== "string" || !post.url || post.url.length > MAX.url) return "post.url geçersiz";
  let parsed;
  try {
    parsed = new URL(post.url);
  } catch {
    return "post.url geçerli bir URL olmalı";
  }
  if (parsed.protocol !== "https:") return "post.url yalnız HTTPS olmalı";
  if (!ALLOWED_THREADS_HOSTS.has(parsed.hostname.toLowerCase()))
    return "post.url izinli bir Threads hostunda olmalı";
  if (parsed.username || parsed.password || parsed.port)
    return "post.url kimlik/port bilgisi içeremez";
  const pathMatch = POST_PATH_PATTERN.exec(parsed.pathname);
  if (!pathMatch) return "post.url /@HANDLE/post/POSTID biçiminde olmalı";
  let pathHandle;
  let pathPostId;
  try {
    pathHandle = decodeURIComponent(pathMatch[1]);
    pathPostId = decodeURIComponent(pathMatch[2]);
  } catch {
    return "post.url yolu geçersiz kodlanmış";
  }
  if (!pathPostId || /[\s/]/.test(pathPostId)) return "post.url gönderi kimliği belirsiz";
  const authorHandle = validateHandleField(post.authorHandle);
  if (!authorHandle) return "post.authorHandle geçersiz";
  let normalizedPathHandle;
  try {
    normalizedPathHandle = MessagingModel.normalizeHandle(pathHandle);
  } catch {
    return "post.url yazar bilgisi geçersiz";
  }
  if (normalizedPathHandle !== authorHandle)
    return "post.authorHandle, kaynak bağlantısındaki yazarla uyuşmuyor";
  if (post.id !== undefined && post.id !== pathPostId)
    return "post.id, kaynak bağlantısındaki gönderi kimliğiyle uyuşmuyor";
  if (typeof post.text !== "string" || !post.text.trim() || post.text.length > MAX.text)
    return "post.text geçersiz";
  if (
    post.authorDisplayName !== undefined &&
    (typeof post.authorDisplayName !== "string" || post.authorDisplayName.length > MAX.name)
  )
    return "post.authorDisplayName geçersiz";
  if (post.id !== undefined && (typeof post.id !== "string" || post.id.length > 200))
    return "post.id geçersiz";
  return null;
}

/** Identity-only validation (no post text needed) for reason/watch ops. */
function validatePostIdentity(post) {
  if (!isPlainObject(post)) return "post nesne olmalı";
  return validatePost({ ...post, text: typeof post.text === "string" && post.text ? post.text : "kimlik" });
}

function validateResearchRequest(message) {
  const keyError = checkAllowedKeys(message, ["type", "opId", "eventText", "startDate", "sourceUrl"]);
  if (keyError) return keyError;
  if (!validateOpId(message.opId)) return "opId geçersiz";
  if (typeof message.eventText !== "string" || !message.eventText.trim() || message.eventText.length > 1000)
    return "eventText geçersiz";
  if (message.startDate !== undefined && message.startDate !== null && message.startDate !== "") {
    if (typeof message.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(message.startDate))
      return "startDate YYYY-MM-DD olmalı";
    const date = new Date(message.startDate + "T00:00:00Z");
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== message.startDate)
      return "startDate geçerli bir tarih olmalı";
  }
  if (message.sourceUrl !== undefined && message.sourceUrl !== null) {
    if (typeof message.sourceUrl !== "string" || message.sourceUrl.length > 2048)
      return "sourceUrl geçersiz";
    try {
      const parsed = new URL(message.sourceUrl);
      if (parsed.protocol !== "https:") return "sourceUrl yalnız https olabilir";
      if (parsed.username || parsed.password) return "sourceUrl kimlik bilgisi içeremez";
    } catch {
      return "sourceUrl geçerli bir URL olmalı";
    }
  }
  return null;
}

const TRUSTED_SETTINGS_PAGES = ["src/sidepanel.html", "src/options.html"];

function isTrustedSettingsSender(sender, runtimeId) {
  if (!sender || sender.id !== runtimeId || typeof sender.url !== "string") return false;
  let parsed;
  try {
    parsed = new URL(sender.url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "chrome-extension:" &&
    parsed.hostname === runtimeId &&
    TRUSTED_SETTINGS_PAGES.some((page) => parsed.pathname === "/" + page)
  );
}

function createMessageHandler({ store, runtimeId, researchService, settings } = {}) {
  if (!store) throw new TypeError("store is required");
  if (typeof runtimeId !== "string" || !runtimeId) throw new TypeError("runtimeId is required");

  function validateSender(sender) {
    if (!isPlainObject(sender)) return "Gönderici bilgisi yok";
    if (sender.id !== runtimeId) return "Gönderici bu uzantıya ait değil";
    if (sender.url !== undefined) {
      if (typeof sender.url !== "string") return "Gönderici URL'si geçersiz";
      if (
        sender.url.startsWith("chrome-extension://") &&
        !sender.url.startsWith("chrome-extension://" + runtimeId + "/")
      ) {
        return "Gönderici URL'si bu uzantıya ait değil";
      }
    }
    if (sender.tab !== undefined) {
      if (!isPlainObject(sender.tab) || !Number.isInteger(sender.tab.id) || sender.tab.id < 0) {
        return "Gönderici sekme bilgisi geçersiz";
      }
    }
    return null;
  }

  async function handleMessage(message, sender) {
    const senderError = validateSender(sender);
    if (senderError) return fail("FORBIDDEN_SENDER", senderError);
    if (!isPlainObject(message) || typeof message.type !== "string") {
      return fail("INVALID_MESSAGE", "Mesaj { type, ... } biçiminde bir nesne olmalı");
    }

    try {
      switch (message.type) {
        case MESSAGE_TYPES.PING: {
          const keyError = checkAllowedKeys(message, ["type"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          return { ok: true, result: { pong: true } };
        }
        case MESSAGE_TYPES.POSTS_LIST: {
          const keyError = checkAllowedKeys(message, ["type"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          return { ok: true, result: { posts: await store.listPosts() } };
        }
        case MESSAGE_TYPES.SNAPSHOT_GET: {
          const keyError = checkAllowedKeys(message, ["type"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          return { ok: true, result: { snapshot: await store.getSnapshot() } };
        }
        case MESSAGE_TYPES.PEOPLE_LIST: {
          const keyError = checkAllowedKeys(message, ["type"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          return { ok: true, result: { people: await store.listPeople() } };
        }
        case MESSAGE_TYPES.PEOPLE_GET: {
          const keyError = checkAllowedKeys(message, ["type", "handle"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          if (!validateHandleField(message.handle)) return fail("INVALID_MESSAGE", "handle geçersiz");
          return { ok: true, result: { view: await store.getPersonView(message.handle) } };
        }
        case MESSAGE_TYPES.POSTS_SAVE: {
          const keyError = checkAllowedKeys(message, ["type", "opId", "post"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          if (!validateOpId(message.opId)) return fail("INVALID_MESSAGE", "opId geçersiz");
          const postError = validatePost(message.post);
          if (postError) return fail("INVALID_MESSAGE", postError);
          const result = await store.savePost({ post: message.post, opId: message.opId });
          return { ok: true, result };
        }
        case MESSAGE_TYPES.LABEL_STYLES_LIST: {
          const keyError = checkAllowedKeys(message, ["type"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          return { ok: true, result: { styles: await store.listLabelStyles() } };
        }
        case MESSAGE_TYPES.LABEL_STYLE_GET: {
          const keyError = checkAllowedKeys(message, ["type", "label"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          try { MessagingModel.normalizeLabelKey(message.label); } catch (error) {
            return fail("INVALID_MESSAGE", error.message);
          }
          return { ok: true, result: { style: await store.getLabelStyle(message.label) } };
        }
        case MESSAGE_TYPES.LABEL_COLOR_SET: {
          const keyError = checkAllowedKeys(message, ["type", "label", "color", "opId", "baseVersion"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          if (!validateOpId(message.opId)) return fail("INVALID_MESSAGE", "opId geçersiz");
          if (!validateBaseVersion(message.baseVersion)) return fail("INVALID_MESSAGE", "baseVersion geçersiz");
          try {
            MessagingModel.normalizeLabelKey(message.label);
            MessagingModel.normalizeLabelColor(message.color);
          } catch (error) {
            return fail("INVALID_MESSAGE", error.message);
          }
          const result = await store.setLabelColor({
            label: message.label, color: message.color, opId: message.opId, baseVersion: message.baseVersion,
          });
          return { ok: true, result };
        }
        case MESSAGE_TYPES.PERSON_SET_LABELS: {
          const keyError = checkAllowedKeys(message, ["type", "opId", "handle", "labels", "baseVersion"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          if (!validateOpId(message.opId)) return fail("INVALID_MESSAGE", "opId geçersiz");
          if (!validateHandleField(message.handle)) return fail("INVALID_MESSAGE", "handle geçersiz");
          if (!validateBaseVersion(message.baseVersion))
            return fail("INVALID_MESSAGE", "baseVersion geçersiz");
          if (
            !Array.isArray(message.labels) ||
            message.labels.length > MAX.labels ||
            message.labels.some((l) => typeof l !== "string" || l.length > MAX.label)
          ) {
            return fail("INVALID_MESSAGE", "labels geçersiz");
          }
          const result = await store.setLabels({
            handle: message.handle,
            labels: message.labels,
            opId: message.opId,
            baseVersion: message.baseVersion,
          });
          return { ok: true, result };
        }
        case MESSAGE_TYPES.PERSON_SET_NOTE: {
          const keyError = checkAllowedKeys(message, ["type", "opId", "handle", "note", "baseVersion"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          if (!validateOpId(message.opId)) return fail("INVALID_MESSAGE", "opId geçersiz");
          if (!validateHandleField(message.handle)) return fail("INVALID_MESSAGE", "handle geçersiz");
          if (!validateBaseVersion(message.baseVersion))
            return fail("INVALID_MESSAGE", "baseVersion geçersiz");
          if (typeof message.note !== "string" || message.note.length > MAX.note)
            return fail("INVALID_MESSAGE", "note geçersiz");
          const result = await store.setNote({
            handle: message.handle,
            note: message.note,
            opId: message.opId,
            baseVersion: message.baseVersion,
          });
          return { ok: true, result };
        }
        case MESSAGE_TYPES.POSTS_REMOVE:
        case MESSAGE_TYPES.POSTS_RESTORE: {
          const keyError = checkAllowedKeys(message, ["type", "opId", "post", "baseVersion"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          if (!validateOpId(message.opId)) return fail("INVALID_MESSAGE", "opId geçersiz");
          if (!validateBaseVersion(message.baseVersion))
            return fail("INVALID_MESSAGE", "baseVersion geçersiz");
          const identityError = validatePostIdentity(message.post);
          if (identityError) return fail("INVALID_MESSAGE", identityError);
          const operation =
            message.type === MESSAGE_TYPES.POSTS_REMOVE ? "removePost" : "restorePost";
          const result = await store[operation]({
            post: message.post,
            opId: message.opId,
            baseVersion: message.baseVersion,
          });
          return { ok: true, result };
        }
        case MESSAGE_TYPES.POSTS_GET_STATE: {
          const keyError = checkAllowedKeys(message, ["type", "post"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          const identityError = validatePostIdentity(message.post);
          if (identityError) return fail("INVALID_MESSAGE", identityError);
          return { ok: true, result: { state: await store.getPostState(message.post) } };
        }
        case MESSAGE_TYPES.POSTS_LIST_REMOVED: {
          const keyError = checkAllowedKeys(message, ["type"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          return { ok: true, result: { posts: await store.listRemovedPosts() } };
        }
        case MESSAGE_TYPES.POSTS_SET_REASON: {
          const keyError = checkAllowedKeys(message, ["type", "opId", "post", "reason", "baseVersion"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          if (!validateOpId(message.opId)) return fail("INVALID_MESSAGE", "opId geçersiz");
          if (!validateBaseVersion(message.baseVersion))
            return fail("INVALID_MESSAGE", "baseVersion geçersiz");
          const identityError = validatePostIdentity(message.post);
          if (identityError) return fail("INVALID_MESSAGE", identityError);
          if (typeof message.reason !== "string" || message.reason.length > 500)
            return fail("INVALID_MESSAGE", "reason geçersiz");
          const result = await store.setPostReason({
            post: message.post,
            reason: message.reason,
            opId: message.opId,
            baseVersion: message.baseVersion,
          });
          return { ok: true, result };
        }
        case MESSAGE_TYPES.WATCH_SET_DRAFT: {
          const keyError = checkAllowedKeys(message, ["type", "opId", "post", "draft", "baseVersion", "followUp"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          if (!validateOpId(message.opId)) return fail("INVALID_MESSAGE", "opId geçersiz");
          if (!validateBaseVersion(message.baseVersion))
            return fail("INVALID_MESSAGE", "baseVersion geçersiz");
          const identityError = validatePostIdentity(message.post);
          if (identityError) return fail("INVALID_MESSAGE", identityError);
          if (typeof message.draft !== "string" || message.draft.length > 1000)
            return fail("INVALID_MESSAGE", "draft geçersiz");
          let followUp;
          try {
            followUp = MessagingModel.normalizeFollowUp(message.followUp);
          } catch (error) {
            return fail("INVALID_MESSAGE", error.message);
          }
          const result = await store.setWatchDraft({
            post: message.post,
            draft: message.draft,
            opId: message.opId,
            baseVersion: message.baseVersion,
            followUp,
          });
          return { ok: true, result };
        }
        case MESSAGE_TYPES.WATCH_REMOVE: {
          const keyError = checkAllowedKeys(message, ["type", "opId", "post", "baseVersion"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          if (!validateOpId(message.opId)) return fail("INVALID_MESSAGE", "opId geçersiz");
          if (!validateBaseVersion(message.baseVersion))
            return fail("INVALID_MESSAGE", "baseVersion geçersiz");
          const identityError = validatePostIdentity(message.post);
          if (identityError) return fail("INVALID_MESSAGE", identityError);
          const result = await store.removeWatch({
            post: message.post,
            opId: message.opId,
            baseVersion: message.baseVersion,
          });
          return { ok: true, result };
        }
        case MESSAGE_TYPES.WATCH_GET: {
          const keyError = checkAllowedKeys(message, ["type", "post"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          const identityError = validatePostIdentity(message.post);
          if (identityError) return fail("INVALID_MESSAGE", identityError);
          return { ok: true, result: { state: await store.getWatchState(message.post) } };
        }
        case MESSAGE_TYPES.WATCH_LIST: {
          const keyError = checkAllowedKeys(message, ["type"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          return { ok: true, result: { watches: await store.listWatches() } };
        }
        case MESSAGE_TYPES.SETTINGS_SAVE_KEY: {
          if (!isTrustedSettingsSender(sender, runtimeId)) {
            return fail("FORBIDDEN_SENDER", "Kimlik işlemi yalnız güvenilir uzantı sayfalarından kabul edilir.");
          }
          const keyError = checkAllowedKeys(message, ["type", "apiKey"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          if (
            typeof message.apiKey !== "string" ||
            message.apiKey.length < 8 ||
            message.apiKey.length > 512 ||
            /\s/.test(message.apiKey)
          ) {
            return fail("INVALID_MESSAGE", "apiKey geçersiz");
          }
          if (!settings) return fail("SETTINGS_UNAVAILABLE", "Ayarlar kullanılamıyor.");
          try {
            await settings.saveKey(message.apiKey);
          } catch {
            // Fixed, safe error only: raw messages/details from
            // credential handling never cross this boundary.
            return fail("SETTINGS_ERROR", "Ayar işlemi tamamlanamadı.");
          }
          // The key itself is never echoed back.
          return { ok: true, result: { hasSessionKey: true } };
        }
        case MESSAGE_TYPES.SETTINGS_CLEAR_KEY: {
          if (!isTrustedSettingsSender(sender, runtimeId)) {
            return fail("FORBIDDEN_SENDER", "Kimlik işlemi yalnız güvenilir uzantı sayfalarından kabul edilir.");
          }
          const keyError = checkAllowedKeys(message, ["type"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          if (!settings) return fail("SETTINGS_UNAVAILABLE", "Ayarlar kullanılamıyor.");
          try {
            await settings.clearKey();
          } catch {
            return fail("SETTINGS_ERROR", "Ayar işlemi tamamlanamadı.");
          }
          return { ok: true, result: { hasSessionKey: false } };
        }
        case MESSAGE_TYPES.SETTINGS_STATUS: {
          if (!isTrustedSettingsSender(sender, runtimeId)) {
            return fail("FORBIDDEN_SENDER", "Kimlik işlemi yalnız güvenilir uzantı sayfalarından kabul edilir.");
          }
          const keyError = checkAllowedKeys(message, ["type"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          if (!settings) {
            return { ok: true, result: { hasSessionKey: false, permissionGranted: false } };
          }
          try {
            return { ok: true, result: await settings.status() };
          } catch {
            return fail("SETTINGS_ERROR", "Ayar işlemi tamamlanamadı.");
          }
        }
        case MESSAGE_TYPES.RESEARCH_SETUP_STATUS: {
          const keyError = checkAllowedKeys(message, ["type"]);
          if (keyError) return fail("INVALID_MESSAGE", keyError);
          if (!researchService) {
            return {
              ok: true,
              result: { status: "not-connected", steps: [] },
            };
          }
          return { ok: true, result: await researchService.setupStatus() };
        }
        case MESSAGE_TYPES.RESEARCH_ONCE: {
          const requestError = validateResearchRequest(message);
          if (requestError) return fail("INVALID_MESSAGE", requestError);
          if (!researchService) {
            return { ok: true, result: { status: "not-connected", events: [] } };
          }
          const result = await researchService.search({
            opId: message.opId,
            eventText: message.eventText.trim(),
            startDate: message.startDate || null,
            sourceUrl: message.sourceUrl || null,
          });
          return { ok: true, result };
        }
        default:
          return fail("INVALID_MESSAGE", "Bilinmeyen mesaj türü: " + message.type);
      }
    } catch (error) {
      if (error && typeof error.code === "string") {
        return fail(error.code, error.message, error.details);
      }
      return fail("INTERNAL_ERROR", "Beklenmeyen hata: " + (error && error.message));
    }
  }

  return { handleMessage, validateSender };
}

const ThreadsMemoryMessagingApi = { MESSAGE_TYPES, createMessageHandler };

if (typeof module !== "undefined" && module.exports) module.exports = ThreadsMemoryMessagingApi;
if (typeof window !== "undefined") window.ThreadsMemoryMessaging = ThreadsMemoryMessagingApi;
if (typeof self !== "undefined") self.ThreadsMemoryMessaging = ThreadsMemoryMessagingApi;
