"use strict";
// The language preference is confined to extension UI, never user content.
(() => {
  const picker = document.getElementById("language-select");
  if (!picker) return;
  const key = "threads-memory-ui-language";
  const labels = {
    "settings-open": ["Ayarlar", "Settings"], "tab-memory": ["Takipler", "Follow-ups"],
    "tab-people": ["Etiketler", "Tags"], "memory-title": ["Hafıza", "Memory"],
    "saved-empty": ["Henüz kaydedilmiş gönderi yok.", "No saved posts yet."],
    "removed-title": ["Kaldırılanlar", "Removed"], "removed-empty": ["Kaldırılan kayıt yok.", "No removed posts."],
    "people-title": ["Etiketler", "Tags"], "people-empty": ["Henüz etiket yok. Threads üzerinde bir kişinin yanındaki simgeyle etiket oluşturun.", "No tags yet. Use the icon beside a person on Threads to create one."],
    "back": ["← Etiketlere dön", "← Back to tags"], "editor-title": ["Kişi", "Person"],
    "labels-help": ["Enter ile ekleyin; etikete tıklayarak veya klavyeyle seçerek bu kişiden kaldırın. Değişiklikler Etiketleri kaydet ile saklanır. Virgül etiketin bir parçasıdır.", "Press Enter to add a label; select a label to remove it. Save labels to keep your changes. Commas are part of the label."],
    "labels-save": ["Etiketleri kaydet", "Save labels"], "label-colors-title": ["Etiket renkleri", "Label colors"],
    "label-color-empty": ["Renk seçmek için önce bir kişi etiketi kaydedin.", "Save a person label first to choose a color."],
    "label-color-save": ["Rengi kaydet", "Save color"], "label-feed-open": ["Etiketin gönderileri", "Posts with this label"],
    "note-save": ["Notu kaydet", "Save note"], "label-feed-back": ["← Geri dön", "← Back"],
    "label-feed-scope": ["Bu etikete sahip hesaplar. Threads üzerinde etikete basarak sayfada yüklü gönderileri görün.", "Accounts with this tag. Select the tag on Threads to see posts loaded on the page."],
    "label-feed-show-posts": ["Threads sayfasındaki gönderileri göster", "Show posts on Threads"],
    "label-feed-edit": ["Etiketi düzenle", "Edit label"],
    "label-feed-edit-help": ["Kişinin etiket üyeliğini ve ortak etiket rengini düzenleyin. Üyelik değişikliği yalnız seçilen kişiye uygulanır; renk aynı etiketi kullanan herkes için geçerlidir.", "Edit this person's label and its shared color. Membership applies only to the selected person; the color applies to everyone using this label."],
    "label-feed-empty": ["Bu etikete bağlı hesap yok.", "No accounts use this tag."],
    "how-to-title": ["Nasıl kullanılır?", "How to use"],
    "how-to-tags": ["Threads'te kişinin yanındaki simgeye basın, etiket ve not ekleyip kaydedin. Etiketler yan panelde listelenir.", "On Threads, select the icon beside a person, add tags or notes, and save. Tags appear in this panel."],
    "how-to-feed": ["Etikete basarak ilişkili hesapları açın. Threads sayfasında etikete basarak o sayfada yüklü gönderileri filtreleyin.", "Select a tag to see its accounts. On Threads, select a tag to filter posts loaded on that page."],
    "how-to-muse": ["Ayarlar'da Meta API anahtarınızı kaydedip izin verin. Gönderideki radar düğmesinden metni inceleyip araştırmayı onaylayın.", "Save your Meta API key and allow access in Settings. Use a post's radar button to review the text and approve a research request."],
    "how-to-follow": ["Takip süresi ve türünü seçin; isterseniz günlük otomatik kontrolü işaretleyin. Kontroller API ücreti doğurabilir.", "Choose a follow-up type and duration; optionally enable daily checks. API charges may apply."],
    "how-to-privacy": ["Veriler cihazda tutulur. Anahtar şifrelenmeden saklanır; kaldırma ve tüm veriyi silme ayarlardadır.", "Data stays on this device. Your key is stored unencrypted; remove it or delete all data in Settings."],
    "settings-clear-all": ["Tüm veriyi sil", "Delete all data"],
    "settings-back": ["← Geri dön", "← Back"], "settings-title": ["Ayarlar", "Settings"],
    "settings-save-key": ["API anahtarını kaydet", "Save API key"], "settings-clear-key": ["API anahtarını kaldır", "Remove API key"],
    "settings-permission": ["api.meta.ai iznini iste", "Allow api.meta.ai access"],
    "language-refresh-hint": ["Dil değişikliğini Threads sayfasına uygulamak için sayfayı yenileyin.", "Refresh the Threads page to apply a language change there."],
    "watch-title": ["Takip listesi", "Follow-ups"],
    "watch-notice": ["Otomatik takip seçilirse günde bir kontrol yapılır. Tarayıcı açık ve API anahtarı girilmiş olmalıdır.", "When enabled, automatic follow-ups run once a day while Chrome is open and your API key is set."],
    "watch-empty": ["Henüz takip listenizde bir olay yok.", "No events in your follow-up list yet."],
    "project-credit": ["Önder Samet tarafından geliştirildi", "Developed by Önder Samet"],
    "settings-api-note": ["API anahtarınız bu cihazdaki eklenti depolamasında kalıcı olarak saklanır; eklenti veya tarayıcı yeniden başladığında silinmez. İstediğiniz zaman kaldırabilirsiniz. Anahtar şifrelenmeden saklanır; bu cihaza veya tarayıcı profilinize erişimi olanlar erişebilir.", "Your API key is stored locally in this extension across browser and extension restarts. You can remove it at any time. It is not encrypted; someone with access to this device or browser profile may access it."],
  };
  const formLabels = { "labels-input": ["Yeni kişi etiketi", "New person label"], "label-color-select": ["Kaydedilmiş etiket", "Saved label"], "label-color-custom": ["Özel renk", "Custom color"], "note-text": ["Not defteri", "Notes"], "settings-provider": ["Sağlayıcı", "Provider"], "settings-api-key": ["Kendi Meta anahtarınız", "Your Meta API key"] };
  const texts = [
    ["header p", "Yalnız bu cihazda saklanır; Threads Saved ile senkronize değildir.", "Stored on this device. Not synced with Threads Saved."],
    ["#label-colors > p.status", "Renk aynı kişi etiketini kullanan herkes için geçerlidir. Önizleme, Rengi kaydet düğmesine basana kadar kaydedilmez.", "Colors are shared across people with the same label. Save the color to apply it."],
    ["#settings-provider + p.status", "Ürün modeli: muse-spark-1.3. Resmi ortaklık iddiası yoktur.", "Model: muse-spark-1.3."],
  ];
  function apply(lang) {
    const en = lang !== "tr"; document.documentElement.lang = en ? "en" : "tr";
    for (const [id, pair] of Object.entries(labels)) { const node = document.getElementById(id); if (node && !(id === "editor-title" && node.textContent.startsWith("@"))) node.textContent = pair[en ? 1 : 0]; }
    for (const [id, pair] of Object.entries(formLabels)) { const node = document.querySelector('label[for="' + id + '"]'); if (node) node.textContent = pair[en ? 1 : 0]; }
    for (const [selector, tr, english] of texts) { const node = document.querySelector(selector); if (node) node.textContent = en ? english : tr; }
    document.getElementById("labels-input").placeholder = en ? "Type a label and press Enter" : "Etiketi yazıp Enter'a basın";
    document.getElementById("settings-api-key").placeholder = en ? "Enter your key" : "Anahtarınızı girin";
    document.getElementById("settings-open").setAttribute("aria-label", en ? "Open settings" : "Ayarlar'ı aç");
    const aria = [[".tabs", "Yan panel görünümleri", "Sidebar views"], ["#labels-draft", "Bu kişinin etiket taslağı", "This person's label draft"], ["#label-color-presets", "Etiket renkleri", "Label colors"], ["#label-feed-people", "Etiketi düzenlemek için kişi seçin", "Choose a person to edit the label"]];
    for (const [selector, tr, english] of aria) { const node = document.querySelector(selector); if (node) node.setAttribute("aria-label", en ? english : tr); }
    picker.value = en ? "en" : "tr";
  }
  let language = "en";
  try { language = localStorage.getItem(key) === "tr" ? "tr" : "en"; } catch (_) {}
  apply(language);
  // Dedicated preference key only; never read or rewrite personal records.
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get("tm.ui.language").then((stored) => {
      if (stored && (stored["tm.ui.language"] === "en" || stored["tm.ui.language"] === "tr")) apply(stored["tm.ui.language"]);
    }).catch(() => {});
    if (chrome.storage.onChanged) chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes["tm.ui.language"]) apply(changes["tm.ui.language"].newValue);
    });
  }
  picker.addEventListener("change", () => {
    try { localStorage.setItem(key, picker.value); } catch (_) {}
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ "tm.ui.language": picker.value }).catch(() => {});
    }
    apply(picker.value);
  });
})();
