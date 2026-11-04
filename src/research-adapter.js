"use strict";

/*
 * Research result boundary for the one-shot "Bu ne olmuş?" service.
 *
 * research-service.js performs the direct BYOK request in the worker.
 * This module parses evidence only; it never reads a key or calls a
 * provider. The disconnected/server factories below remain legacy
 * contracts and do not start a server or background monitoring.
 *
 * This module deliberately does NOT ship a working server factory.
 * It defines:
 *  - legacy disconnected and unimplemented server contracts;
 *  - the direct Responses parser used by the worker service;
 *  - validateSearchEvidence(), which refuses to present anything
 *    as researched unless the payload carries auditable search
 *    evidence (per official Muse search-grounding docs: a tool
 *    being enabled is not proof of a real search — web_search_call
 *    and url_citation evidence must be inspected, and event or
 *    publication dates are not guaranteed).
 *
 * dedupeTimelineEvents removes only identical findings: canonical
 * URL + normalized title + event date + publication date + kind.
 * Different developments from one source and separate sources for
 * the same development are preserved; this is not semantic dedup.
 */

function canonicalUrlKey(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key) || key === "fbclid" || key === "gclid") parsed.searchParams.delete(key);
    }
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return String(url || "").trim();
  }
}

function normalizeTitle(title) {
  return String(title || "").trim().toLocaleLowerCase("tr-TR").replace(/\s+/g, " ");
}

/** Exact finding duplicates only; known event dates sort first, unknown dates last. */
function dedupeTimelineEvents(events) {
  const seen = new Set();
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.title !== "string" || !event.title.trim()) continue;
    if (typeof event.url !== "string" || !/^https:\/\//.test(event.url)) continue;
    const key = JSON.stringify([
      canonicalUrlKey(event.url), normalizeTitle(event.title),
      event.eventDate || "", event.publishedAt || "", event.kind || "",
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      event,
      index: out.length,
      date: validDateOrNull(event.eventDate) || validDateOrNull(event.publishedAt),
    });
  }
  return out.sort((a, b) => {
    if (!a.date && b.date) return 1;
    if (a.date && !b.date) return -1;
    return (a.date && b.date ? a.date.localeCompare(b.date) : 0) || a.index - b.index;
  }).map(({ event }) => event);
}

function evidenceError(message) {
  const error = new Error(message);
  error.code = "INSUFFICIENT_SEARCH_EVIDENCE";
  return error;
}

/**
 * Fail-closed evidence check. Returns the (exactly) deduplicated
 * events only when the payload proves a real, citable search:
 * at least one web_search_call and at least one https
 * url_citation, and every event carrying title, source and an
 * https URL. Otherwise it throws INSUFFICIENT_SEARCH_EVIDENCE.
 */
function validateSearchEvidence(payload) {
  if (!payload || typeof payload !== "object") {
    throw evidenceError("Arama kanıtı yok: yanıt nesne değil.");
  }
  const calls = payload.webSearchCalls || payload.web_search_calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    throw evidenceError("Arama kanıtı yok: web_search_call bulunamadı.");
  }
  const citations = payload.citations || payload.urlCitations || payload.url_citations;
  if (
    !Array.isArray(citations) ||
    !citations.some((c) => c && typeof c.url === "string" && /^https:\/\//.test(c.url))
  ) {
    throw evidenceError("Arama kanıtı yok: geçerli url_citation bulunamadı.");
  }
  const events = Array.isArray(payload.events) ? payload.events : [];
  for (const event of events) {
    if (
      !event ||
      typeof event.title !== "string" ||
      !event.title.trim() ||
      typeof event.source !== "string" ||
      !event.source.trim() ||
      typeof event.url !== "string" ||
      !/^https:\/\//.test(event.url)
    ) {
      throw evidenceError("Arama kanıtı eksik: her gelişme başlık, kaynak ve https bağlantı taşımalı.");
    }
  }
  return dedupeTimelineEvents(events);
}

/** Production default inside the extension: not connected. */
function createDisconnectedResearchAdapter() {
  const notConnected = async () => ({
    status: "not-connected",
    events: [],
    message: "Araştırma bağlantısı henüz kurulmadı.",
  });
  return {
    status: "not-connected",
    isConnected: false,
    searchTimeline: notConnected,
    checkNow: notConnected,
  };
}

/**
 * Unimplemented server contract. There is intentionally no
 * network-running factory here: a future server proxy implements
 * this shape server-side (keys stay there) and must pass every
 * response through validateSearchEvidence before presenting it.
 * Calling it fails closed and performs zero API calls.
 */
function createServerResearchAdapter() {
  const notImplemented = async () => {
    const error = new Error(
      "Araştırma servisi henüz uygulanmadı; bu sözleşme ağ çağrısı yapmaz."
    );
    error.code = "RESEARCH_NOT_IMPLEMENTED";
    throw error;
  };
  return {
    status: "not-implemented",
    isConnected: false,
    searchTimeline: notImplemented,
    checkNow: notImplemented,
  };
}

function validDateOrNull(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  const ok =
    date.getUTCFullYear() === +match[1] &&
    date.getUTCMonth() === +match[2] - 1 &&
    date.getUTCDate() === +match[3];
  return ok ? value : null;
}

function httpsUrlOrNull(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Normalizes a real Meta Responses payload into a timeline or a
 * cited final-text answer. Intermediate commentary is excluded.
 * Success requires ALL of: payload.status === "completed", a
 * completed web_search_call, at least one https url_citation, and
 * every reported event backed by a citation for its own URL.
 * Event/publication dates are kept separate and unknown dates
 * stay null. Model text is treated as untrusted data (callers
 * render it as text only). Throws with a stable code otherwise.
 */
function normalizeResponsesResult(payload, checkedAt) {
  const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    throw error;
  };
  if (!payload || typeof payload !== "object") {
    fail("INSUFFICIENT_SEARCH_EVIDENCE", "Araştırma yanıtı geçersiz.");
  }
  if (payload.status === "incomplete" || payload.incomplete_details) {
    fail("RESEARCH_INCOMPLETE", "Araştırma yanıtı tamamlanmamış.");
  }
  if (payload.status !== "completed") {
    fail("RESEARCH_INCOMPLETE", "Araştırma yanıtı tamamlanmış değil.");
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  // An incomplete message/output item can never pass as success,
  // even when the top-level status claims completion.
  if (output.some((item) => item && item.status === "incomplete")) {
    fail("RESEARCH_INCOMPLETE", "Araştırma yanıtı tamamlanmamış (eksik çıktı).");
  }
  const searchCalls = output.filter(
    (item) => item && item.type === "web_search_call" && item.status === "completed"
  );
  const citations = [];
  const seenCitations = new Set();
  const textParts = [];
  for (const item of output) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
    // Meta documents intermediate text as phase: commentary; the
    // final message omits phase. Never turn interim claims/citations
    // into final evidence or concatenate commentary into final JSON.
    if (item.phase && item.phase !== "final_answer") continue;
    for (const part of item.content) {
      if (!part || part.type !== "output_text") continue;
      if (typeof part.text === "string") textParts.push(part.text);
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (annotation && annotation.type === "url_citation") {
          const url = httpsUrlOrNull(annotation.url);
          const key = url && canonicalUrlKey(url);
          if (url && !seenCitations.has(key)) {
            seenCitations.add(key);
            citations.push({ url, title: typeof annotation.title === "string" ? annotation.title : "" });
          }
        }
      }
    }
  }
  const outputText = textParts.join("\n\n").trim();
  if (!outputText || outputText.length > 16000) {
    fail("RESEARCH_UNPARSEABLE", "Muse yanıtı boş veya çok uzun.");
  }
  if (citations.length === 0 || searchCalls.length === 0) {
    return { status: "completed", format: "muse-text", answerText: outputText,
      events: [], citations, searched: searchCalls.length > 0,
      checkedAt: typeof checkedAt === "string" ? checkedAt : null };
  }
  let parsed;
  try {
    const jsonText = outputText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    parsed = JSON.parse(jsonText);
  } catch {
    // Search grounding also documents cited natural-language output.
    // Show that exact final text with its citations, without inventing
    // structured facts or dates. Malformed JSON is still an error.
    if (/^[{\[]|^```/.test(outputText)) {
      fail("RESEARCH_UNPARSEABLE", "Araştırma çıktısı beklenen yapıda değil.");
    }
    return {
      status: "completed", format: "cited-text", answerText: outputText,
      events: [], citations,
      checkedAt: typeof checkedAt === "string" ? checkedAt : null,
    };
  }
  const rawEvents = parsed && Array.isArray(parsed.events) ? parsed.events : null;
  if (!rawEvents) fail("RESEARCH_UNPARSEABLE", "Araştırma çıktısında olay listesi yok.");
  const citedUrls = new Set(citations.map((c) => canonicalUrlKey(c.url)));
  const events = [];
  for (const raw of rawEvents) {
    if (!raw || typeof raw.title !== "string" || !raw.title.trim()) {
      fail("INSUFFICIENT_SEARCH_EVIDENCE", "Başlıksız bulgu kabul edilmez.");
    }
    if (typeof raw.source !== "string" || !raw.source.trim()) {
      fail("INSUFFICIENT_SEARCH_EVIDENCE", "Kaynaksız bulgu kabul edilmez.");
    }
    const url = httpsUrlOrNull(raw.url);
    if (!url) fail("INSUFFICIENT_SEARCH_EVIDENCE", "Bulgular yalnız https kaynak kullanabilir.");
    if (!citedUrls.has(canonicalUrlKey(url))) {
      fail("INSUFFICIENT_SEARCH_EVIDENCE", "Bir bulgu, yanıtın citation kanıtıyla eşleşmiyor.");
    }
    events.push({
      title: raw.title.trim(),
      kind: ["reported-fact", "claim", "plan", "uncertain"].includes(raw.kind) ? raw.kind : "unclassified",
      source: raw.source.trim(),
      url,
      eventDate: validDateOrNull(raw.eventDate),
      publishedAt: validDateOrNull(raw.publishedAt),
    });
  }
  if (events.length === 0) {
    fail("INSUFFICIENT_SEARCH_EVIDENCE", "Desteklenen bulgu yok.");
  }
  return {
    status: "completed",
    format: "timeline",
    events: dedupeTimelineEvents(events),
    citations,
    checkedAt: typeof checkedAt === "string" ? checkedAt : null,
  };
}

const ThreadsMemoryResearchApi = {
  createDisconnectedResearchAdapter,
  createServerResearchAdapter,
  validateSearchEvidence,
  normalizeResponsesResult,
  validDateOrNull,
  httpsUrlOrNull,
  dedupeTimelineEvents,
  canonicalUrlKey,
};

if (typeof module !== "undefined" && module.exports) module.exports = ThreadsMemoryResearchApi;
if (typeof window !== "undefined") window.ThreadsMemoryResearch = ThreadsMemoryResearchApi;
if (typeof self !== "undefined") self.ThreadsMemoryResearch = ThreadsMemoryResearchApi;
