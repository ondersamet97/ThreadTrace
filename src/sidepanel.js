"use strict";
const tmTranslate = (text) => typeof globalThis.ThreadsMemoryI18n === "object" ? globalThis.ThreadsMemoryI18n.t(text) : text;

/*
 * Native side panel view. It reads and writes ONLY through the
 * same validated worker message path as the content script
 * (client.js -> service worker). Opening the panel performs no
 * writes and no migration. The AI/research state stays stopped:
 * there is no research control in this panel.
 */

const sideClient = window.ThreadsMemoryClient.createExtensionClient({
  sendMessage: (message) => chrome.runtime.sendMessage(message),
});
const sideModel = window.ThreadsMemoryModel;

const el = (id) => document.getElementById(id);
const savedList = el("saved-list");
const savedEmpty = el("saved-empty");
const peopleList = el("people-list");
const peopleEmpty = el("people-empty");
const editorEl = el("person-editor");
const editorTitle = el("editor-title");
const editorPerson = el("editor-person");
const labelsInput = el("labels-input");
const labelsDraftEl = el("labels-draft");
const labelsSave = el("labels-save");
const labelsStatus = el("labels-status");
const noteText = el("note-text");
const noteSave = el("note-save");
const noteStatus = el("note-status");
const panelStatus = el("panel-status");

let peopleByHandle = new Map();
let session = null;
let sessionSeq = 0;
let labelStyles = new Map();
const colorDrafts = new Map();
let selectedColor = null;
let labelFeed = null;

function paintLabel(element, color) {
  element.style.backgroundColor = color === null ? "" : sideModel.normalizeLabelColor(color);
  element.style.color = color === null ? "" : sideModel.labelTextColor(color);
}

// Reads and writes can finish out of order. Once a newer style was
// observed, neither a delayed list nor a delayed save may repaint it.
function observeLabelStyle(style) {
  const current = labelStyles.get(style.labelKey);
  if (!current || style.version >= current.version) labelStyles.set(style.labelKey, style);
  return labelStyles.get(style.labelKey);
}

function savedLabels(labels) {
  const unique = new Map();
  for (const label of labels || []) {
    try {
      const key = sideModel.normalizeLabelKey(label);
      if (!unique.has(key)) unique.set(key, label);
    } catch { /* malformed legacy labels are not actionable */ }
  }
  return unique;
}

function preserveColorDraft(state) {
  try {
    const key = "tm.sidepanel.color." + state.key;
    if (state.dirty || state.pending) {
      window.sessionStorage.setItem(key, JSON.stringify({
        color: state.color, version: state.version, pending: state.pending || null,
      }));
    } else window.sessionStorage.removeItem(key);
  } catch { /* the in-memory draft remains usable */ }
}

function colorState(key) {
  if (!colorDrafts.has(key)) {
    const state = { key, color: null, version: 0, ready: false, dirty: false, busy: false, pending: null, readSeq: 0, status: "" };
    try {
      const draft = JSON.parse(window.sessionStorage.getItem("tm.sidepanel.color." + key) || "null");
      if (draft && Number.isInteger(draft.version) && draft.version >= 0) {
        state.color = draft.color === null ? null : sideModel.normalizeLabelColor(draft.color);
        state.version = draft.version;
        state.dirty = true;
        state.ready = true;
        // A preserved retry must still address this exact label field.
        if (draft.pending && draft.pending.message && draft.pending.message.type === "tm.labels.setColor" &&
            sideModel.normalizeLabelKey(draft.pending.message.label) === key) state.pending = draft.pending;
        state.status = state.pending ? tmTranslate("Sonuç belirsiz; aynı kaydı doğrulayabilirsiniz.") : tmTranslate("Kaydedilmemiş renk önizlemeniz korundu.");
      }
    } catch { /* ignore an invalid view-local draft */ }
    colorDrafts.set(key, state);
  }
  return colorDrafts.get(key);
}

function renderColorControls() {
  const selected = selectedColor;
  if (!selected || session !== selected.person) return;
  const state = selected.state;
  const locked = !state.ready;
  el("label-color-custom").disabled = locked;
  el("label-color-save").disabled = locked || state.busy || (!state.dirty && !state.pending);
  el("label-color-save").textContent = state.pending ? tmTranslate("Sonucu doğrula") : tmTranslate("Rengi kaydet");
  el("label-color-custom").value = state.color || "#808080";
  el("label-color-preview").textContent = selected.label;
  paintLabel(el("label-color-preview"), state.color);
  el("label-color-status").textContent = state.status;
  for (const button of el("label-color-presets").children) {
    button.disabled = locked;
    button.setAttribute("aria-pressed", button.dataset.color === state.color ? "true" : "false");
  }
}

async function chooseLabelColor(key) {
  const active = currentSession();
  const label = active && savedLabels(active.savedLabels).get(key);
  if (!label) return;
  const state = colorState(key);
  const selected = { person: active, state, label };
  selectedColor = selected;
  if (!state.ready) state.status = tmTranslate("Renk yükleniyor...");
  renderColorControls();
  const readId = ++state.readSeq;
  try {
    const style = observeLabelStyle(await sideClient.getLabelStyle(key));
    if (readId !== state.readSeq) return;
    if (!state.dirty && !state.busy && !state.pending && style.version >= state.version) {
      state.color = style.color;
      state.version = style.version;
      state.ready = true;
      state.status = "";
    }
  } catch {
    if (readId === state.readSeq) state.status = tmTranslate("Renk okunamadı. Kişiyi yeniden açarak tekrar deneyin.");
  }
  if (selectedColor === selected && session === active) renderColorControls();
}

function updateColorLabels(active, labels) {
  if (session !== active) return;
  active.savedLabels = [...labels];
  const choices = savedLabels(labels);
  const select = el("label-color-select");
  const oldKey = selectedColor && selectedColor.person === active ? selectedColor.state.key : null;
  const key = choices.has(oldKey) ? oldKey
    : choices.has(active.preferredColorKey) ? active.preferredColorKey : choices.keys().next().value;
  active.preferredColorKey = null;
  select.textContent = "";
  for (const [value, label] of choices) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  el("label-color-controls").hidden = !choices.size;
  el("label-color-empty").hidden = Boolean(choices.size);
  if (!choices.size) {
    selectedColor = null;
    el("label-color-status").textContent = "";
    return;
  }
  select.value = key;
  if (oldKey === key && selectedColor) {
    selectedColor.label = choices.get(key);
    renderColorControls();
  } else void chooseLabelColor(key);
}

function previewLabelColor(color) {
  if (!selectedColor || selectedColor.person !== currentSession() || !selectedColor.state.ready) return;
  const state = selectedColor.state;
  state.color = color === null ? null : sideModel.normalizeLabelColor(color);
  state.dirty = true;
  state.status = tmTranslate("Önizleme — renk henüz kaydedilmedi.");
  preserveColorDraft(state);
  renderColorControls();
}

async function saveLabelColor() {
  const selected = selectedColor;
  if (!selected || selected.person !== currentSession()) return;
  const state = selected.state;
  if (!state.ready || state.busy || (!state.dirty && !state.pending)) return;
  state.busy = true;
  renderColorControls();
  const sent = state.pending ? state.pending.message.color : state.color;
  try {
    const result = state.pending
      ? await sideClient.retryExactOperation(state.pending)
      : await sideClient.setLabelColor(state.key, sent, state.version);
    state.pending = null;
    const observed = observeLabelStyle(result);
    const superseded = observed.version > result.version || (result.deduplicated && result.color !== sent);
    state.version = observed.version;
    state.dirty = state.color !== sent || superseded;
    state.status = superseded
      ? tmTranslate("Renk başka görünümde değişti; önizlemeniz korundu. Üzerine yazmak için yeniden kaydedin.")
      : state.dirty ? tmTranslate("Renk kaydedildi; yeni önizlemeniz henüz kaydedilmedi.") : "Renk kaydedildi.";
    preserveColorDraft(state);
    await refreshLists();
  } catch (error) {
    if (error.code === "UNCERTAIN_OUTCOME") {
      state.pending = sideClient.getPendingOperationFor("tm.labels.setColor", state.key);
      state.status = tmTranslate("Sonuç belirsiz; tekrar basınca aynı renk kaydı doğrulanır.");
    } else {
      state.pending = null;
      if (error.code === "VERSION_CONFLICT") {
        if (error.details && Number.isInteger(error.details.currentVersion)) state.version = error.details.currentVersion;
        state.status = tmTranslate("Renk başka görünümde değişti. Önizlemeniz duruyor; üzerine yazmak için yeniden kaydedin.");
      } else state.status = tmTranslate("Renk kaydedilemedi. Önizlemeniz korundu.");
    }
    preserveColorDraft(state);
  } finally {
    state.busy = false;
    if (selectedColor && selectedColor.state === state) renderColorControls();
  }
}

for (const preset of sideModel.LABEL_COLOR_PRESETS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = tmTranslate(preset.name);
  button.dataset.color = preset.color;
  button.setAttribute("aria-pressed", "false");
  paintLabel(button, preset.color);
  button.style.color = "#ffffff";
  button.addEventListener("click", () => previewLabelColor(preset.color));
  el("label-color-presets").appendChild(button);
}
el("label-color-select").addEventListener("change", () => void chooseLabelColor(el("label-color-select").value));
el("label-color-custom").addEventListener("input", () => previewLabelColor(el("label-color-custom").value));
el("label-color-save").addEventListener("click", () => void saveLabelColor());
el("label-feed-open").addEventListener("click", () => {
  if (selectedColor) void openLabelFeed(selectedColor.label, el("label-feed-open"));
});

/* View-local drafts (sessionStorage of this trusted page only;
 * never worker storage, never auto-saved to the worker). */
const DRAFT_KEY = "tm.sidepanel.drafts.v1";
function readDrafts() {
  try {
    return JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) || "{}");
  } catch {
    return {};
  }
}
function writeDraft(handle, draft) {
  try {
    const drafts = readDrafts();
    if (draft) drafts[handle] = draft;
    else delete drafts[handle];
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
  } catch {
    /* sessionStorage unavailable: in-memory behavior only */
  }
}
function preserveDraft() {
  if (!session) return;
  if (session.labelsDirty || session.labelsPending || session.noteDirty) {
    writeDraft(session.handle, {
      labels: [...(session.labelsDraft || [])],
      labelsInput: labelsInput.value,
      labelsDirty: session.labelsDirty,
      labelsBaseVersion: session.labelsBaseVersion,
      labelsPending: session.labelsPending || null,
      note: noteText.value,
      noteDirty: session.noteDirty,
      notesBaseVersion: session.notesBaseVersion,
    });
  } else {
    writeDraft(session.handle, null);
  }
}

function renderLabelsDraft(active) {
  if (session !== active) return;
  labelsDraftEl.textContent = "";
  active.labelsDraft.forEach((label, index) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = label + " ×";
    chip.dataset.label = label;
    chip.setAttribute("aria-label", label + tmTranslate(" etiketini bu kişiden kaldır (taslak)"));
    let key;
    try { key = sideModel.normalizeLabelKey(label); } catch { /* keep legacy text intact */ }
    paintLabel(chip, labelStyles.get(key)?.color || null);
    chip.addEventListener("click", () => {
      if (session !== active || active.state !== "ready") return;
      active.labelsDraft.splice(index, 1);
      active.labelsDirty = true;
      renderLabelsDraft(active);
      preserveDraft();
      labelsStatus.textContent = tmTranslate("Etiket bu kişinin taslağından kaldırıldı; kaydettiğinizde uygulanır.");
      safeFocus(labelsDraftEl.children[index] || labelsDraftEl.children[index - 1] || labelsInput);
    });
    labelsDraftEl.appendChild(chip);
  });
}

function addDraftLabel() {
  const active = currentSession();
  if (!active) return;
  const label = labelsInput.value.trim();
  if (!label) {
    labelsStatus.textContent = tmTranslate("Önce bir etiket yazın.");
    return;
  }
  let key;
  try { key = sideModel.normalizeLabelKey(label); } catch {
    labelsStatus.textContent = tmTranslate("Etiket en fazla 64 karakter olabilir.");
    return;
  }
  if (savedLabels(active.labelsDraft).has(key)) {
    labelsStatus.textContent = tmTranslate("Bu etiket zaten kişinin taslağında var.");
    return;
  }
  active.labelsDraft.push(label);
  active.labelsDirty = true;
  labelsInput.value = "";
  renderLabelsDraft(active);
  preserveDraft();
  labelsStatus.textContent = tmTranslate("Etiket taslağa eklendi; kalıcı olması için kaydedin.");
}

let labelsComposing = false;
labelsInput.addEventListener("compositionstart", () => { labelsComposing = true; });
labelsInput.addEventListener("compositionend", () => { labelsComposing = false; });
labelsInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.stopPropagation();
  if (event.isComposing || labelsComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat) addDraftLabel();
});

function safeFocus(target) {
  if (!target || typeof target.focus !== "function") return;
  try {
    if (target.isConnected === false) return;
    target.focus();
  } catch {
    /* stale trigger: stay put */
  }
}

function renderSaved(posts) {
  savedList.textContent = "";
  savedEmpty.style.display = posts.length ? "none" : "block";
  for (const post of posts) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    // Stored values render as text; the source link is the only href.
    link.textContent = post.text;
    if (typeof post.url === "string" && post.url.startsWith("https://")) {
      link.href = post.url;
      link.target = "_blank";
      link.rel = "noreferrer";
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent =
      post.authorDisplayName + " (@" + post.authorHandle + ")" +
      (post.reason ? tmTranslate(" — Neden: ") + post.reason : "");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tm-btn tm-post-remove";
    let hasStoredPending = false;
    try {
      hasStoredPending = Boolean(window.sessionStorage.getItem("tm.pendingOp." + post.key));
    } catch { /* view-local only */ }
    remove.textContent = hasStoredPending ? tmTranslate("Sonucu doğrula") : tmTranslate("Hafızadan çıkar");
    remove.setAttribute(
      "aria-label",
      hasStoredPending
        ? tmTranslate("Bekleyen kaldırma işleminin sonucunu doğrula: @") + post.authorHandle
        : tmTranslate("Gönderiyi hafızadan çıkar (geri alınabilir): @") + post.authorHandle
    );
    remove.addEventListener("click", async () => {
      if (remove.disabled) return;
      remove.disabled = true;
      // The EXACT original operation (type, opId, payload,
      // baseVersion) survives re-renders and panel reopening;
      // a retry never mints a new opId or a fresh baseVersion.
      const storageKey = "tm.pendingOp." + post.key;
      let stored = null;
      try {
        stored = JSON.parse(window.sessionStorage.getItem(storageKey) || "null");
      } catch { /* view-local only */ }
      try {
        if (stored && stored.message) {
          await sideClient.retryExactOperation(stored);
        } else {
          await sideClient.removePost(
            { id: post.id, url: post.url, authorHandle: post.authorHandle },
            post.stateVersion || 0
          );
        }
        try {
          window.sessionStorage.removeItem(storageKey);
        } catch { /* ignore */ }
        await refreshLists();
      } catch (error) {
        if (error.code === "UNCERTAIN_OUTCOME") {
          const pending = sideClient.getPendingOperationFor
            ? sideClient.getPendingOperationFor("tm.posts.remove", post.id)
            : null;
          try {
            if (pending) window.sessionStorage.setItem(storageKey, JSON.stringify(pending));
          } catch { /* ignore */ }
          panelStatus.textContent = tmTranslate("Kaldırma sonucu belirsiz; tekrar denerseniz aynı işlem aynen kullanılır.");
        } else {
          try {
            window.sessionStorage.removeItem(storageKey);
          } catch { /* ignore */ }
          panelStatus.textContent = tmTranslate("Hafızadan çıkarılamadı: ") + tmTranslate(error.message);
        }
        remove.disabled = false;
      }
    });
    li.append(link, meta, remove);
    savedList.appendChild(li);
  }
}

function renderRemoved(posts) {
  const list = el("removed-list");
  const empty = el("removed-empty");
  list.textContent = "";
  empty.style.display = posts.length ? "none" : "block";
  for (const post of posts) {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = post.text + " ";
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = post.authorDisplayName + " (@" + post.authorHandle + ") ";
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "tm-btn tm-post-restore";
    undo.textContent = tmTranslate("Geri al");
    undo.setAttribute("aria-label", tmTranslate("Gönderiyi hafızaya geri al: @") + post.authorHandle);
    let hasStoredPending = false;
    try {
      hasStoredPending = Boolean(window.sessionStorage.getItem("tm.pendingOp." + post.key));
    } catch { /* view-local only */ }
    if (hasStoredPending) {
      undo.textContent = tmTranslate("Sonucu doğrula");
      undo.setAttribute("aria-label", tmTranslate("Bekleyen geri alma işleminin sonucunu doğrula: @") + post.authorHandle);
    }
    undo.addEventListener("click", async () => {
      undo.disabled = true;
      const storageKey = "tm.pendingOp." + post.key;
      let stored = null;
      try {
        stored = JSON.parse(window.sessionStorage.getItem(storageKey) || "null");
      } catch { /* view-local only */ }
      try {
        if (stored && stored.message) {
          await sideClient.retryExactOperation(stored);
        } else {
          await sideClient.restorePost(
            { id: post.id, url: post.url, authorHandle: post.authorHandle },
            post.stateVersion || 0
          );
        }
        try {
          window.sessionStorage.removeItem(storageKey);
        } catch { /* ignore */ }
        await refreshLists();
      } catch (error) {
        if (error.code === "UNCERTAIN_OUTCOME") {
          const pending = sideClient.getPendingOperationFor
            ? sideClient.getPendingOperationFor("tm.posts.restore", post.id)
            : null;
          try {
            if (pending) window.sessionStorage.setItem(storageKey, JSON.stringify(pending));
          } catch { /* ignore */ }
          panelStatus.textContent = tmTranslate("Geri alma sonucu belirsiz; tekrar denerseniz aynı işlem aynen kullanılır.");
        } else {
          // A definitive answer (including VERSION_CONFLICT)
          // clears the preserved pending record; only an
          // uncertain outcome keeps the exact message.
          try {
            window.sessionStorage.removeItem(storageKey);
          } catch { /* ignore */ }
          panelStatus.textContent = tmTranslate("Geri alınamadı: ") + tmTranslate(error.message);
        }
        undo.disabled = false;
      }
    });
    li.append(text, meta, undo);
    list.appendChild(li);
  }
}

function renderLabelFeed(active, posts, people) {
  if (labelFeed !== active) return;
  const matches = people.filter(person => savedLabels(person.labels).has(active.key));
  const list = el("label-feed-list");
  list.textContent = "";
  for (const person of matches) {
    let handle;
    try { handle = sideModel.normalizeHandle(person.handle); } catch { continue; }
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.textContent = "@" + handle;
    link.href = "https://www.threads.com/@" + encodeURIComponent(handle);
    link.target = "_blank"; link.rel = "noopener noreferrer";
    li.appendChild(link); list.appendChild(li);
  }
  el("label-feed-empty").hidden = Boolean(matches.length);
  el("label-feed-status").textContent = "";
  el("label-feed").setAttribute("aria-busy", "false");
  const matching = new Map();
  for (const person of people) {
    if (!savedLabels(person.labels).has(active.key)) continue;
    try { matching.set(sideModel.normalizeHandle(person.handle), person); } catch { /* invalid identity is not editable */ }
  }
  active.matchingPeople = matching;
  el("label-feed-edit").disabled = false;
  if (!el("label-feed-people").hidden) renderLabelPeople(active);
}

function renderLabelPeople(active) {
  if (labelFeed !== active) return;
  const list = el("label-feed-people");
  list.textContent = "";
  for (const [handle, person] of active.matchingPeople || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tm-btn";
    button.dataset.handle = handle;
    button.textContent = (person.displayName || "") + " @" + handle;
    button.addEventListener("click", () => {
      if (labelFeed !== active || !active.matchingPeople.has(handle)) return;
      void selectPerson(handle, findPersonRow(handle), active.key);
    });
    list.appendChild(button);
  }
  list.hidden = false;
  el("label-feed-status").textContent = list.children.length
    ? tmTranslate("Etiket üyeliğini düzenlemek istediğiniz kişiyi seçin. Renk aynı etiketi kullanan kişilerde ortaktır.")
    : tmTranslate("Bu etikete bağlı kayıtlı kişi yok.");
}

el("label-feed-show-posts").addEventListener("click", async () => {
  if (!labelFeed) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    const url = new URL(tab.url);
    if (!["www.threads.com", "www.threads.net", "threads.com", "threads.net"].includes(url.hostname)) throw new Error("wrong page");
    const result = await chrome.tabs.sendMessage(tab.id, { type: "tm.ui.openTagFeed", label: labelFeed.label });
    if (!result || !result.ok) throw new Error("not available");
    el("label-feed-status").textContent = tmTranslate("Etiket akışı Threads sayfasında açıldı.");
  } catch (_) { el("label-feed-status").textContent = tmTranslate("Önce Threads sekmesini açıp yenileyin."); }
});

el("label-feed-edit").addEventListener("click", () => {
  const active = labelFeed;
  if (!active || !active.matchingPeople) return;
  if (active.handle && active.matchingPeople.has(active.handle)) {
    void selectPerson(active.handle, findPersonRow(active.handle), active.key);
  } else {
    renderLabelPeople(active);
    safeFocus(el("label-feed-people").children[0] || el("label-feed-edit"));
  }
});

async function openLabelFeed(label, trigger) {
  preserveDraft();
  showView("people");
  const active = {
    label, key: sideModel.normalizeLabelKey(label), trigger,
    person: session, fromEditor: !editorEl.hidden,
    handle: trigger && trigger.dataset && trigger.dataset.personHandle
      ? trigger.dataset.personHandle : (!editorEl.hidden && session ? session.handle : null),
    readSeq: 1,
  };
  labelFeed = active;
  peopleList.hidden = true;
  peopleEmpty.style.display = "none";
  el("people-title").hidden = true;
  editorEl.hidden = true;
  el("label-feed").hidden = false;
  el("label-feed").setAttribute("aria-busy", "true");
  el("label-feed-title").textContent = label;
  el("label-feed-list").textContent = "";
  el("label-feed-empty").hidden = true;
  el("label-feed-people").hidden = true;
  el("label-feed-people").textContent = "";
  el("label-feed-edit").disabled = true;
  el("label-feed-status").textContent = tmTranslate("Yerel kayıtlar yükleniyor...");
  safeFocus(el("label-feed-title"));
  const readId = active.readSeq;
  try {
    const [posts, people] = await Promise.all([sideClient.listPosts(), sideClient.listPeople()]);
    if (labelFeed === active && active.readSeq === readId) renderLabelFeed(active, posts, people);
  } catch {
    if (labelFeed !== active || active.readSeq !== readId) return;
    el("label-feed").setAttribute("aria-busy", "false");
    el("label-feed-status").textContent = tmTranslate("Yerel gönderiler okunamadı. Geri dönüp yeniden deneyebilirsiniz.");
  }
}

function findLabelTrigger(handle, key) {
  for (const row of peopleList.children) {
    for (const group of row.children) {
      for (const chip of group.children || []) {
        if (chip.dataset && chip.dataset.personHandle === handle && chip.dataset.labelKey === key) return chip;
      }
    }
  }
  return null;
}

function closeLabelFeed(restoreFocus = true) {
  const active = labelFeed;
  if (!active) return;
  labelFeed = null;
  el("label-feed").hidden = true;
  const editorVisible = active.fromEditor && session === active.person;
  editorEl.hidden = !editorVisible;
  peopleList.hidden = editorVisible;
  el("people-title").hidden = editorVisible;
  peopleEmpty.style.display = !editorVisible && !peopleList.children.length ? "block" : "none";
  if (!restoreFocus) return;
  const currentTrigger = editorVisible
    ? (selectedColor && !el("label-color-controls").hidden ? el("label-feed-open") : labelsInput)
    : findLabelTrigger(active.handle, active.key);
  safeFocus(currentTrigger || (editorVisible ? labelsInput : el("people-title")));
}
el("label-feed-back").addEventListener("click", () => closeLabelFeed());
el("label-feed").addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  if (!el("label-feed-people").hidden) {
    el("label-feed-people").hidden = true;
    safeFocus(el("label-feed-edit"));
    return;
  }
  closeLabelFeed();
});

function renderPeople(people) {
  peopleByHandle = new Map(people.map((person) => [person.handle, person]));
  peopleList.textContent = "";
  const tags = new Map();
  for (const person of people) for (const [key, label] of savedLabels(person.labels)) {
    if (!tags.has(key)) tags.set(key, { key, label, people: [] });
    tags.get(key).people.push(person);
  }
  peopleEmpty.style.display = tags.size || peopleList.hidden ? "none" : "block";
  for (const tag of [...tags.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    const item = document.createElement("li"); item.className = "tag-row";
    const title = document.createElement("button"); title.type = "button"; title.className = "chip"; title.textContent = tag.label;
    title.dataset.labelKey = tag.key;
    title.addEventListener("click", () => void openLabelFeed(tag.label, title));
    paintLabel(title, labelStyles.get(tag.key)?.color || null);
    item.appendChild(title);
    const removeAll = document.createElement("button"); removeAll.type = "button"; removeAll.className = "tm-btn";
    removeAll.textContent = tmTranslate("Etiketi sil");
    removeAll.setAttribute("aria-label", tag.label + " — " + tmTranslate("Etiketi tüm kişilerden kaldır"));
    removeAll.addEventListener("click", async () => {
      if (!window.confirm(tmTranslate("Bu etiketi tüm kişilerden kaldırmak istiyor musunuz?"))) return;
      removeAll.disabled = true;
      let failed = 0;
      for (const person of tag.people) {
        try {
          const current = await sideClient.getPerson(person.handle);
          const labels = current.labels.filter(label => sideModel.normalizeLabelKey(label) !== tag.key);
          await sideClient.setLabels(person.handle, labels, current.versions.labels);
        } catch { failed += 1; }
      }
      panelStatus.textContent = failed ? tmTranslate("Bazı kişiler güncellenemedi; yeniden deneyin.") : tmTranslate("Etiket kişilerden kaldırıldı.");
      await refreshLists();
    });
    item.appendChild(removeAll);
    const group = document.createElement("div"); group.className = "person-labels";
    for (const person of tag.people) {
      const button = document.createElement("button"); button.type = "button"; button.className = "tm-btn";
      button.dataset.handle = person.handle; button.dataset.labelKey = tag.key;
      button.textContent = "@" + person.handle;
      button.addEventListener("click", () => void selectPerson(person.handle, button, tag.key));
      group.appendChild(button);
    }
    item.appendChild(group); peopleList.appendChild(item);
  }
}

let refreshSeq = 0;

async function refreshLists() {
  // Only the newest refresh may paint: a stale, delayed result
  // must not revert a newer list (or the editor built on it).
  const token = ++refreshSeq;
  // Remember a focused person row across the re-render.
  const activeEl = document.activeElement;
  const focusedHandle =
    activeEl && activeEl.dataset ? activeEl.dataset.handle || activeEl.dataset.personHandle : null;
  const focusedLabel = activeEl && activeEl.dataset && activeEl.dataset.labelKey;
  try {
    const [posts, people, removed, styles] = await Promise.all([
      sideClient.listPosts(),
      sideClient.listPeople(),
      typeof sideClient.listRemovedPosts === "function" ? sideClient.listRemovedPosts() : [],
      sideClient.listLabelStyles(),
    ]);
    if (token !== refreshSeq) return;
    // Decide BEFORE painting: clearing the list removes the
    // focused row and the browser drops focus to <body>, so any
    // equality check after the render can never hold. If the
    // user moved elsewhere during the read, we never steal.
    const restoreFocus =
      Boolean(focusedHandle) && document.activeElement === activeEl && !peopleList.hidden;
    for (const style of styles) observeLabelStyle(style);
    for (const style of labelStyles.values()) {
      const state = colorDrafts.get(style.labelKey);
      if (state && state.ready && !state.dirty && !state.busy && !state.pending && style.version >= state.version) {
        state.color = style.color;
        state.version = style.version;
      }
    }
    renderSaved(posts);
    renderRemoved(removed);
    renderPeople(people);
    if (labelFeed) {
      labelFeed.readSeq += 1;
      renderLabelFeed(labelFeed, posts, people);
    }
    const active = currentSession();
    const currentPerson = active && peopleByHandle.get(active.handle);
    if (currentPerson) updateColorLabels(active, currentPerson.labels);
    if (restoreFocus) {
      const row = (focusedLabel && findLabelTrigger(focusedHandle, focusedLabel)) || findPersonRow(focusedHandle);
      if (row) safeFocus(row);
      else safeFocus(el("people-title"));
    }
  } catch (error) {
    if (token === refreshSeq) {
      panelStatus.textContent = tmTranslate("Veri okunamadı: ") + tmTranslate(error.message);
    }
  }
}

/* Accessible two-view tabs; the editor replaces the people list. */
let watchReadSeq = 0;
async function refreshFollowUps() {
  const list = el("watch-list");
  const empty = el("watch-empty");
  const seq = ++watchReadSeq;
  try {
    const watches = await sideClient.listWatches();
    if (seq !== watchReadSeq) return;
    list.textContent = "";
    empty.hidden = watches.length > 0;
    empty.textContent = tmTranslate("Henüz takip listenizde bir olay yok.");
    const autoData = await chrome.storage.local.get("tm.followups.state.v1");
    const autoStates = autoData["tm.followups.state.v1"] || {};
    const setup = await sideClient.settingsStatus().catch(() => null);
    if (seq !== watchReadSeq) return;
    for (const watch of watches) {
      const item = document.createElement("li");
      const title = document.createElement("a");
      let safeUrl = null;
      try {
        const url = new URL(watch.url);
        if (url.protocol === "https:" && ["www.threads.com", "www.threads.net"].includes(url.hostname) && !url.username && !url.password) safeUrl = url.href;
      } catch { /* malformed stored link remains inert */ }
      title.textContent = watch.authorDisplayName || "@" + watch.authorHandle;
      if (safeUrl) { title.href = safeUrl; title.target = "_blank"; title.rel = "noopener noreferrer"; }
      item.appendChild(title);
      const note = document.createElement("p"); note.className = "meta";
      note.textContent = watch.draft || (watch.followUp ? (watch.followUp.mode === "custom" ? watch.followUp.customPrompt : watch.followUp.mode === "until-end" ? tmTranslate("Olay sonuna kadar gelişmeler") : tmTranslate("Sonuç ve sonrasındaki yorumlar")) : tmTranslate("Yerel ilgi notları"));
      item.appendChild(note);
      if (watch.followUp && watch.followUp.durationDays) {
        const duration = document.createElement("p"); duration.className = "status";
        duration.textContent = String(watch.followUp.durationDays) + tmTranslate(" gün tercihi");
        item.appendChild(duration);
      }
      if (watch.followUp && watch.followUp.automatic) {
        const state = autoStates[watch.postKey];
        const detail = document.createElement("p"); detail.className = "status";
        detail.style.whiteSpace = "pre-line";
        const expired = Date.now() >= watch.followUp.scheduledAt + watch.followUp.durationDays * 86400000;
        const current = state && state.scheduledAt === watch.followUp.scheduledAt ? state : null;
        const fmt = value => value ? new Date(value).toLocaleString(globalThis.ThreadsMemoryI18n?.language === "tr" ? "tr-TR" : "en-US") : tmTranslate("Henüz yapılmadı");
        const status = expired ? tmTranslate("Otomatik takip süresi doldu.") : !setup || !setup.hasSessionKey || !setup.permissionGranted ? tmTranslate("Duraklatıldı: API anahtarı veya izin eksik.") : current && current.status === "checking" ? tmTranslate("Kontrol sürüyor.") : current && current.status === "error" ? tmTranslate("Son kontrol başarısız oldu.") : tmTranslate("Otomatik takip açık.");
        detail.textContent = status + "\n" + tmTranslate("Son başarılı kontrol: ") + fmt(current && current.checkedAt);
        if (current && current.lastAttemptAt) detail.textContent += "\n" + tmTranslate("Son deneme: ") + fmt(current.lastAttemptAt);
        if (!expired && setup && setup.hasSessionKey && setup.permissionGranted) detail.textContent += "\n" + tmTranslate("Sonraki kontrol en erken: ") + fmt(current && current.nextAt || watch.followUp.scheduledAt) + " " + tmTranslate("(tarayıcı geciktirebilir)");
        if (current && current.change) {
          const changes = { baseline: "İlk kontrol kaydedildi; karşılaştırma sonraki kontrolde yapılacak.", new: "Muse olası yeni gelişme bildirdi; doğrulayın.", none: "Muse yeni gelişme bulmadı.", uncertain: "Değişiklik sonucu belirsiz." };
          detail.textContent += "\n" + tmTranslate(changes[current.change] || "Değişiklik sonucu belirsiz.");
        }
        if (current && current.answer) detail.textContent += "\n\n" + current.answer;
        item.appendChild(detail);
      }
      list.appendChild(item);
    }
  } catch (error) {
    if (seq !== watchReadSeq) return;
    empty.hidden = false;
    empty.textContent = tmTranslate("Takip taslağı yüklenemedi: ") + tmTranslate(error.message || "bilinmeyen hata");
  }
}

function showView(name) {
  closeLabelFeed(false);
  // Tabs stay visible in Settings; selecting one must also reveal its view.
  if (!settingsView.hidden) hideSettings();
  const memory = name === "memory";
  el("panel-memory").hidden = !memory;
  el("panel-people").hidden = memory;
  const memoryTab = el("tab-memory");
  const peopleTab = el("tab-people");
  memoryTab.setAttribute("aria-selected", memory ? "true" : "false");
  peopleTab.setAttribute("aria-selected", memory ? "false" : "true");
  memoryTab.tabIndex = memory ? 0 : -1;
  peopleTab.tabIndex = memory ? -1 : 0;
  if (memory) void refreshFollowUps();
}
el("tab-memory").addEventListener("click", () => showView("memory"));
el("tab-people").addEventListener("click", () => showView("people"));
for (const [tab, name] of [[el("tab-memory"), "memory"], [el("tab-people"), "people"]]) {
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = name === "memory" ? "people" : "memory";
    showView(next);
    el(next === "memory" ? "tab-memory" : "tab-people").focus();
  });
}

async function selectPerson(handle, trigger, preferredColorKey) {
  preserveDraft();
  showView("people");
  // The editor replaces the list inside the people view.
  peopleList.hidden = true;
  peopleEmpty.style.display = "none";
  el("people-title").hidden = true;
  const id = ++sessionSeq;
  const next = {
    id,
    handle,
    state: "loading",
    labelsBaseVersion: 0,
    notesBaseVersion: 0,
    labelsDirty: false,
    labelsDraft: [],
    labelsPending: null,
    preferredColorKey: preferredColorKey || null,
    noteDirty: false,
    labelsBusy: false,
    noteBusy: false,
    labelsPendingRetry: false,
    notePendingRetry: false,
    trigger: trigger || null,
  };
  session = next;
  selectedColor = null;
  el("label-color-controls").hidden = true;
  el("label-color-empty").hidden = true;
  el("label-color-status").textContent = "";
  editorEl.hidden = false;
  editorTitle.textContent = "@" + handle + tmTranslate(" kişi düzenleyici");
  editorPerson.textContent = tmTranslate("Kişi: @") + handle;
  labelsInput.value = "";
  labelsComposing = false;
  labelsDraftEl.textContent = "";
  noteText.value = "";
  labelsInput.disabled = true;
  noteText.disabled = true;
  labelsSave.disabled = true;
  noteSave.disabled = true;
  labelsStatus.textContent = tmTranslate("Yükleniyor...");
  noteStatus.textContent = "";
  try {
    const view = await sideClient.getPerson(handle);
    if (!session || session.id !== id) return; // switched meanwhile
    next.labelsBaseVersion = view.versions.labels;
    next.notesBaseVersion = view.versions.notes;
    next.labelsDraft = [...view.labels];
    noteText.value = view.note;
    // Field-level draft restore (own version per field).
    const draft = readDrafts()[handle];
    if (draft) {
      if (draft.labelsDirty) {
        // Only old view-local drafts used comma-separated strings.
        // Stored labels and all new drafts keep their exact string[] values.
        next.labelsDraft = Array.isArray(draft.labels)
          ? draft.labels.filter((label) => typeof label === "string")
          : typeof draft.labels === "string" ? draft.labels.split(",").map((label) => label.trim()).filter(Boolean) : [...view.labels];
        labelsInput.value = Array.isArray(draft.labels) && typeof draft.labelsInput === "string" ? draft.labelsInput : "";
        next.labelsDirty = true;
        next.labelsBaseVersion = draft.labelsBaseVersion;
      }
      const pending = draft.labelsPending;
      if (pending && pending.message && pending.message.type === "tm.person.setLabels" &&
          sideModel.normalizeHandle(pending.message.handle) === handle) {
        next.labelsPending = pending;
        next.labelsPendingRetry = true;
      }
      if (draft.noteDirty) {
        noteText.value = draft.note;
        next.noteDirty = true;
        next.notesBaseVersion = draft.notesBaseVersion;
      }
    }
    next.state = "ready";
    renderLabelsDraft(next);
    updateColorLabels(next, view.labels);
    labelsInput.disabled = false;
    noteText.disabled = false;
    labelsSave.disabled = false;
    noteSave.disabled = false;
    labelsStatus.textContent = next.labelsPending ? tmTranslate("Etiket kaydının sonucu belirsiz; aynı işlemi doğrulamak için kaydedin.")
      : draft && draft.labelsDirty ? tmTranslate("Kaydedilmemiş etiket taslağınız korundu.") : "";
    noteStatus.textContent = draft && draft.noteDirty ? tmTranslate("Kaydedilmemiş not taslağınız korundu.") : "";
    labelsInput.focus();
  } catch (error) {
    if (!session || session.id !== id) return;
    next.state = "error";
    labelsStatus.textContent = tmTranslate("Yüklenemedi: ") + tmTranslate(error.message);
  }
}

function currentSession() {
  return session && session.state === "ready" ? session : null;
}

async function saveLabels() {
  const active = currentSession();
  if (!active || active.labelsBusy) return;
  active.labelsBusy = true;
  labelsSave.disabled = true;
  const sent = [...active.labelsDraft];
  try {
    const pending = active.labelsPending || (sideClient.getPendingOperationFor
      ? sideClient.getPendingOperationFor("tm.person.setLabels", active.handle)
      : null);
    const useRetry = Boolean(pending);
    const opId = useRetry ? pending.opId : window.ThreadsMemoryClient.generateOpId();
    active.labelsPending = pending || {
      key: "tm.person.setLabels:" + active.handle,
      type: "tm.person.setLabels", opId,
      message: { type: "tm.person.setLabels", opId, handle: active.handle, labels: sent, baseVersion: active.labelsBaseVersion },
    };
    // Preserve the exact message before dispatch, including when the view
    // closes while the worker response is still in flight.
    preserveDraft();
    const effectiveSent = active.labelsPending.message.labels;
    const result = useRetry
      ? await sideClient.retryExactOperation(active.labelsPending)
      : await sideClient.setLabels(active.handle, sent, active.labelsBaseVersion, { opId });
    if (session !== active) return;
    active.labelsPendingRetry = false;
    active.labelsPending = null;
    active.labelsBaseVersion = result.version;
    if (result.deduplicated && JSON.stringify(result.value) !== JSON.stringify(effectiveSent)) {
      active.labelsDirty = true;
      labelsStatus.textContent = tmTranslate("Başka görünümde daha yeni etiketler var; taslağınız korundu.");
      preserveDraft();
      return;
    }
    // Dirty compares the current draft with what was actually
    // accepted (effectiveSent), never with the text at retry time.
    active.labelsDirty =
      JSON.stringify(active.labelsDraft) !== JSON.stringify(effectiveSent) || Boolean(labelsInput.value);
    labelsStatus.textContent = active.labelsDirty
      ? labelsInput.value ? tmTranslate("Etiketler kaydedildi; girişteki metni Enter ile taslağa ekleyebilirsiniz.")
        : tmTranslate("Etiketler kaydedildi — yeni düzenlemeleriniz henüz kaydedilmedi.")
      : tmTranslate("Etiketler kaydedildi.");
    preserveDraft();
    await refreshLists();
  } catch (error) {
    if (session !== active) return;
    if (error.code === "UNCERTAIN_OUTCOME") {
      active.labelsPendingRetry = true;
      labelsStatus.textContent = tmTranslate("Sonuç belirsiz; taslağınız duruyor. Tekrar denemek için Kaydet'e basın.");
    } else {
      active.labelsPending = null;
      active.labelsPendingRetry = false;
      if (error.code === "VERSION_CONFLICT") {
        if (error.details && Number.isInteger(error.details.currentVersion)) {
          active.labelsBaseVersion = error.details.currentVersion;
        }
        labelsStatus.textContent = tmTranslate("Çatışma: etiketler başka görünümde değişti. Taslağınız duruyor; bilinçli olarak üzerine yazmak için tekrar kaydedin.");
      } else labelsStatus.textContent = tmTranslate("Kaydedilemedi: ") + tmTranslate(error.message);
    }
    preserveDraft();
  } finally {
    active.labelsBusy = false;
    if (session === active) labelsSave.disabled = active.state !== "ready";
  }
}

async function saveNote() {
  const active = currentSession();
  if (!active || active.noteBusy) return;
  active.noteBusy = true;
  noteSave.disabled = true;
  const sent = noteText.value;
  try {
    const pending = sideClient.getPendingOperationFor
      ? sideClient.getPendingOperationFor("tm.person.setNote", active.handle)
      : null;
    const useRetry = Boolean(active.notePendingRetry && pending);
    const effectiveSent = useRetry ? pending.message.note : sent;
    const result = useRetry
      ? await sideClient.retryPendingOperation(pending.key)
      : await sideClient.setNote(active.handle, sent, active.notesBaseVersion);
    if (session !== active) return;
    active.notePendingRetry = false;
    active.notesBaseVersion = result.version;
    if (result.deduplicated && result.value !== effectiveSent) {
      active.noteDirty = true;
      noteStatus.textContent = tmTranslate("Başka görünümde daha yeni bir not var; taslağınız korundu.");
      return;
    }
    active.noteDirty = noteText.value !== effectiveSent;
    noteStatus.textContent = active.noteDirty
      ? tmTranslate("Not kaydedildi — yeni düzenlemeleriniz henüz kaydedilmedi.")
      : tmTranslate("Not kaydedildi.");
    preserveDraft();
    await refreshLists();
  } catch (error) {
    if (session !== active) return;
    if (error.code === "UNCERTAIN_OUTCOME") {
      active.notePendingRetry = true;
      noteStatus.textContent = tmTranslate("Sonuç belirsiz; taslağınız duruyor. Tekrar denemek için Kaydet'e basın.");
    } else if (error.code === "VERSION_CONFLICT") {
      if (error.details && Number.isInteger(error.details.currentVersion)) {
        active.notesBaseVersion = error.details.currentVersion;
      }
      noteStatus.textContent = tmTranslate("Çatışma: not başka görünümde değişti. Taslağınız duruyor; bilinçli olarak üzerine yazmak için tekrar kaydedin.");
    } else {
      noteStatus.textContent = tmTranslate("Not kaydedilemedi: ") + tmTranslate(error.message);
    }
  } finally {
    active.noteBusy = false;
    if (session === active) noteSave.disabled = active.state !== "ready";
  }
}

labelsInput.addEventListener("input", () => {
  if (currentSession()) {
    session.labelsDirty = true;
    preserveDraft();
  }
});
noteText.addEventListener("input", () => {
  if (session) {
    session.noteDirty = true;
    preserveDraft();
  }
});
labelsSave.addEventListener("click", () => void saveLabels());
noteSave.addEventListener("click", () => void saveNote());
function findPersonRow(handle) {
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.tagName === "BUTTON" && child.dataset && child.dataset.handle === handle) return child;
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(peopleList);
}

el("back").addEventListener("click", () => {
  const handle = session && session.handle;
  preserveDraft();
  session = null;
  selectedColor = null;
  sessionSeq += 1;
  editorEl.hidden = true;
  // The list comes back; focus its CURRENT row for this handle
  // (rows are re-created by refreshes, so a captured trigger
  // element may be disconnected), else the section heading.
  peopleList.hidden = false;
  el("people-title").hidden = false;
  const row = handle ? findPersonRow(handle) : null;
  if (row) safeFocus(row);
  else safeFocus(el("people-title"));
  void refreshLists();
});

/* Storage notifications refresh lists; dirty drafts are kept. */
let personReadSeq = 0;
if (window.ThreadsMemoryClient && typeof window.ThreadsMemoryClient.onStorageChanged === "function") {
  window.ThreadsMemoryClient.onStorageChanged(chrome, "tm.v2.", async () => {
    await refreshLists();
    if (!el("panel-memory").hidden) void refreshFollowUps();
    const active = currentSession();
    if (!active) return;
    // Read generation + per-field monotonic versions: an older
    // read that returns after a newer one (or after a successful
    // save) must never move a field or its baseVersion backwards.
    const readId = ++personReadSeq;
    try {
      const view = await sideClient.getPerson(active.handle);
      if (session !== active || readId !== personReadSeq) return;
      if (
        !active.labelsDirty && !active.labelsPending &&
        !active.labelsBusy &&
        view.versions.labels >= active.labelsBaseVersion
      ) {
        active.labelsDraft = [...view.labels];
        labelsInput.value = "";
        active.labelsBaseVersion = view.versions.labels;
        renderLabelsDraft(active);
      }
      if (
        !active.noteDirty &&
        !active.noteBusy &&
        view.versions.notes >= active.notesBaseVersion
      ) {
        noteText.value = view.note;
        active.notesBaseVersion = view.versions.notes;
      }
    } catch {
      /* keep current editor content */
    }
  });
}

/* ---- Settings (local BYOK) ----
 * The user's own key is sent to the service worker and
 * kept in the extension-origin IndexedDB. It
 * is cleared from this field immediately after saving and is
 * never read back into the UI. */
const settingsView = el("settings-view");
const settingsMain = el("main");
el("settings-provider").disabled = true;
el("settings-provider").readOnly = true;
el("settings-provider").value = tmTranslate("Meta Muse (varsayılan sağlayıcı)");
el("settings-api-key").disabled = false;
el("settings-api-key").value = "";

async function refreshSettingsState() {
  try {
    const status = await sideClient.settingsStatus();
    el("settings-key-state").textContent =
      tmTranslate("API anahtarı: ") + (status.hasSessionKey ? tmTranslate("kayıtlı (gösterilmez)") : tmTranslate("yok"));
    el("settings-permission-state").textContent =
      tmTranslate("api.meta.ai izni: ") + (status.permissionGranted ? tmTranslate("verildi") : tmTranslate("yok"));
  } catch {
    el("settings-key-state").textContent = tmTranslate("API anahtarı: bilinmiyor");
  }
}

el("settings-open").addEventListener("click", () => {
  closeLabelFeed(false);
  preserveDraft();
  settingsMain.hidden = true;
  settingsView.hidden = false;
  void refreshSettingsState();
  el("settings-back").focus();
});
function hideSettings() {
  settingsView.hidden = true;
  settingsMain.hidden = false;
  el("settings-api-key").value = "";
  el("settings-status").textContent = "";
}
el("settings-back").addEventListener("click", () => {
  hideSettings();
  // Returning never touches an unsaved person draft: the editor
  // DOM and session were left exactly as they were.
  safeFocus(el("settings-open"));
});
el("settings-save-key").addEventListener("click", async () => {
  const input = el("settings-api-key");
  const apiKey = input.value.trim();
  if (!apiKey) {
    el("settings-status").textContent = tmTranslate("Önce anahtarınızı girin.");
    return;
  }
  try {
    await sideClient.saveSessionKey(apiKey);
    input.value = "";
    el("settings-status").textContent = tmTranslate("API anahtarı kaydedildi; anahtar bir daha gösterilmez.");
    await refreshSettingsState();
  } catch (error) {
    input.value = "";
    el("settings-status").textContent = tmTranslate("Anahtar kaydedilemedi.");
  }
});
el("settings-clear-key").addEventListener("click", async () => {
  try {
    await sideClient.clearSessionKey();
    el("settings-api-key").value = "";
    el("settings-status").textContent = tmTranslate("API anahtarı kaldırıldı.");
    await refreshSettingsState();
  } catch (error) {
    el("settings-status").textContent = tmTranslate("Anahtar kaldırılamadı.");
  }
});
el("settings-permission").addEventListener("click", async () => {
  // The optional api.meta.ai permission is requested ONLY from
  // this trusted page, on this explicit user gesture.
  try {
    const granted = await chrome.permissions.request({ origins: ["https://api.meta.ai/*"] });
    el("settings-status").textContent = granted ? tmTranslate("api.meta.ai izni verildi.") : tmTranslate("api.meta.ai izni verilmedi.");
    await refreshSettingsState();
  } catch (error) {
    el("settings-status").textContent = tmTranslate("İzin istenemedi.");
  }
});

function refreshLanguageDependentUI() {
  el("settings-provider").value = tmTranslate("Meta Muse (varsayılan sağlayıcı)");
  for (const button of el("label-color-presets").children) {
    const preset = sideModel.LABEL_COLOR_PRESETS.find((item) => item.color === button.dataset.color);
    if (preset) button.textContent = tmTranslate(preset.name);
  }
  if (!settingsView.hidden) void refreshSettingsState();
  void refreshLists();
  if (!el("panel-memory").hidden) void refreshFollowUps();
}
if (globalThis.ThreadsMemoryI18n) {
  void globalThis.ThreadsMemoryI18n.ready.then(() => { showView("people"); refreshLanguageDependentUI(); });
  if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["tm.ui.language"]) refreshLanguageDependentUI();
    if (area === "local" && changes["tm.followups.state.v1"]) void refreshFollowUps();
  });
} else { showView("people"); refreshLists(); }

const clearDataButton = el("settings-clear-all");
clearDataButton.addEventListener("click", async () => {
  const message = tmTranslate("Tüm etiketler, notlar, takipler, ayarlar ve API anahtarı bu cihazdan kalıcı olarak silinecek. Bu işlem geri alınamaz. Devam edilsin mi?");
  if (!window.confirm(message)) return;
  clearDataButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "tm.settings.clearAll" });
    if (!response || !response.ok) throw new Error("clear failed");
    window.localStorage.clear(); window.sessionStorage.clear();
    session = null; sessionSeq += 1; labelStyles.clear(); colorDrafts.clear(); selectedColor = null;
    editorEl.hidden = true; peopleList.hidden = false; el("people-title").hidden = false;
    el("settings-status").textContent = tmTranslate("Tüm yerel veriler silindi. Açık Threads sayfalarını yenileyin.");
    await refreshLists(); await refreshFollowUps(); await refreshSettingsState();
  } catch (_) { el("settings-status").textContent = tmTranslate("Veriler silinemedi. Yeniden deneyin."); }
  finally { clearDataButton.disabled = false; }
});
