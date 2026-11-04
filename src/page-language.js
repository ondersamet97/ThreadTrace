"use strict";
(() => {
  const locale = globalThis.ThreadsMemoryI18n;
  if (!locale) return;
  const settings = location.pathname.endsWith('/options.html');
  function apply() {
    const en = locale.language !== 'tr';
    document.documentElement.lang = en ? 'en' : 'tr';
    if (settings) {
      const title = document.querySelector('h1');
      const steps = document.querySelectorAll('ol li');
      const label = document.querySelector('label[for="proof"]');
      const buttons = { save: ['API anahtarını kaydet','Save API key'], clear: ['API anahtarını kaldır','Remove API key'], permission: ['api.meta.ai iznini iste','Allow api.meta.ai access'] };
      if (title) title.textContent = en ? 'Research setup' : 'Araştırma kurulumu (BYOK)';
      const tr = ["Anahtar bu cihazda kalıcı saklanır ve istediğiniz zaman kaldırılabilir. Şifrelenmeden saklanır; cihazınıza veya tarayıcı profilinize erişen kişiler anahtara erişebilir.", 'api.meta.ai erişimi için isteğe bağlı izni aşağıdaki düğmeyle verin.', 'Radar panelinden tek seferlik araştırmayı onaylayıp çalıştırın.'];
      const eng = ['Your API key is stored locally across restarts. You can remove it at any time. It is not encrypted; someone with access to this device or browser profile may access it.', 'Use the button below to allow optional api.meta.ai access.', 'Approve and run one research request from the research panel.'];
      steps.forEach((node, i) => { if (i < 3) node.textContent = (en ? eng : tr)[i]; });
      if (label) label.textContent = en ? 'Your Meta API key' : 'Kendi Meta anahtarınız';
      for (const [id, pair] of Object.entries(buttons)) { const node = document.getElementById(id); if (node) node.textContent = pair[en ? 1 : 0]; }
      const state = document.getElementById('state');
      if (state && state.parentNode && state.parentNode.firstChild && state.parentNode.firstChild.nodeType === 3) state.parentNode.firstChild.nodeValue = en ? 'Status: ' : 'Durum: ';
    } else {
      const title = document.querySelector('h1'); const note = document.querySelector('p.note'); const empty = document.getElementById('empty');
      if (title) title.textContent = en ? 'Personal memory' : 'Kişisel hafıza (yerel)';
      if (note) note.textContent = en ? 'Stored in this browser only. Not synced with Threads Saved.' : "Bu liste yalnız bu tarayıcıda saklanır. Threads'in yerleşik Saved listesiyle senkronize değildir.";
      if (empty) empty.textContent = en ? 'No saved posts yet.' : 'Henüz kaydedilmiş gönderi yok.';
    }
  }
  void locale.ready.then(apply);
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes['tm.ui.language']) apply(); });
})();
