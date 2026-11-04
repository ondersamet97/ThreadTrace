"use strict";

/*
 * Threads Memory - pure local data model.
 * No network, no model/API calls, no Threads "Saved" sync.
 * Notes and labels live in separate maps on purpose: editing one
 * must never overwrite the other.
 */

const SCHEMA_VERSION = 1;

function createEmptyState() {
  return {
    version: SCHEMA_VERSION,
    posts: {}, // postKey -> saved post
    people: {}, // personKey -> { key, handle, displayName, createdAt, updatedAt }
    labels: {}, // personKey -> string[]   (independent from notes)
    notes: {}, // personKey -> string     (independent from labels)
  };
}

function normalizeHandle(handle) {
  if (typeof handle !== "string") {
    throw new TypeError("handle must be a string");
  }
  const cleaned = handle.trim().replace(/^@+/, "").toLowerCase();
  if (!cleaned) {
    throw new TypeError("handle must not be empty");
  }
  if (/\s/.test(cleaned)) {
    throw new TypeError("handle must not contain whitespace");
  }
  return cleaned;
}

function personKeyFor(handle) {
  return "threads:" + normalizeHandle(handle);
}

function normalizePostUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    throw new TypeError("post url must be a non-empty string");
  }
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/[?#].*$/, "").replace(/\/$/, "");
  }
}

function cleanPostId(id) {
  if (id === undefined || id === null) return "";
  return String(id).trim();
}

function postKeyFor(post) {
  const id = cleanPostId(post && post.id);
  if (id) return "post:" + id;
  return "url:" + normalizePostUrl(post && post.url);
}

function normalizeLabels(labels) {
  if (labels === undefined || labels === null) return [];
  if (!Array.isArray(labels)) {
    throw new TypeError("labels must be an array of strings");
  }
  const seen = new Set();
  const out = [];
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const label = raw.trim();
    if (!label) continue;
    const dedupeKey = label.toLocaleLowerCase("tr-TR");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(label);
  }
  return out;
}

function normalizeLabelKey(label) {
  if (typeof label !== "string" || label.length > 64 || !label.trim()) {
    throw new TypeError("label must contain 1 to 64 characters");
  }
  return label.trim().toLocaleLowerCase("tr-TR");
}

function normalizeLabelColor(color) {
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new TypeError("color must be a six-digit hex color (#rrggbb)");
  }
  return color.toLowerCase();
}

/** Pick whichever of black/white has the higher WCAG contrast ratio. */
function labelTextColor(color) {
  const hex = normalizeLabelColor(color);
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}

const LABEL_COLOR_PRESETS = Object.freeze([
  { name: "Kırmızı", color: "#b91c1c" },
  { name: "Turuncu", color: "#c2410c" },
  { name: "Sarı", color: "#9a6700" },
  { name: "Yeşil", color: "#15803d" },
  { name: "Mavi", color: "#1d4ed8" },
  { name: "Mor", color: "#7e22ce" },
].map((preset) => Object.freeze(preset)));

/** Local exact-label filter only; never infer a topic from post text. */
function filterLabelPosts(label, people, posts) {
  let labelKey;
  try { labelKey = normalizeLabelKey(label); } catch { return []; }
  const handles = new Set();
  for (const person of Array.isArray(people) ? people : []) {
    try {
      if (!person || !Array.isArray(person.labels)) continue;
      if (!person.labels.some((value) => {
        try { return normalizeLabelKey(value) === labelKey; } catch { return false; }
      })) continue;
      handles.add(normalizeHandle(person.handle));
    } catch { /* Invalid person records cannot match. */ }
  }
  const seen = new Set();
  const result = [];
  for (const post of Array.isArray(posts) ? posts : []) {
    try {
      if (!post || [post.memoryStatus, post.status, post.stateStatus].includes("removed")) continue;
      const candidate = validatePostInput(post);
      if (!handles.has(candidate.authorHandle)) continue;
      // validatePostInput supports legacy fixtures; this clickable
      // filter additionally enforces the real Threads URL identity.
      const url = new URL(candidate.url);
      if (url.protocol !== "https:" || !["www.threads.net", "www.threads.com"].includes(url.hostname)) continue;
      if (url.username || url.password || url.port) continue;
      const match = /^\/@([^/]+)\/post\/([^/]+)\/?$/.exec(url.pathname);
      if (!match) continue;
      const handle = normalizeHandle(decodeURIComponent(match[1]));
      const id = decodeURIComponent(match[2]);
      if (handle !== candidate.authorHandle || !id || /[\s/]/.test(id)) continue;
      if (candidate.id && candidate.id !== id) continue;
      candidate.id = id;
      const key = postKeyFor(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...post, ...candidate, key });
    } catch { /* Unverifiable links/identities are excluded. */ }
  }
  return result;
}

/** Optional local follow-up preferences; no scheduling or research is implied. */
function normalizeFollowUp(followUp) {
  if (followUp === undefined) return undefined;
  if (!followUp || typeof followUp !== "object" || Array.isArray(followUp)) {
    throw new TypeError("followUp must be an object");
  }
  if (Object.keys(followUp).some((key) => key !== "mode" && key !== "durationDays" && key !== "customPrompt" && key !== "automatic" && key !== "eventText" && key !== "scheduledAt")) {
    throw new TypeError("followUp contains an unknown field");
  }
  if (!["until-end", "result-and-commentary", "custom"].includes(followUp.mode)) {
    throw new TypeError("followUp.mode is invalid");
  }
  if (![1, 7, 30].includes(followUp.durationDays)) {
    throw new TypeError("followUp.durationDays must be 1, 7 or 30");
  }
  const autoFields = {};
  if (followUp.automatic !== undefined) {
    if (typeof followUp.automatic !== "boolean") throw new TypeError("automatic must be boolean");
    autoFields.automatic = followUp.automatic;
    if (followUp.automatic) {
      if (typeof followUp.eventText !== "string" || !followUp.eventText.trim() || followUp.eventText.length > 2000) throw new TypeError("eventText must be 1 to 2000 characters");
      if (!Number.isFinite(followUp.scheduledAt) || followUp.scheduledAt <= 0) throw new TypeError("scheduledAt is invalid");
      autoFields.eventText = followUp.eventText.trim();
      autoFields.scheduledAt = followUp.scheduledAt;
    }
  }
  if (followUp.mode === "custom") {
    if (typeof followUp.customPrompt !== "string" || !followUp.customPrompt.trim() || followUp.customPrompt.length > 500) throw new TypeError("customPrompt must be 1 to 500 characters");
    return { mode: followUp.mode, durationDays: followUp.durationDays, customPrompt: followUp.customPrompt.trim(), ...autoFields };
  }
  if (followUp.customPrompt !== undefined) throw new TypeError("customPrompt requires custom mode");
  return { mode: followUp.mode, durationDays: followUp.durationDays, ...autoFields };
}

function validatePostInput(post) {
  if (!post || typeof post !== "object") {
    throw new TypeError("post must be an object");
  }
  const url = normalizePostUrl(post.url);
  // A post must be bound to its real author; refuse to save without one.
  const authorHandle = normalizeHandle(post.authorHandle);
  const text = typeof post.text === "string" ? post.text.trim() : "";
  if (!text) {
    throw new TypeError("post text (visible content) must be a non-empty string");
  }
  return {
    id: cleanPostId(post.id),
    url,
    authorHandle,
    authorDisplayName:
      typeof post.authorDisplayName === "string" && post.authorDisplayName.trim()
        ? post.authorDisplayName.trim()
        : "@" + authorHandle,
    text,
  };
}

function findDuplicatePost(state, candidate) {
  const candidateKey = postKeyFor(candidate);
  if (state.posts[candidateKey]) return state.posts[candidateKey];
  for (const existing of Object.values(state.posts)) {
    if (candidate.id && existing.id && existing.id === candidate.id) return existing;
    if (existing.url === candidate.url) return existing;
  }
  return null;
}

function savePostToState(state, post, nowIso) {
  const candidate = validatePostInput(post);
  const duplicate = findDuplicatePost(state, candidate);
  if (duplicate) {
    return { saved: false, reason: "duplicate", post: duplicate };
  }
  const key = postKeyFor(candidate);
  const record = {
    key,
    ...candidate,
    authorPersonKey: personKeyFor(candidate.authorHandle),
    savedAt: nowIso,
  };
  state.posts[key] = record;
  ensurePersonInState(state, candidate.authorHandle, candidate.authorDisplayName, nowIso);
  return { saved: true, post: record };
}

function ensurePersonInState(state, handle, displayName, nowIso) {
  const normalized = normalizeHandle(handle);
  const key = personKeyFor(normalized);
  const existing = state.people[key];
  if (existing) {
    if (
      typeof displayName === "string" &&
      displayName.trim() &&
      displayName.trim() !== existing.displayName
    ) {
      existing.displayName = displayName.trim();
      existing.updatedAt = nowIso;
    }
    return existing;
  }
  const person = {
    key,
    handle: normalized,
    displayName:
      typeof displayName === "string" && displayName.trim()
        ? displayName.trim()
        : "@" + normalized,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  state.people[key] = person;
  if (!(key in state.labels)) state.labels[key] = [];
  if (!(key in state.notes)) state.notes[key] = "";
  return person;
}

/** Labels only. Never touches state.notes. */
function setLabelsInState(state, handle, labels, nowIso) {
  const person = ensurePersonInState(state, handle, undefined, nowIso);
  state.labels[person.key] = normalizeLabels(labels);
  person.updatedAt = nowIso;
  return [...state.labels[person.key]];
}

/** Note text only. Never touches state.labels. */
function setNoteInState(state, handle, note, nowIso) {
  const person = ensurePersonInState(state, handle, undefined, nowIso);
  state.notes[person.key] = typeof note === "string" ? note : "";
  person.updatedAt = nowIso;
  return state.notes[person.key];
}

function getPersonViewFromState(state, handle) {
  const key = personKeyFor(handle);
  const person = state.people[key] || null;
  return {
    person,
    labels: person ? [...(state.labels[key] || [])] : [],
    note: person ? state.notes[key] || "" : "",
  };
}

function serializeState(state) {
  return JSON.stringify(state);
}

function deserializeState(json) {
  if (!json) return createEmptyState();
  const parsed = typeof json === "string" ? JSON.parse(json) : json;
  const state = createEmptyState();
  if (parsed && typeof parsed === "object") {
    if (parsed.posts && typeof parsed.posts === "object") state.posts = parsed.posts;
    if (parsed.people && typeof parsed.people === "object") state.people = parsed.people;
    if (parsed.labels && typeof parsed.labels === "object") state.labels = parsed.labels;
    if (parsed.notes && typeof parsed.notes === "object") state.notes = parsed.notes;
  }
  return state;
}

const ThreadsMemoryModelApi = {
  SCHEMA_VERSION,
  createEmptyState,
  normalizeHandle,
  personKeyFor,
  normalizePostUrl,
  postKeyFor,
  normalizeLabels,
  normalizeLabelKey,
  normalizeLabelColor,
  labelTextColor,
  LABEL_COLOR_PRESETS,
  filterLabelPosts,
  normalizeFollowUp,
  validatePostInput,
  findDuplicatePost,
  savePostToState,
  ensurePersonInState,
  setLabelsInState,
  setNoteInState,
  getPersonViewFromState,
  serializeState,
  deserializeState,
};

if (typeof module !== "undefined" && module.exports) module.exports = ThreadsMemoryModelApi;
if (typeof window !== "undefined") window.ThreadsMemoryModel = ThreadsMemoryModelApi;
if (typeof self !== "undefined") self.ThreadsMemoryModel = ThreadsMemoryModelApi;
