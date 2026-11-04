"use strict";

/* Persistent store over a pluggable local adapter. */

const ThreadsMemoryModelRef =
  typeof module !== "undefined" && module.exports
    ? require("./model.js")
    : window.ThreadsMemoryModel;

const STORAGE_KEY = "threadsMemory.v1";

function nowIsoDefault() {
  return new Date().toISOString();
}

/**
 * In-memory adapter backed by a shared `backend` object ({ json }).
 * Sharing one backend between two stores simulates a page refresh /
 * extension restart without any real browser profile.
 */
function createMemoryAdapter(backend) {
  const box = backend && typeof backend === "object" ? backend : { json: null };
  if (!("json" in box)) box.json = null;
  return {
    backend: box,
    async read() {
      return box.json;
    },
    async write(json) {
      box.json = json;
    },
  };
}

function createLocalStorageAdapter(localStorageLike, key) {
  const ls =
    localStorageLike ||
    (typeof window !== "undefined" ? window.localStorage : null);
  if (!ls) throw new Error("localStorage is not available");
  const storageKey = key || STORAGE_KEY;
  return {
    async read() {
      return ls.getItem(storageKey);
    },
    async write(json) {
      ls.setItem(storageKey, json);
    },
  };
}

/** Thin chrome.storage.local wrapper. Only used inside the extension. */
function createChromeStorageAdapter(chromeLike, key) {
  const storageKey = key || STORAGE_KEY;
  const area = chromeLike && chromeLike.storage && chromeLike.storage.local;
  if (!area) throw new Error("chrome.storage.local is not available");
  return {
    async read() {
      const result = await area.get(storageKey);
      return result ? result[storageKey] || null : null;
    },
    async write(json) {
      await area.set({ [storageKey]: json });
    },
  };
}

function createStore(adapter, options) {
  if (!adapter || typeof adapter.read !== "function" || typeof adapter.write !== "function") {
    throw new TypeError("adapter with read()/write() is required");
  }
  const now = options && typeof options.now === "function" ? options.now : nowIsoDefault;
  let state = ThreadsMemoryModelRef.createEmptyState();
  let loaded = false;

  async function persist() {
    await adapter.write(ThreadsMemoryModelRef.serializeState(state));
  }

  const store = {
    async load() {
      state = ThreadsMemoryModelRef.deserializeState(await adapter.read());
      loaded = true;
      return store.getState();
    },
    async ensureLoaded() {
      if (!loaded) await store.load();
    },
    getState() {
      return JSON.parse(JSON.stringify(state));
    },
    async savePost(post) {
      await store.ensureLoaded();
      const result = ThreadsMemoryModelRef.savePostToState(state, post, now());
      if (result.saved) await persist();
      return result;
    },
    async listPosts() {
      await store.ensureLoaded();
      return Object.values(state.posts).sort((a, b) =>
        String(b.savedAt).localeCompare(String(a.savedAt))
      );
    },
    async upsertPerson(person) {
      await store.ensureLoaded();
      const record = ThreadsMemoryModelRef.ensurePersonInState(
        state,
        person && person.handle,
        person && person.displayName,
        now()
      );
      await persist();
      return { ...record };
    },
    async setLabels(handle, labels) {
      await store.ensureLoaded();
      const result = ThreadsMemoryModelRef.setLabelsInState(state, handle, labels, now());
      await persist();
      return result;
    },
    async getLabels(handle) {
      await store.ensureLoaded();
      return ThreadsMemoryModelRef.getPersonViewFromState(state, handle).labels;
    },
    async setNote(handle, note) {
      await store.ensureLoaded();
      const result = ThreadsMemoryModelRef.setNoteInState(state, handle, note, now());
      await persist();
      return result;
    },
    async getNote(handle) {
      await store.ensureLoaded();
      return ThreadsMemoryModelRef.getPersonViewFromState(state, handle).note;
    },
    async getPersonView(handle) {
      await store.ensureLoaded();
      return ThreadsMemoryModelRef.getPersonViewFromState(state, handle);
    },
    async listPeople() {
      await store.ensureLoaded();
      return Object.values(state.people).map((person) => ({
        ...person,
        labels: [...(state.labels[person.key] || [])],
        note: state.notes[person.key] || "",
      }));
    },
  };
  return store;
}

const ThreadsMemoryStoreApi = {
  STORAGE_KEY,
  createStore,
  createMemoryAdapter,
  createLocalStorageAdapter,
  createChromeStorageAdapter,
};

if (typeof module !== "undefined" && module.exports) module.exports = ThreadsMemoryStoreApi;
if (typeof window !== "undefined") window.ThreadsMemoryStore = ThreadsMemoryStoreApi;
