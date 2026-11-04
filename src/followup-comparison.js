"use strict";
(function (root) {
  function assess(result, priorAnswer) {
    const text = String(result.answerText || (result.events || []).map(e => e.title).join("\n") || (result.hits || []).map(h => h.title + ": " + h.snippet).join("\n"));
    const match = /^\s*CHANGE_STATUS:\s*(NEW|NONE|UNCERTAIN)\s*$/im.exec(text);
    const searched = result.searched === true || (Array.isArray(result.citations) && result.citations.length > 0);
    return { change: !priorAnswer ? "baseline" : match && searched ? match[1].toLowerCase() : "uncertain", answer: text.replace(/^\s*CHANGE_STATUS:\s*(NEW|NONE|UNCERTAIN)\s*$/im, "").trim().slice(0, 10000) };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { assess };
  else root.ThreadsMemoryFollowupComparison = { assess };
})(typeof self !== "undefined" ? self : globalThis);
