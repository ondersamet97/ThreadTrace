"use strict";
const tmTranslate = (text) => typeof globalThis.ThreadsMemoryI18n === "object" ? globalThis.ThreadsMemoryI18n.t(text) : text;

/* Trusted extension setup page (BYOK). The user's own key is
 * sent once to the service worker and kept only in
 * extension-origin IndexedDB. It is cleared from
 * this field immediately, never read back into the UI, and never
 * logged. There is no embedded/shared key anywhere. */

const statusEl = document.getElementById("status");
const stateEl = document.getElementById("state");
const client = window.ThreadsMemoryClient.createExtensionClient({
  sendMessage: (message) => chrome.runtime.sendMessage(message),
});

async function refreshState() {
  try {
    const status = await client.settingsStatus();
    stateEl.textContent = status.hasSessionKey
      ? tmTranslate("API anahtarı kayıtlı (gösterilmez)")
      : tmTranslate("bağlantı bekleniyor");
  } catch {
    stateEl.textContent = tmTranslate("bağlantı bekleniyor");
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const input = document.getElementById("proof");
  const apiKey = input.value.trim();
  if (!apiKey) {
    statusEl.textContent = tmTranslate("Önce anahtarınızı girin.");
    return;
  }
  try {
    await client.saveSessionKey(apiKey);
    input.value = "";
    statusEl.textContent = tmTranslate("API anahtarı kaydedildi; anahtar bir daha gösterilmez.");
    await refreshState();
  } catch (error) {
    input.value = "";
    statusEl.textContent = tmTranslate("Anahtar kaydedilemedi.");
  }
});

document.getElementById("clear").addEventListener("click", async () => {
  try {
    await client.clearSessionKey();
    document.getElementById("proof").value = "";
    statusEl.textContent = tmTranslate("API anahtarı kaldırıldı.");
    await refreshState();
  } catch (error) {
    statusEl.textContent = tmTranslate("Anahtar kaldırılamadı.");
  }
});

document.getElementById("permission").addEventListener("click", async () => {
  // Optional api.meta.ai permission is requested ONLY from this
  // trusted page, on an explicit user gesture.
  try {
    const granted = await chrome.permissions.request({
      origins: ["https://api.meta.ai/*"],
    });
    statusEl.textContent = granted ? tmTranslate("api.meta.ai izni verildi.") : tmTranslate("api.meta.ai izni verilmedi.");
  } catch (error) {
    statusEl.textContent = tmTranslate("İzin istenemedi.");
  }
});

if (globalThis.ThreadsMemoryI18n) void globalThis.ThreadsMemoryI18n.ready.then(refreshState); else refreshState();
