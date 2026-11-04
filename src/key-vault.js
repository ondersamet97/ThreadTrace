"use strict";
// IndexedDB belongs to the extension origin. Threads content scripts do not
// receive the key; only extension pages and the worker can access this database.
(function (root) {
  function createKeyVault(factory) {
    let database;
    function open() {
      if (!factory || typeof factory.open !== "function") return Promise.reject(new Error("Key storage unavailable"));
      if (!database) database = new Promise((resolve, reject) => {
        const request = factory.open("threads-memory-key-vault", 1);
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("secrets")) request.result.createObjectStore("secrets"); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Key storage unavailable"));
        request.onblocked = () => reject(new Error("Key storage blocked"));
      }).catch(error => { database = null; throw error; });
      return database;
    }
    async function execute(mode, operation) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("secrets", mode);
        const req = operation(tx.objectStore("secrets"));
        let value;
        req.onsuccess = () => { value = req.result; };
        req.onerror = () => reject(req.error || new Error("Key storage failed"));
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error || new Error("Key storage failed"));
        tx.onabort = () => reject(tx.error || new Error("Key storage aborted"));
      });
    }
    return {
      async get() { const value = await execute("readonly", store => store.get("meta")); return typeof value === "string" && value ? value : null; },
      async save(key) { await execute("readwrite", store => store.put(key, "meta")); },
      async clear() { await execute("readwrite", store => store.delete("meta")); },
    };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { createKeyVault };
  else root.ThreadsMemoryKeyVault = { createKeyVault };
})(typeof self !== "undefined" ? self : globalThis);
