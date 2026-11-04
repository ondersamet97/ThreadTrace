"use strict";

/*
 * MV3 service worker: the single owner of chrome.storage.local.
 * Content scripts and the popup never write storage directly; they
 * send validated, field-limited messages here, and this worker runs
 * them through one serialized read-modify-write queue. Success is
 * answered only after the persistent write resolves.
 *
 * Service workers have no `window`; this file and its imports use
 * `self` only.
 */

importScripts("followup-comparison.js", "key-vault.js", "model.js", "field-store.js", "research-adapter.js", "research-service.js", "messaging.js");

// Native side panel: clicking the toolbar action opens the panel
// (the user's Chrome left/right placement preference is honored;
// we never force a side). There is no action popup, so the two
// can never open together.
if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function") {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.warn("[Threads Memory] sidePanel davranışı ayarlanamadı:", error && error.message));
}

const fieldStore = self.ThreadsMemoryFieldStore.createFieldStore({
  storage: self.ThreadsMemoryFieldStore.createChromeStorageArea(chrome),
});

const SESSION_KEY_ITEM = "tmMetaApiKey";
const keyVault = self.ThreadsMemoryKeyVault.createKeyVault(typeof indexedDB !== "undefined" ? indexedDB : null);

async function readSessionKey() {
  // Migrate a key from an existing session, if one survives the update.
  const saved = await keyVault.get();
  if (saved) return saved;
  if (!chrome.storage || !chrome.storage.session) return null;
  const old = await chrome.storage.session.get(SESSION_KEY_ITEM);
  const key = old && old[SESSION_KEY_ITEM];
  if (typeof key !== "string" || !key) return null;
  await keyVault.save(key);
  await chrome.storage.session.remove(SESSION_KEY_ITEM);
  return key;
}

async function hasApiPermission() {
  try {
    if (!chrome.permissions || typeof chrome.permissions.contains !== "function") return false;
    return await chrome.permissions.contains({ origins: ["https://api.meta.ai/*"] });
  } catch {
    return false;
  }
}

// The extension-origin IndexedDB holds the key locally across restarts.
// Trusted extension pages may save/remove it; no message returns the key.
const sessionSettings = {
  async saveKey(apiKey) {
    await keyVault.save(apiKey);
    if (chrome.storage.session) await chrome.storage.session.remove(SESSION_KEY_ITEM);
  },
  async clearKey() {
    await keyVault.clear();
    if (chrome.storage.session) await chrome.storage.session.remove(SESSION_KEY_ITEM);
  },
  async status() {
    return { hasSessionKey: Boolean(await readSessionKey()), permissionGranted: await hasApiPermission() };
  },
};

// One-shot research, direct to the fixed Meta endpoint with the
// user's session key. Without the optional api.meta.ai host
// permission or a session key: zero network calls. The page
// never gets a general fetch capability.
const TRIAL_USED_ITEM = "tmResearchTrialUsed";

const researchService = self.ThreadsMemoryResearchService.createResearchService({
  allowRepeated: true,
  fetchImpl: typeof fetch === "function" ? (...args) => fetch(...args) : null,
  getApiKey: readSessionKey,
  hasPermission: hasApiPermission,
  getLanguage: async () => {
    const stored = await chrome.storage.local.get("tm.ui.language");
    return stored && stored["tm.ui.language"] === "tr" ? "tr" : "en";
  },
  // The one-trial marker lives in the same session storage as
  // the browser session, so an MV3 worker restart cannot grant a second
  // upstream trial. Saving/removing a key never touches it; a
  // new Chrome session clears it naturally.
  trialStore: {
    async getUsed() {
      const stored = await chrome.storage.session.get(TRIAL_USED_ITEM);
      return Boolean(stored && stored[TRIAL_USED_ITEM]);
    },
    async markUsed() {
      await chrome.storage.session.set({ [TRIAL_USED_ITEM]: true });
    },
  },
});

const messageHandler = self.ThreadsMemoryMessaging.createMessageHandler({
  store: fieldStore,
  runtimeId: chrome.runtime.id,
  researchService,
  settings: sessionSettings,
});

let resetRequested = false;
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "tm.settings.clearAll") {
    const allowed = sender && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("src/sidepanel.html");
    if (!allowed) { sendResponse({ ok: false }); return false; }
    (async () => {
      resetRequested = true;
      try {
        while (autoRunning) await new Promise(resolve => setTimeout(resolve, 100));
        await keyVault.clear();
        await chrome.storage.session.clear();
        await chrome.storage.local.clear();
        sendResponse({ ok: true });
      } catch (_) { sendResponse({ ok: false }); }
      finally { resetRequested = false; }
    })();
    return true;
  }
  messageHandler
    .handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: String(error && error.message), details: {} },
      });
    });
  // Keep the message channel open for the async response.
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  console.info("[Threads Memory] Installed. Data stays in chrome.storage.local; no sync.");
});

// An explicit per-follow-up opt-in is required. Claims are persisted before
// contacting the provider, preventing retries or worker restarts from creating
// extra paid requests. Missing session credentials cause no network request.
const AUTO_ALARM = "tm.followups.hourly";
const AUTO_STATE = "tm.followups.state.v1";
const AUTO_DAY = 24 * 60 * 60 * 1000;
const automaticResearch = self.ThreadsMemoryResearchService.createResearchService({
  fetchImpl: typeof fetch === "function" ? (...args) => fetch(...args) : null,
  getApiKey: readSessionKey,
  hasPermission: hasApiPermission,
  allowRepeated: true,
  getLanguage: async () => {
    const stored = await chrome.storage.local.get("tm.ui.language");
    return stored["tm.ui.language"] === "tr" ? "tr" : "en";
  },
});
let autoRunning = false;
async function runAutomaticFollowups() {
  if (autoRunning || resetRequested) return;
  autoRunning = true;
  try {
    const watches = await fieldStore.listWatches();
    const stored = await chrome.storage.local.get(AUTO_STATE);
    const states = stored[AUTO_STATE] && typeof stored[AUTO_STATE] === "object" ? stored[AUTO_STATE] : {};
    const active = new Set(watches.filter(w => w.followUp && w.followUp.automatic).map(w => w.postKey));
    for (const key of Object.keys(states)) if (!active.has(key)) delete states[key];
    await chrome.storage.local.set({ [AUTO_STATE]: states });
    if (!await hasApiPermission() || !await readSessionKey()) {
      for (const w of watches) if (w.followUp && w.followUp.automatic) {
        const prior = states[w.postKey];
        if (!prior || prior.scheduledAt === w.followUp.scheduledAt) states[w.postKey] = { ...(prior || {}), scheduledAt: w.followUp.scheduledAt, status: "not-connected" };
      }
      await chrome.storage.local.set({ [AUTO_STATE]: states });
      return;
    }
    for (const watch of watches) {
      if (resetRequested) break;
      const pref = watch.followUp;
      if (!pref || !pref.automatic) continue;
      const now = Date.now();
      const start = pref.scheduledAt;
      if (now < start || now >= start + pref.durationDays * AUTO_DAY) continue;
      let state = states[watch.postKey];
      if (!state || state.scheduledAt !== start) state = { scheduledAt: start, nextAt: start };
      if (now < state.nextAt) continue;
      const current = await fieldStore.getWatch({ id: watch.postId, url: watch.url, authorHandle: watch.authorHandle });
      if (!current.watch || !current.watch.followUp || current.watch.followUp.scheduledAt !== start || !current.watch.followUp.automatic) continue;
      // Store the daily quota before fetching; a timeout is never retried today.
      state = { ...state, nextAt: now + AUTO_DAY, lastAttemptAt: now, status: "checking" };
      states[watch.postKey] = state;
      await chrome.storage.local.set({ [AUTO_STATE]: states });
      try {
        const prompt = pref.eventText + (pref.mode === "custom" ? "\n" + pref.customPrompt : pref.mode === "result-and-commentary" ? "\nFollow the outcome and subsequent reactions." : "\nFollow developments until the event concludes.");
        const result = await automaticResearch.search({ opId: "auto:" + watch.postKey + ":" + now, eventText: prompt, startDate: null, sourceUrl: watch.url, ...(state.answer ? { comparison: { previousReport: state.answer.slice(0, 6000), previousCheckedAt: new Date(state.checkedAt).toISOString() } } : {}) });
        const latest = await fieldStore.getWatch({ id: watch.postId, url: watch.url, authorHandle: watch.authorHandle });
        if (!latest.watch || !latest.watch.followUp || !latest.watch.followUp.automatic || latest.watch.followUp.scheduledAt !== start) continue;
        if (result.status === "completed") {
          const { change, answer } = self.ThreadsMemoryFollowupComparison.assess(result, state.answer);
          states[watch.postKey] = { ...state, status: "completed", checkedAt: now, answer, change };
          await chrome.storage.local.set({ [AUTO_STATE]: states });
          if (change === "new") {
            const lang = await chrome.storage.local.get("tm.ui.language");
            try { await chrome.notifications.create({ type: "basic", iconUrl: "src/notification.png", title: lang["tm.ui.language"] === "tr" ? "Yeni gelişme olabilir" : "Possible new development", message: lang["tm.ui.language"] === "tr" ? "Muse yeni bir gelişme bildirdi. Sonucu yan panelde inceleyin." : "Muse reported a possible development. Review it in the side panel." }); } catch (_) { /* Result remains available if notifications are blocked. */ }
          }
        } else {
          states[watch.postKey] = { ...state, status: "not-connected" };
          await chrome.storage.local.set({ [AUTO_STATE]: states });
        }
      } catch (_) {
        states[watch.postKey] = { ...state, status: "error" };
        await chrome.storage.local.set({ [AUTO_STATE]: states });
      }
    }
  } finally { autoRunning = false; }
}
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === AUTO_ALARM) void runAutomaticFollowups(); });
  chrome.alarms.get(AUTO_ALARM).then((alarm) => {
    if (!alarm) chrome.alarms.create(AUTO_ALARM, { periodInMinutes: 60 });
  }).catch(() => {});
}
