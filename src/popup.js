"use strict";
const tmTranslate = (text) => typeof globalThis.ThreadsMemoryI18n === "object" ? globalThis.ThreadsMemoryI18n.t(text) : text;

/*
 * Popup view. Reads (and any future writes) go through the same
 * validated worker message path as the content script
 * (client.js -> service worker). It never touches storage directly.
 * A storage-change notification re-renders the list; the popup has
 * no editable draft fields.
 */

const popupClient = window.ThreadsMemoryClient.createExtensionClient({
  sendMessage: (message) => chrome.runtime.sendMessage(message),
});

async function renderSaved() {
  const listEl = document.getElementById("saved-list");
  const emptyEl = document.getElementById("empty");
  try {
    const posts = await popupClient.listPosts();
    listEl.textContent = "";
    emptyEl.style.display = posts.length ? "none" : "block";
    for (const post of posts) {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = post.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = post.text;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = post.authorDisplayName + " (@" + post.authorHandle + ")";
      li.append(link, meta);
      listEl.appendChild(li);
    }
  } catch (error) {
    emptyEl.style.display = "block";
    emptyEl.textContent = tmTranslate("Veri okunamadı: ") + error.message;
  }
}

window.ThreadsMemoryClient.onStorageChanged(chrome, "tm.v2.", () => {
  void renderSaved();
});

renderSaved();
