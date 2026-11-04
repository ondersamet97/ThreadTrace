"use strict";
const tmTranslate = (text) => typeof globalThis.ThreadsMemoryI18n === "object" ? globalThis.ThreadsMemoryI18n.t(text) : text;

/*
 * Live Threads content script.
 *
 * The adapter below implements ONLY the semantic structure observed
 * on 2026-10-28 in a logged-in Threads feed (anonymous observation):
 *  - cards live under DIV[data-pagelet="threads_feed_<n>"] pagelets;
 *  - a card boundary is DIV[data-pressable-container="true"]
 *    [data-interactive-id], wrapping one direct DIV whose sections
 *    are avatar / header / body;
 *  - the header holds the author link A[href="/@HANDLE"][role=link]
 *    and the permalink/time link A[href="/@HANDLE/post/POSTID"]
 *    [role=link] containing TIME[datetime][data-visualcompletion],
 *    in the same header subtree;
 *  - the body holds a text block DIV > SPAN[dir=auto] > SPAN
 *    (mention links may appear inside the text).
 * No minified CSS classes and no fixed ancestor counts are used.
 * The card's whole textContent is never used as the post text.
 * If a card is ambiguous (permalink/author mismatch, more than one
 * distinct permalink, a nested card/quote, missing time or text),
 * it is skipped instead of risking a write to the wrong person.
 *
 * DOM was observed; the extension runtime itself has NOT yet been
 * live-tested in Chrome (the user runs that separately).
 */

const ContentModel =
  typeof module !== "undefined" && module.exports
    ? require("./model.js")
    : window.ThreadsMemoryModel;
const ContentInjector =
  typeof module !== "undefined" && module.exports
    ? require("./injector.js")
    : window.ThreadsMemoryInjector;
const ContentClientLib =
  typeof module !== "undefined" && module.exports
    ? require("./client.js")
    : window.ThreadsMemoryClient;
const ContentResearchLib =
  typeof module !== "undefined" && module.exports
    ? require("./research-adapter.js")
    : window.ThreadsMemoryResearch;

/* Icons: Lucide (ISC License) — see src/icons.js and
 * LICENSES/Lucide-ISC.txt. No hand-drawn glyphs, no emoji. */
const ContentIcons =
  typeof module !== "undefined" && module.exports
    ? require("./icons.js")
    : window.ThreadsMemoryIcons;

function iconSvg(name) {
  return ContentIcons.lucideSvg(name, 19);
}

/* ---------------- anchored panel placement ---------------- */

/**
 * Computes a viewport-clamped position for a panel anchored to
 * its triggering icon: below the trigger when it fits, flipped
 * above near the bottom edge, shifted inside horizontal edges.
 * Pure and unit-tested; callers measure with border-box rects.
 */
function computePanelPlacement({ triggerRect, panelSize, viewport, gap }) {
  const margin = 8;
  const g = typeof gap === "number" ? gap : 6;
  const maxLeft = Math.max(margin, viewport.width - panelSize.width - margin);
  let left = triggerRect.left + triggerRect.width / 2 - panelSize.width / 2;
  left = Math.min(Math.max(left, margin), maxLeft);
  let top = triggerRect.bottom + g;
  let flipped = false;
  if (top + panelSize.height > viewport.height - margin) {
    top = triggerRect.top - panelSize.height - g;
    flipped = true;
  }
  if (top < margin) top = margin;
  if (top + panelSize.height > viewport.height - margin) {
    top = Math.max(margin, viewport.height - panelSize.height - margin);
  }
  return { left: Math.round(left), top: Math.round(top), flipped };
}

/* ---------------- generic DOM helpers (no selectors) ---------------- */

function getAttr(el, name) {
  if (!el || typeof el.getAttribute !== "function") return null;
  return el.getAttribute(name);
}

function elementChildren(el) {
  return el && el.children ? [...el.children] : [];
}

function descendants(root) {
  const out = [];
  const walk = (node) => {
    for (const child of elementChildren(node)) {
      out.push(child);
      walk(child);
    }
  };
  if (root) walk(root);
  return out;
}

function parentOf(el) {
  return el ? el.parentNode || el.parentElement || null : null;
}

function isDescendantOf(el, ancestor) {
  let current = el;
  while (current) {
    if (current === ancestor) return true;
    current = parentOf(current);
  }
  return false;
}

function normalizeVisibleText(text) {
  return String(text || "")
    .replace(/ /g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/* ---------------- observed-structure adapter ---------------- */

const AUTHOR_PATH = /^\/@([^/]+)\/?$/;
const PERMALINK_PATH = /^\/@([^/]+)\/post\/([^/]+)\/?$/;

function hrefPath(href) {
  if (typeof href !== "string" || !href.trim()) return null;
  const trimmed = href.trim();
  try {
    return new URL(trimmed).pathname;
  } catch {
    const path = trimmed.split(/[?#]/)[0];
    return path.startsWith("/") ? path : null;
  }
}

function parseAuthorHref(href) {
  const path = hrefPath(href);
  const match = path && AUTHOR_PATH.exec(path);
  if (!match) return null;
  try {
    return ContentModel.normalizeHandle(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

function parsePermalinkHref(href) {
  const path = hrefPath(href);
  const match = path && PERMALINK_PATH.exec(path);
  if (!match) return null;
  try {
    return {
      handle: ContentModel.normalizeHandle(decodeURIComponent(match[1])),
      postId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

function isCardElement(el) {
  // The observed attribute may be present with an empty value;
  // presence is what matters, absence is what disqualifies.
  return Boolean(
    el &&
      el.tagName === "DIV" &&
      getAttr(el, "data-pressable-container") === "true" &&
      getAttr(el, "data-interactive-id") !== null
  );
}

function anchorsIn(root) {
  return descendants(root).filter((el) => el.tagName === "A");
}

function collectAuthors(headerEl) {
  const authors = new Map();
  for (const anchor of anchorsIn(headerEl)) {
    if (getAttr(anchor, "role") !== "link") continue;
    if (parsePermalinkHref(getAttr(anchor, "href"))) continue;
    const handle = parseAuthorHref(getAttr(anchor, "href"));
    if (handle && !authors.has(handle)) authors.set(handle, anchor);
  }
  return authors;
}

function collectPermalinks(root) {
  const permalinks = new Map();
  for (const anchor of anchorsIn(root)) {
    const parsed = parsePermalinkHref(getAttr(anchor, "href"));
    if (!parsed) continue;
    const key = parsed.handle + "/" + parsed.postId;
    if (!permalinks.has(key)) permalinks.set(key, { ...parsed, anchor });
  }
  return permalinks;
}

const TRANSLATE_LABELS = new Set(["çevir", "çevirisini gör", "çeviriyi gör", "translate"]);

/** A local translate control inside/near a text block, by visible label. */
function isTranslateControl(el) {
  if (!el || (!["BUTTON", "A"].includes(el.tagName) && getAttr(el, "role") !== "button")) return false;
  const label = normalizeVisibleText(el.textContent).split("\n")[0].toLocaleLowerCase("tr-TR");
  return TRANSLATE_LABELS.has(label);
}

function isInteractiveControl(el) {
  return el.tagName === "BUTTON" || getAttr(el, "role") === "button";
}

/** Visible text of a subtree, skipping translate controls. */
function extractVisibleText(root) {
  let out = "";
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 3) {
      out += node.nodeValue || "";
      return;
    }
    if (isTranslateControl(node)) return;
    if (node.tagName === "BR") {
      out += "\n";
      return;
    }
    // Traverse children in real DOM order (text nodes and elements
    // interleaved); splitting element/text passes would reorder
    // "Merhaba <mention>, devamı" into the wrong sequence.
    if (node.childNodes && node.childNodes.length > 0) {
      for (const child of node.childNodes) walk(child);
      return;
    }
    // Fallback for lightweight fake-DOM nodes without childNodes.
    if (typeof node._text === "string") out += node._text;
    for (const child of elementChildren(node)) walk(child);
  };
  walk(root);
  return out;
}

function hasUnsafeTextAncestor(textEl, bodyEl) {
  let current = parentOf(textEl);
  while (current && current !== bodyEl) {
    if (current.tagName === "BUTTON") return true;
    if (getAttr(current, "role") === "button") return true;
    if (current.tagName === "A" && parsePermalinkHref(getAttr(current, "href"))) return true;
    current = parentOf(current);
  }
  return false;
}

/**
 * Finds the observed post-text block inside a body section:
 * a DIV whose direct child is SPAN[dir=auto] wrapping at least one
 * inner SPAN (mentions may appear inside). Sibling media/interaction
 * blocks are not the text block: they contain media elements,
 * buttons or button-roled controls (their dir=auto counter spans
 * are therefore ignored). Returns leaf candidates only; callers
 * require exactly one.
 */
function findTextBlocks(bodyEl) {
  const candidates = [];
  for (const div of [bodyEl, ...descendants(bodyEl)]) {
    if (div.tagName !== "DIV") continue;
    const dirSpans = elementChildren(div).filter(
      (child) => child.tagName === "SPAN" && getAttr(child, "dir") === "auto"
    );
    if (dirSpans.length !== 1) continue;
    const outerSpan = dirSpans[0];
    if (!descendants(outerSpan).some((el) => el.tagName === "SPAN")) continue;
    if (
      descendants(div).some((el) => ["IMG", "VIDEO", "PICTURE", "CANVAS"].includes(el.tagName))
    ) {
      continue;
    }
    // A "Çevir" control belonging to the text block itself does not
    // disqualify the block (and its label is never extracted); any
    // other interactive control does.
    if (
      descendants(div).some((el) => isInteractiveControl(el) && !isTranslateControl(el))
    ) {
      continue;
    }
    if (hasUnsafeTextAncestor(outerSpan, bodyEl)) continue;
    candidates.push({ block: div, outerSpan, parent: parentOf(div) });
  }
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) => other !== candidate && isDescendantOf(other.block, candidate.block)
      )
  );
}

/** Reply-composer section: carries a textbox (it is not post text). */
function isComposerSection(section) {
  if (!section) return false;
  if (getAttr(section, "role") === "textbox") return true;
  return descendants(section).some((el) => getAttr(el, "role") === "textbox");
}

function resolvePostUrl(doc, permalink) {
  const path = "/@" + permalink.handle + "/post/" + encodeURIComponent(permalink.postId);
  const base =
    doc && doc.location && typeof doc.location.href === "string"
      ? doc.location.href
      : "https://www.threads.net/";
  try {
    return new URL(path, base).toString();
  } catch {
    return "https://www.threads.net" + path;
  }
}

/**
 * Validates one card against the observed structure. Returns
 * { data, authorEl, headerEl, bodyEl } or null when the card does
 * not match unambiguously (the card is then skipped entirely).
 */
function analyzeCard(cardEl, doc) {
  if (!isCardElement(cardEl)) return null;

  // A nested card/quote inside this card makes authorship ambiguous.
  if (descendants(cardEl).some((el) => el !== cardEl && isCardElement(el))) return null;

  // Ignore our own injected action bar: after the first scan the
  // card carries it as an extra direct child, and re-scans (or a
  // recycled card) must still validate the host's original wrapper.
  const wrapperChildren = elementChildren(cardEl).filter(
    (el) => !(el.dataset && (el.dataset.tmActions || el.dataset.tmAction))
  );
  if (wrapperChildren.length !== 1 || wrapperChildren[0].tagName !== "DIV") return null;
  const sections = elementChildren(wrapperChildren[0]);
  // Observed layouts: feed cards have 3 sections (avatar/header/
  // body); detail-page main cards have 5 (avatar/header/body/
  // interactions/reply-composer). Anything else is not verified.
  if (sections.length !== 3 && sections.length !== 5) return null;
  const composerSections = sections.filter((section) => isComposerSection(section));
  if (sections.length === 3 && composerSections.length !== 0) return null;
  if (sections.length === 5) {
    if (composerSections.length !== 1) return null;
    if (composerSections[0] !== sections[sections.length - 1]) return null;
  }

  let headerEl = null;
  let headerInfo = null;
  for (const section of sections) {
    const authors = collectAuthors(section);
    const permalinks = collectPermalinks(section);
    if (authors.size === 1 && permalinks.size === 1) {
      const [authorHandle, authorEl] = [...authors.entries()][0];
      const permalink = [...permalinks.values()][0];
      if (authorHandle === permalink.handle) {
        if (headerEl) return null; // two header-like sections
        headerEl = section;
        headerInfo = { authorHandle, authorEl, permalink };
      }
    }
  }
  if (!headerEl || !headerInfo) return null;

  // The whole card must not carry a second, different permalink
  // (quoted/reposted content): if it does, authorship is ambiguous.
  const allPermalinks = collectPermalinks(cardEl);
  if (allPermalinks.size !== 1) return null;

  // The permalink anchor must contain the observed TIME marker.
  const timeEls = descendants(headerInfo.permalink.anchor).filter(
    (el) => el.tagName === "TIME" && getAttr(el, "datetime") && getAttr(el, "data-visualcompletion") !== null
  );
  if (timeEls.length !== 1) return null;

  // On detail pages (threads_post_page_*), only the card that is
  // the page's main post — the one matching the URL's
  // /@HANDLE/post/POSTID — may receive controls. Comments and
  // other authors under the same pagelet are left alone.
  let pageletEl = parentOf(cardEl);
  while (pageletEl && !getAttr(pageletEl, "data-pagelet")) pageletEl = parentOf(pageletEl);
  const pageletName = pageletEl ? getAttr(pageletEl, "data-pagelet") : "";
  if (/^threads_post_page_/.test(pageletName)) {
    let mainFromUrl = null;
    try {
      mainFromUrl = parsePermalinkHref(new URL(doc.location.href).pathname);
    } catch {
      mainFromUrl = null;
    }
    if (!mainFromUrl) return null;
    if (
      mainFromUrl.handle !== headerInfo.authorHandle ||
      mainFromUrl.postId !== headerInfo.permalink.postId
    ) {
      return null;
    }
    if (sections.length !== 5) return null;
  }

  const bodyCandidates = sections.filter(
    (section) =>
      section !== headerEl && !isComposerSection(section) && findTextBlocks(section).length > 0
  );
  if (bodyCandidates.length !== 1) return null;
  const bodyEl = bodyCandidates[0];
  const textBlocks = findTextBlocks(bodyEl);
  if (textBlocks.length === 0) return null;

  // The main post's real action group lives INSIDE the body in
  // both layouts (feed and detail): the deepest DIV holding at
  // least two of the host's own interactive controls and none of
  // the text blocks. Sections outside the body are never used —
  // on detail cards the avatar section (index 0, with its own
  // profile/follow role=buttons) and the sorting-controls section
  // (index 3) are traps, and the composer (index 4) is not an
  // action row. Count only the host's own controls: our injected
  // icon bar never counts as a host action row.
  const interactiveCount = (el) => {
    let count = isInteractiveControl(el) ? 1 : 0;
    const walk = (node) => {
      for (const child of elementChildren(node)) {
        if (child.dataset && child.dataset.tmActions) continue;
        if (isInteractiveControl(child)) count += 1;
        walk(child);
      }
    };
    walk(el);
    return count;
  };
  // Media/player branches are excluded only on structural or
  // semantic evidence: a branch carrying media elements, a
  // slider/seek control, or a media input is a gallery/player
  // branch, never the post action row — no matter how many
  // buttons it has. The real action row is a sibling block in
  // the same content container as the text, after the text.
  const MEDIA_TAGS = ["IMG", "VIDEO", "PICTURE", "CANVAS", "AUDIO", "TRACK", "SOURCE"];
  const hasMediaEvidence = (el) =>
    [el, ...descendants(el)].some(
      (node) =>
        MEDIA_TAGS.includes(node.tagName) ||
        getAttr(node, "role") === "slider" ||
        node.tagName === "INPUT"
    );
  // Grouping container for the action row. Normally it is the
  // text block's direct parent. One narrow, proven exception:
  // a wrapper whose ONLY element children are the verified text
  // blocks — then the common container one level up (holding
  // text wrapper, media and the action row) is the grouping
  // container. No wider ancestor search is ever done.
  let textContainer = textBlocks[0].parent;
  let textAnchor = textBlocks[0].block;
  if (textContainer && textBlocks.every((block) => block.parent === textContainer)) {
    const wrapperChildren = elementChildren(textContainer);
    const wrapperParent = parentOf(textContainer);
    if (
      wrapperChildren.length === textBlocks.length &&
      wrapperChildren.every((child, index) => child === textBlocks[index].block) &&
      wrapperParent &&
      isDescendantOf(textContainer, bodyEl)
    ) {
      textAnchor = textContainer;
      textContainer = wrapperParent;
    }
  }
  const actionCandidates = descendants(bodyEl).filter((el) => {
    if (el.tagName !== "DIV") return false;
    if (el.dataset && el.dataset.tmActions) return false;
    if (parentOf(el) !== textContainer) return false;
    if (hasMediaEvidence(el)) return false;
    if (interactiveCount(el) < 2) return false;
    if (textBlocks.some((tb) => tb.block === el || isDescendantOf(tb.block, el))) return false;
    const siblings = elementChildren(textContainer);
    if (siblings.indexOf(el) <= siblings.indexOf(textAnchor)) return false;
    if (
      descendants(el).some(
        (d) => d.tagName === "DIV" && !(d.dataset && d.dataset.tmActions) && interactiveCount(d) >= 2
      )
    ) {
      return false;
    }
    return true;
  });
  // One more narrow, proven shape: an action wrapper in the
  // common container whose ONLY element child is the real inner
  // row (which itself holds the >=2 controls, each a DIV
  // role=button wrapped singly, with no media and no controls
  // outside that row). The mount target is the inner row, never
  // the wrapper and never a wider ancestor.
  const wrappedMounts = [];
  for (const el of descendants(bodyEl)) {
    if (el.tagName !== "DIV") continue;
    if (el.dataset && el.dataset.tmActions) continue;
    if (parentOf(el) !== textContainer) continue;
    if (hasMediaEvidence(el)) continue;
    if (interactiveCount(el) < 2) continue;
    const siblings = elementChildren(textContainer);
    if (siblings.indexOf(el) <= siblings.indexOf(textAnchor)) continue;
    const children = elementChildren(el);
    if (children.length !== 1) continue;
    const inner = children[0];
    if (inner.tagName !== "DIV") continue;
    if (hasMediaEvidence(inner)) continue;
    if (interactiveCount(inner) < 2) continue;
    if (interactiveCount(inner) !== interactiveCount(el)) continue;
    const subgroups = descendants(el).filter(
      (d) => d.tagName === "DIV" && !(d.dataset && d.dataset.tmActions) && interactiveCount(d) >= 2
    );
    if (subgroups.length !== 1 || subgroups[0] !== inner) continue;
    // Only the host's own controls count here: our injected
    // tmActions bar (real BUTTONs inside the inner row after the
    // first scan) is extension-owned and is separated out — it
    // must never make a verified card read as ambiguous.
    const hostControls = [];
    const collectHostControls = (node) => {
      for (const child of elementChildren(node)) {
        if (child.dataset && child.dataset.tmActions) continue;
        if (isInteractiveControl(child)) hostControls.push(child);
        collectHostControls(child);
      }
    };
    if (isInteractiveControl(inner)) hostControls.push(inner);
    collectHostControls(inner);
    if (hostControls.some((c) => !(c.tagName === "DIV" && getAttr(c, "role") === "button"))) continue;
    wrappedMounts.push(inner);
  }
  const mounts = [...actionCandidates, ...wrappedMounts];
  // Ambiguous or group-less cards get no controls at all; there
  // is deliberately no broad fallback mount (never "last group").
  if (mounts.length !== 1) return null;
  const actionsEl = mounts[0];

  // One post may be split across sibling paragraph blocks
  // (DIV > SPAN[dir=auto] > SPAN each) in the same body content
  // container. Join them in DOM order with a paragraph boundary.
  // Anything else with several blocks — a quote or another post's
  // text among them — is ambiguous and the card is skipped.
  if (textBlocks.length > 1) {
    const parents = new Set(textBlocks.map((candidate) => candidate.parent));
    if (parents.size !== 1 || !textBlocks[0].parent) return null;
    const siblings = elementChildren(textBlocks[0].parent);
    const indexes = textBlocks.map((candidate) => siblings.indexOf(candidate.block));
    if (indexes.some((index) => index < 0)) return null;
    for (let i = 1; i < indexes.length; i += 1) {
      if (indexes[i] !== indexes[i - 1] + 1) return null; // not consecutive siblings
    }
    for (const candidate of textBlocks) {
      // A quoted/embedded block tends to carry its own byline —
      // an author/permalink anchor or TIME marker as a separate
      // line OUTSIDE the text span. A mention link INSIDE the text
      // span is post content, not a byline.
      const hasOwnByline = descendants(candidate.block).some(
        (el) =>
          !isDescendantOf(el, candidate.outerSpan) &&
          ((el.tagName === "A" &&
            getAttr(el, "role") === "link" &&
            (parseAuthorHref(getAttr(el, "href")) || parsePermalinkHref(getAttr(el, "href")))) ||
            el.tagName === "TIME")
      );
      if (hasOwnByline) return null;
    }
  }

  const paragraphs = textBlocks.map((candidate) =>
    normalizeVisibleText(extractVisibleText(candidate.outerSpan))
  );
  if (paragraphs.some((paragraph) => !paragraph)) return null;
  const text = paragraphs.join("\n\n");
  if (!text) return null;

  const displayName = normalizeVisibleText(headerInfo.authorEl.textContent).split("\n")[0];
  return {
    data: {
      id: headerInfo.permalink.postId,
      url: resolvePostUrl(doc, headerInfo.permalink),
      authorHandle: headerInfo.authorHandle,
      authorDisplayName: displayName || "@" + headerInfo.authorHandle,
      text,
    },
    authorEl: headerInfo.authorEl,
    headerEl,
    bodyEl,
    actionsEl,
  };
}

const LiveThreadsAdapter = {
  // DOM observed 2026-10-28; extension runtime not yet live-tested.
  status: "observed-not-runtime-verified",
  isCardElement,
  analyzeCard,
  findPostElements(doc) {
    if (!doc) return [];
    const pagelets = descendants(doc).filter((el) =>
      /^(?:threads_feed|threads_post_page)_(?:\d+|\{n\})$/.test(getAttr(el, "data-pagelet") || "")
    );
    const found = [];
    const seen = new Set();
    for (const pagelet of pagelets) {
      for (const el of descendants(pagelet)) {
        if (isCardElement(el) && !seen.has(el)) {
          seen.add(el);
          found.push(el);
        }
      }
    }
    // A card nested inside another card (quote/repost embed) is not
    // an independent feed card here; both are left alone.
    return found.filter(
      (card) => !found.some((other) => other !== card && isDescendantOf(card, other))
    );
  },
  extractPost(postEl, doc) {
    const analyzed = analyzeCard(postEl, doc);
    return analyzed ? analyzed.data : null;
  },
  findAuthorElement(postEl, doc) {
    const analyzed = analyzeCard(postEl, doc);
    return analyzed ? analyzed.authorEl : null;
  },
  findHeaderElement(postEl, doc) {
    const analyzed = analyzeCard(postEl, doc);
    return analyzed ? analyzed.headerEl : null;
  },
};

/* ---------------- live UI controller ---------------- */

function createLiveController(deps) {
  const doc = deps && deps.document;
  if (!doc) throw new TypeError("document is required");
  const adapter = deps.adapter || LiveThreadsAdapter;
  const injector = deps.injector || ContentInjector;
  const clientProvider =
    deps.clientProvider || (() => deps.client || null);
  const tracker = injector.createInjectionTracker();

  const elementScopes = new WeakMap();
  let scopeCounter = 0;
  const viewCache = new Map();
  let viewEpoch = 0;
  const postStateSeen = new Map(); // postKey -> newest { status, version } observed
  const activeLabelEditors = new Map(); // slot -> editor session
  const labelRenderTokens = new WeakMap();
  let statusEl = null;
  let notePanel = null;
  let noteSession = null;
  let noteSessionSeq = 0;
  let savePanel = null;
  let saveSession = null;
  let saveSessionSeq = 0;
  let watchPanel = null;
  let watchSession = null;
  let watchSessionSeq = 0;
  let labelFeedPanel = null;
  let labelFeedSession = null;
  let labelFeedSeq = 0;
  let labelStyles = new Map();
  let labelStyleVersions = new Map();
  let labelStyleReadSeq = 0;
  const researchAdapter =
    deps.researchAdapter ||
    (ContentResearchLib ? ContentResearchLib.createDisconnectedResearchAdapter() : null);

  // Unsaved drafts survive panel close / panel-type transitions,
  // keyed per person or per post. They are only ever restored into
  // the same person's/post's panel — never silently auto-saved.
  const localDrafts = new Map();

  function pendingOpIdFor(type, target) {
    const client = resolveClient();
    if (!client || typeof client.getPendingOperationFor !== "function") return null;
    const pending = client.getPendingOperationFor(type, target);
    return pending ? pending.opId : null;
  }

  function preservePersonDraft() {
    if (!noteSession || !notePanel) return;
    const key = "person:" + noteSession.handle;
    if (noteSession.dirty || noteSession.labelsDirty) {
      // Keep the draft's ORIGINAL base versions and any uncertain
      // operation identities: reopening must not silently rebase
      // the draft onto a newer external version.
      localDrafts.set(key, {
        note: notePanel.textarea.value,
        noteDirty: noteSession.dirty,
        noteBaseVersion: noteSession.baseVersion,
        noteOpId: pendingOpIdFor("tm.person.setNote", noteSession.handle),
        labels: [...noteSession.draftLabels],
        labelsInput: notePanel.labelsInput.value,
        labelsDirty: noteSession.labelsDirty,
        labelsBaseVersion: noteSession.labelsBaseVersion,
        labelsOpId: pendingOpIdFor("tm.person.setLabels", noteSession.handle),
      });
    } else {
      localDrafts.delete(key);
    }
  }

  function preserveSaveDraft() {
    if (!saveSession || !savePanel) return;
    const key = "save:" + saveSession.postKey;
    if (saveSession.dirty) {
      localDrafts.set(key, {
        reason: savePanel.input.value,
        dirty: true,
        baseVersion: saveSession.baseVersion,
        opId: pendingOpIdFor("tm.posts.setReason", saveSession.post.id),
      });
    } else {
      localDrafts.delete(key);
    }
  }

  function preserveWatchDraft() {
    if (!watchSession || !watchPanel) return;
    const key = "watch:" + watchSession.postKey;
    if (watchSession.dirty) {
      localDrafts.set(key, {
        draft: watchPanel.draft.value,
        dirty: true,
        baseVersion: watchSession.baseVersion,
        opId: pendingOpIdFor("tm.watch.setDraft", watchSession.post.id),
      });
    } else {
      localDrafts.delete(key);
    }
  }

  function preserveAllDrafts() {
    preservePersonDraft();
    preserveSaveDraft();
    preserveWatchDraft();
  }
  let scanning = false;
  let scanQueued = false;

  function resolveClient() {
    try {
      return clientProvider() || null;
    } catch {
      return null;
    }
  }

  function elementScope(el) {
    if (!elementScopes.has(el)) {
      scopeCounter += 1;
      elementScopes.set(el, "tm-el-" + scopeCounter);
    }
    return elementScopes.get(el);
  }

  /**
   * Positions an open panel next to its triggering icon. If the
   * trigger is gone or recycled, the panel is simply clamped
   * back into the viewport (never crashes, never jumps wildly).
   */
  function positionPanel(panelRoot, trigger) {
    if (!panelRoot || !panelRoot.style) return;
    const view = (doc && doc.defaultView) || (typeof window !== "undefined" ? window : null);
    const viewport = {
      width: view && typeof view.innerWidth === "number" ? view.innerWidth : 1024,
      height: view && typeof view.innerHeight === "number" ? view.innerHeight : 768,
    };
    const panelSize = {
      width: panelRoot.offsetWidth || 340,
      height: panelRoot.offsetHeight || 320,
    };
    const margin = 8;
    if (trigger && typeof trigger.getBoundingClientRect === "function" && trigger.isConnected !== false) {
      const pos = computePanelPlacement({
        triggerRect: trigger.getBoundingClientRect(),
        panelSize,
        viewport,
      });
      panelRoot.style.left = pos.left + "px";
      panelRoot.style.top = pos.top + "px";
      panelRoot.style.right = "auto";
      panelRoot.style.bottom = "auto";
      return;
    }
    // Detached/recycled trigger: re-clamp the current geometry.
    if (typeof panelRoot.getBoundingClientRect === "function") {
      const rect = panelRoot.getBoundingClientRect();
      const left = Math.min(Math.max(rect.left || margin, margin), Math.max(margin, viewport.width - panelSize.width - margin));
      const top = Math.min(Math.max(rect.top || margin, margin), Math.max(margin, viewport.height - panelSize.height - margin));
      panelRoot.style.left = left + "px";
      panelRoot.style.top = top + "px";
      panelRoot.style.right = "auto";
      panelRoot.style.bottom = "auto";
    }
  }

  function repositionOpenPanels() {
    if (notePanel && !notePanel.root.hidden) {
      const trigger =
        noteSession && isTriggerCurrent(noteSession, "person") ? noteSession.trigger : null;
      positionPanel(notePanel.root, trigger);
    }
    if (savePanel && !savePanel.root.hidden) {
      const trigger =
        saveSession && isTriggerCurrent(saveSession, "post") ? saveSession.trigger : null;
      positionPanel(savePanel.root, trigger);
    }
    if (watchPanel && !watchPanel.root.hidden) {
      const trigger =
        watchSession && isTriggerCurrent(watchSession, "post") ? watchSession.trigger : null;
      positionPanel(watchPanel.root, trigger);
    }
    if (labelFeedPanel && !labelFeedPanel.root.hidden) {
      positionPanel(labelFeedPanel.root, labelFeedSession && labelFeedSession.trigger);
    }
  }

  /**
   * True when a panel trigger still belongs to the session's own
   * card/person/post. A connected-but-recycled card (now showing
   * someone else) fails this, exactly like a detached one.
   */
  function isTriggerCurrent(session, kind) {
    if (!session || !session.cardEl) return false;
    const analyzed = adapter.analyzeCard(session.cardEl, doc);
    if (!analyzed) return false;
    if (kind === "person") return analyzed.data.authorHandle === session.handle;
    return ContentModel.postKeyFor(analyzed.data) === session.postKey;
  }

  // Content-size watching for open panels: delayed content
  // (labels, statuses, results) can grow a panel after it was
  // positioned; reposition on real size changes only, with no
  // observer loop (positioning never changes a panel's size).
  let panelSizeObserver = null;
  const panelSizes = new Map();
  function observePanelSize(root) {
    if (!root || typeof ResizeObserver === "undefined") return;
    if (!panelSizeObserver) {
      panelSizeObserver = new ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const target = entry.target;
          const width = entry.contentRect ? entry.contentRect.width : target.offsetWidth || 0;
          const height = entry.contentRect ? entry.contentRect.height : target.offsetHeight || 0;
          const last = panelSizes.get(target);
          panelSizes.set(target, { width, height });
          if (last && (last.width !== width || last.height !== height)) changed = true;
        }
        if (changed) repositionOpenPanels();
      });
    }
    if (!panelSizes.has(root)) {
      panelSizes.set(root, { width: root.offsetWidth || 0, height: root.offsetHeight || 0 });
      panelSizeObserver.observe(root);
    }
  }

  function ensureStatusEl() {
    if (statusEl) return statusEl;
    if (!doc.body) return null;
    statusEl = injector.findByDataAttr(doc.body, "tmStatus", "live");
    if (!statusEl) {
      statusEl = doc.createElement("div");
      statusEl.dataset.tmStatus = "live";
      statusEl.className = "tm-status";
      statusEl.setAttribute("role", "status");
      statusEl.setAttribute("aria-live", "polite");
      doc.body.appendChild(statusEl);
    }
    return statusEl;
  }

  function showStatus(message) {
    const el = ensureStatusEl();
    if (el) el.textContent = message || "";
  }

  /** Clicks may land on the SVG/path inside an icon button. */
  function resolveTriggerButton(el) {
    let current = el;
    while (current) {
      if (current.tagName === "BUTTON" || (current.dataset && current.dataset.tmAction)) {
        return current;
      }
      current = parentOf(current);
    }
    return null;
  }

  /** Focus return that tolerates stale/removed triggers. */
  function safeFocus(el) {
    const button = resolveTriggerButton(el) || el;
    if (!button || typeof button.focus !== "function") return false;
    if (button.isConnected === false) return false;
    if (doc.body && !isDescendantOf(button, doc.body)) return false;
    try {
      button.focus();
      return true;
    } catch {
      return false;
    }
  }

  function makeLocalButton({ text, ariaLabel, className, onClick, activateOnKey }) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = className || "tm-btn";
    button.textContent = text;
    button.setAttribute("aria-label", ariaLabel || text);
    let keyActivated = false;
    button.addEventListener("pointerdown", (event) => { keyActivated = false; injector.stopLocalEvent(event); });
    button.addEventListener("mousedown", injector.stopLocalEvent);
    if (onClick) {
      if (activateOnKey) {
        button.addEventListener("keydown", (event) => {
          if (!["Enter", " ", "Spacebar"].includes(event.key)) return;
          injector.guardLocalEvent(event);
          if (event.repeat) return;
          keyActivated = true;
          const view = doc.defaultView;
          if (view && typeof view.setTimeout === "function") view.setTimeout(() => { keyActivated = false; }, 1000);
          return onClick(event);
        });
        button.addEventListener("keyup", (event) => {
          if (["Enter", " ", "Spacebar"].includes(event.key)) injector.guardLocalEvent(event);
        });
      }
      button.addEventListener("click", (event) => {
        injector.guardLocalEvent(event);
        if (keyActivated) { keyActivated = false; return; }
        return onClick(event);
      });
    }
    return button;
  }

  async function readLabelStyles() {
    const client = resolveClient();
    if (!client || typeof client.listLabelStyles !== "function") return;
    const token = ++labelStyleReadSeq;
    const styles = await client.listLabelStyles();
    if (token !== labelStyleReadSeq) return;
    // There is no style-delete operation. A list read begun before
    // a save may omit that record; it must not erase a newer reply.
    const next = new Map(labelStyles);
    const versions = new Map(labelStyleVersions);
    for (const style of styles || []) {
      try {
        const key = ContentModel.normalizeLabelKey(style.labelKey);
        if ((labelStyleVersions.get(key) || 0) > style.version) {
          next.set(key, labelStyles.get(key));
          versions.set(key, labelStyleVersions.get(key));
        } else {
          next.set(key, ContentModel.normalizeLabelColor(style.color));
          versions.set(key, style.version || 0);
        }
      } catch { /* Ignore invalid stored styles; retain readable default. */ }
    }
    labelStyles = next;
    labelStyleVersions = versions;
  }

  function paintLabel(node, color) {
    try {
      const safe = ContentModel.normalizeLabelColor(color);
      node.style.backgroundColor = safe;
      node.style.color = ContentModel.labelTextColor(safe);
    } catch {
      node.style.backgroundColor = "";
      node.style.color = "";
    }
  }

  function colorForLabel(label) {
    try { return labelStyles.get(ContentModel.normalizeLabelKey(label)) || null; }
    catch { return null; }
  }

  function makeIconButton({ action, icon, ariaLabel, tooltip, onClick }) {
    const button = doc.createElement("button");
    button.type = "button";
    button.dataset.tmAction = action;
    button.className = "tm-icon-btn tm-icon-" + action;
    button.innerHTML = iconSvg(icon);
    button.setAttribute("aria-label", ariaLabel);
    button.setAttribute("data-tooltip", tooltip || ariaLabel);
    injector.attachTooltip(button, doc, tooltip || ariaLabel);
    let keyActivated = false;
    button.addEventListener("pointerdown", (event) => {
      keyActivated = false;
      injector.stopLocalEvent(event);
    });
    button.addEventListener("mousedown", injector.stopLocalEvent);
    if (onClick) {
      button.addEventListener("keydown", (event) => {
        if (!event || (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar")) return;
        injector.guardLocalEvent(event);
        if (event.repeat) return;
        keyActivated = true;
        const view = (doc && doc.defaultView) || (typeof window !== "undefined" ? window : null);
        if (view && typeof view.setTimeout === "function") {
          view.setTimeout(() => {
            keyActivated = false;
          }, 1000);
        }
        return onClick(event);
      });
      button.addEventListener("keyup", (event) => {
        if (event && (event.key === " " || event.key === "Spacebar")) injector.stopLocalEvent(event);
      });
      button.addEventListener("click", (event) => {
        injector.guardLocalEvent(event);
        if (keyActivated) {
          keyActivated = false;
          return undefined;
        }
        return onClick(event);
      });
    }
    return button;
  }

  async function getView(handle, force) {
    if (!force && viewCache.has(handle)) return viewCache.get(handle);
    const client = resolveClient();
    if (!client) throw new Error(tmTranslate("Uzantı depolaması hazır değil."));
    const epoch = viewEpoch;
    const view = await client.getPerson(handle);
    if (epoch === viewEpoch) viewCache.set(handle, view);
    return view;
  }

  function invalidateView(handle) {
    viewEpoch += 1;
    viewCache.delete(handle);
  }

  function findCardAncestor(el) {
    let current = el;
    while (current) {
      if (typeof adapter.isCardElement === "function" && adapter.isCardElement(current)) return current;
      current = parentOf(current);
    }
    return null;
  }

  function currentDataForSlot(slot, fallbackHandle) {
    const card = findCardAncestor(slot);
    if (!card) return fallbackHandle ? { authorHandle: fallbackHandle } : null;
    return adapter.extractPost(card, doc);
  }

  async function renderLabelSlot(slot, handle) {
    if (activeLabelEditors.has(slot)) return null;
    const view = await getView(handle);
    const signature = handle + "|" + view.labels.join("");
    if (slot.dataset.tmLabelSignature === signature && elementChildren(slot).length > 0) return view;
    slot.textContent = "";
    slot.dataset.tmPersonHandle = handle;
    slot.dataset.tmLabelSignature = signature;
    for (const label of view.labels) {
      const chip = doc.createElement("span");
      chip.className = "tm-chip";
      chip.textContent = label;
      slot.appendChild(chip);
    }
    const editButton = makeLocalButton({
      text: tmTranslate("Etiketleri düzenle"),
      ariaLabel: "@" + handle + tmTranslate(" için isim etiketlerini düzenle"),
      className: "tm-btn tm-label-edit",
      onClick: () => openLabelEditor(slot),
    });
    slot.appendChild(editButton);
    return view;
  }

  async function refreshLabelsForHandle(handle) {
    for (const card of adapter.findPostElements(doc)) {
      const data = adapter.extractPost(card, doc);
      if (!data || data.authorHandle !== handle) continue;
      const analyzed = adapter.analyzeCard(card, doc);
      if (analyzed) await renderAuthorLabels(card, analyzed);
    }
  }

  // Only the verified author host receives label buttons. DOM identity
  // and a render token guard async reads during SPA recycling/rescans.
  async function renderAuthorLabels(card, analyzed) {
    const author = analyzed.authorEl;
    const host = parentOf(author);
    if (!host) return;
    let slot = elementChildren(host).find((el) => el.dataset && el.dataset.tmAction === "labels");
    if (!slot) {
      slot = doc.createElement("span");
      slot.dataset.tmAction = "labels";
      slot.className = "tm-labels tm-author-labels";
      const personIcon = elementChildren(host).find((el) => el.dataset && el.dataset.tmAction === "person");
      host.insertBefore(slot, (personIcon || author).nextSibling || null);
    }
    const handle = analyzed.data.authorHandle;
    if (slot.dataset.tmPersonHandle !== handle) {
      slot.textContent = "";
      delete slot.dataset.tmLabelSignature;
    }
    slot.dataset.tmPersonHandle = handle;
    const token = {};
    const epoch = viewEpoch;
    labelRenderTokens.set(slot, token);
    const view = await getView(handle).catch(() => null);
    const current = adapter.analyzeCard(card, doc);
    if (labelRenderTokens.get(slot) !== token || epoch !== viewEpoch) return;
    if (!view || !current ||
        current.data.authorHandle !== handle || current.authorEl !== author ||
        parentOf(slot) !== host || !isDescendantOf(card, doc.body)) {
      slot.textContent = "";
      delete slot.dataset.tmLabelSignature;
      slot.hidden = true;
      return;
    }
    const labels = ContentModel.normalizeLabels(view.labels);
    const signature = handle + "|" + JSON.stringify(labels.map((label) => [label, colorForLabel(label)]));
    if (slot.dataset.tmLabelSignature === signature) return;
    slot.textContent = "";
    slot.dataset.tmLabelSignature = signature;
    slot.setAttribute("aria-label", "@" + handle + tmTranslate(" için kişisel etiketler"));
    for (const label of labels) {
      const chip = makeLocalButton({
        text: label,
        ariaLabel: label + tmTranslate(" etiketli kişilerin yerel gönderilerini aç"),
        className: "tm-chip tm-label-feed-open",
        activateOnKey: true,
        onClick: () => {
          const currentCard = adapter.analyzeCard(card, doc);
          if (!currentCard || currentCard.data.authorHandle !== handle || currentCard.authorEl !== author) {
            showStatus(tmTranslate("Kart değişti; etiket akışı açılmadı."));
            return;
          }
          return openLabelFeed(label, chip, { card, handle });
        },
      });
      chip.setAttribute("aria-haspopup", "dialog");
      paintLabel(chip, colorForLabel(label));
      slot.appendChild(chip);
    }
    slot.hidden = labels.length === 0;
  }

  function closeLabelFeed() {
    if (!labelFeedPanel) return;
    labelFeedPanel.root.hidden = true;
    const trigger = labelFeedSession && labelFeedSession.trigger;
    labelFeedSession = null;
    labelFeedSeq += 1;
    safeFocus(trigger);
  }

  async function editLabelFromFeed() {
    const active = labelFeedSession;
    if (!active || !active.personContext) return;
    const { card, handle } = active.personContext;
    const current = adapter.analyzeCard(card, doc);
    if (!current || current.data.authorHandle !== handle || !isDescendantOf(card, doc.body)) {
      labelFeedPanel.status.textContent = tmTranslate("Kart değişti; yanlış kişinin etiketleri açılmadı. Güncel kişi simgesinden düzenleyin.");
      return;
    }
    const editor = await openPersonPanel(card, active.trigger, "labels");
    if (!editor || noteSession !== editor || editor.state !== "ready") return;
    notePanel.colorSection.open = true;
    const key = ContentModel.normalizeLabelKey(active.label);
    const option = elementChildren(notePanel.colorTarget).find((entry) => ContentModel.normalizeLabelKey(entry.value) === key);
    if (option) {
      notePanel.colorTarget.value = option.value;
      await loadLabelColor();
    }
    if (noteSession === editor) {
      notePanel.labelsStatus.textContent = tmTranslate("Etiket çipleri yalnız bu kişiyi düzenler; renk aynı etiketi kullanan kişilerde ortaktır. Değişiklikleri ayrıca kaydedin.");
      positionPanel(notePanel.root, noteSession.trigger);
    }
  }

  async function openLabelFeed(label, trigger, personContext = null) {
    if (!labelFeedPanel) {
      const root = doc.createElement("aside");
      root.className = "tm-note-panel tm-label-feed-panel";
      root.dataset.tmPanel = "label-feed";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-labelledby", "tm-label-feed-title");
      const header = doc.createElement("div");
      header.className = "tm-panel-header";
      const title = doc.createElement("h2");
      title.id = "tm-label-feed-title";
      title.className = "tm-panel-title";
      const close = makeLocalButton({ text: tmTranslate("Kapat"), className: "tm-btn tm-note-close", onClick: closeLabelFeed });
      const back = makeLocalButton({ text: tmTranslate("Geri"), className: "tm-btn tm-label-feed-back", onClick: closeLabelFeed });
      const edit = makeLocalButton({ text: tmTranslate("Etiketi düzenle"), className: "tm-btn tm-label-feed-edit", onClick: editLabelFromFeed });
      header.append(title, close);
      const scope = doc.createElement("p");
      scope.className = "tm-note-person";
      scope.textContent = tmTranslate("Kişi etiketi: bu sayfada yüklü ve yerel hafızaya kaydedilmiş gönderiler. Konu araması veya Threads'in tüm akışı değildir.");
      const status = doc.createElement("p");
      status.className = "tm-note-status";
      status.setAttribute("role", "status");
      const list = doc.createElement("ul");
      list.className = "tm-label-feed-list";
      root.append(header, edit, scope, status, list, back);
      doc.body.appendChild(root);
      observePanelSize(root);
      labelFeedPanel = { root, title, status, list, close, back, edit };
    }
    preserveAllDrafts();
    hideOtherPanels("labels");
    const session = { id: ++labelFeedSeq, label, trigger, personContext };
    labelFeedSession = session;
    const panel = labelFeedPanel;
    panel.title.textContent = label + tmTranslate(" · Yerel akış");
    panel.edit.hidden = !personContext;
    if (personContext) panel.edit.setAttribute("aria-label", label + tmTranslate(" etiketini @") + personContext.handle + tmTranslate(" için düzenle"));
    panel.list.textContent = "";
    panel.status.textContent = tmTranslate("Gönderiler yükleniyor...");
    panel.root.hidden = false;
    positionPanel(panel.root, trigger);
    panel.close.focus();
    await refreshLabelFeed();
  }

  async function refreshLabelFeed() {
    const session = labelFeedSession;
    const panel = labelFeedPanel;
    if (!session || !panel || panel.root.hidden) return;
    const token = (session.readSeq || 0) + 1;
    session.readSeq = token;
    try {
      const client = resolveClient();
      const [people, saved] = await Promise.all([client.listPeople(), client.listPosts()]);
      if (labelFeedSession !== session || session.readSeq !== token) return;
      const visible = adapter.findPostElements(doc).map((card) => adapter.extractPost(card, doc)).filter(Boolean);
      const posts = ContentModel.filterLabelPosts(session.label, people, [...saved, ...visible]);
      const savedKeys = new Set(saved.map((post) => ContentModel.postKeyFor(post)));
      panel.list.textContent = "";
      panel.status.textContent = posts.length ? posts.length + tmTranslate(" gönderi") : tmTranslate("Bu etiketi verdiğiniz kişilerden bu sayfada yüklü veya hafızaya kaydedilmiş gönderi yok.");
      for (const post of posts) {
        const row = doc.createElement("li");
        const name = doc.createElement("p");
        name.className = "tm-note-person";
        name.textContent = post.authorDisplayName + " (@" + post.authorHandle + ") · " + (savedKeys.has(ContentModel.postKeyFor(post)) ? tmTranslate("Hafızada") : tmTranslate("Bu sayfada"));
        const text = doc.createElement("p");
        text.textContent = post.text;
        const source = doc.createElement("a");
        source.textContent = tmTranslate("Gönderiyi aç");
        source.href = post.url;
        source.target = "_blank";
        source.rel = "noreferrer noopener";
        row.append(name, text, source);
        panel.list.appendChild(row);
      }
      positionPanel(panel.root, session.trigger);
    } catch (error) {
      if (labelFeedSession === session && session.readSeq === token) panel.status.textContent = tmTranslate("Akış yüklenemedi: ") + tmTranslate(error.message);
    }
  }

  async function openLabelEditor(slot) {
    const current = currentDataForSlot(slot, slot.dataset.tmPersonHandle);
    if (!current || !current.authorHandle) {
      showStatus(tmTranslate("Etiketler açılamadı: kart artık doğrulanamıyor."));
      return;
    }
    const handle = ContentModel.normalizeHandle(current.authorHandle);
    // The card may have been recycled for another person since the
    // slot was rendered; never edit the previous person's labels.
    if (slot.dataset.tmPersonHandle && slot.dataset.tmPersonHandle !== handle) {
      delete slot.dataset.tmLabelSignature;
      await renderLabelSlot(slot, handle);
      showStatus(tmTranslate("Kart değişti; güncel kişinin etiketleri gösteriliyor."));
      return;
    }
    let view;
    try {
      view = await getView(handle, true);
    } catch (error) {
      showStatus(tmTranslate("Etiketler yüklenemedi: ") + tmTranslate(error.message));
      return;
    }
    // Re-check after the async load: the card may have changed.
    const afterLoad = currentDataForSlot(slot, handle);
    if (!afterLoad || afterLoad.authorHandle !== handle) {
      delete slot.dataset.tmLabelSignature;
      await renderLabelSlot(slot, afterLoad ? afterLoad.authorHandle : handle).catch(() => {});
      showStatus(tmTranslate("Kart değişti; düzenleme açılmadı."));
      return;
    }

    const editor = { handle, baseVersion: view.versions.labels, pendingRetry: false, input: null };
    activeLabelEditors.set(slot, editor);
    slot.textContent = "";
    delete slot.dataset.tmLabelSignature;

    const handleEl = doc.createElement("span");
    handleEl.className = "tm-editor-handle";
    handleEl.textContent = "@" + handle;
    const input = doc.createElement("input");
    input.type = "text";
    input.value = view.labels.join(", ");
    input.setAttribute("aria-label", "@" + handle + tmTranslate(" için isim etiketleri (virgülle ayırın)"));
    editor.input = input;
    const editorStatus = doc.createElement("span");
    editorStatus.className = "tm-editor-status";
    editorStatus.setAttribute("role", "alert");

    const closeEditor = async (refocus) => {
      activeLabelEditors.delete(slot);
      await renderLabelSlot(slot, handle).catch(() => {});
      if (refocus) {
        const button = slot.querySelector ? slot.querySelector("button") : null;
        if (button && typeof button.focus === "function") button.focus();
      }
    };
    editor.close = closeEditor;

    const saveButton = makeLocalButton({
      text: tmTranslate("Etiketleri kaydet"),
      ariaLabel: "@" + handle + tmTranslate(" için etiketleri kaydet"),
      className: "tm-btn tm-label-save",
      onClick: async () => {
        const labels = input.value.split(",").map((p) => p.trim()).filter(Boolean);
        saveButton.disabled = true;
        try {
          const client = resolveClient();
          if (!client) throw new Error(tmTranslate("Uzantı depolaması hazır değil."));
          const pending = typeof client.getPendingOperation === "function" ? client.getPendingOperation() : null;
          const usePendingRetry = Boolean(
            editor.pendingRetry && pending && pending.type === "tm.person.setLabels" && pending.message.handle === handle
          );
          const sentLabels = usePendingRetry ? pending.message.labels : labels;
          let result;
          if (usePendingRetry) {
            result = await client.retryPendingOperation();
          } else {
            result = await client.setLabels(handle, labels, editor.baseVersion);
          }
          // A deduplicated retry whose stored value differs from
          // what we sent means another tab's newer write won. Do
          // not claim success or drop the draft: keep the editor
          // open on the new base version for a conscious re-save.
          if (
            result.deduplicated &&
            JSON.stringify(result.value) !== JSON.stringify(sentLabels)
          ) {
            editor.pendingRetry = false;
            editor.baseVersion = result.version;
            invalidateView(handle);
            editorStatus.textContent =
              tmTranslate("Başka görünümde daha yeni etiketler kaydedilmiş; taslağınız korundu. Tekrar kaydederseniz güncel sürüm üzerine yazılır.");
            return;
          }
          editor.pendingRetry = false;
          editor.baseVersion = result.version;
          invalidateView(handle);
          activeLabelEditors.delete(slot);
          await renderLabelSlot(slot, handle);
          await refreshLabelsForHandle(handle);
          showStatus(tmTranslate("Etiketler kaydedildi: @") + handle + " — " + (result.value || labels).join(", "));
          const button = slot.querySelector ? slot.querySelector("button") : null;
          if (button && typeof button.focus === "function") button.focus();
        } catch (error) {
          if (error.code === "UNCERTAIN_OUTCOME") {
            editor.pendingRetry = true;
            editorStatus.textContent = tmTranslate("Sonuç belirsiz; taslağınız duruyor. Tekrar denemek için Kaydet'e basın.");
          } else if (error.code === "VERSION_CONFLICT") {
            editorStatus.textContent = tmTranslate("Çatışma: etiketler başka görünümde değişti. Taslağınız duruyor; kapatıp yeniden açın.");
          } else {
            editorStatus.textContent = tmTranslate("Kaydedilemedi: ") + tmTranslate(error.message);
          }
        } finally {
          saveButton.disabled = false;
        }
      },
    });
    const cancelButton = makeLocalButton({
      text: tmTranslate("İptal"),
      ariaLabel: "@" + handle + tmTranslate(" için etiket düzenlemeyi iptal et"),
      className: "tm-btn tm-label-cancel",
      onClick: () => closeEditor(true),
    });
    input.addEventListener("keydown", (event) => {
      injector.stopLocalEvent(event);
      if (event.key === "Escape") {
        injector.guardLocalEvent(event);
        void closeEditor(true);
      }
    });
    slot.append(handleEl, input, saveButton, cancelButton, editorStatus);
    if (typeof input.focus === "function") input.focus();
    if (typeof input.select === "function") input.select();
  }

  /* ---------------- note panel ---------------- */

  function renderDraftLabels() {
    if (!notePanel || !noteSession) return;
    const session = noteSession;
    notePanel.labelsChips.textContent = "";
    for (const label of session.draftLabels) {
      const chip = makeLocalButton({
        text: label + " ×",
        ariaLabel: label + tmTranslate(" etiketini bu kişiden kaldır (kaydedilmemiş taslak)"),
        className: "tm-chip tm-label-remove",
        activateOnKey: true,
        onClick: () => {
          if (noteSession !== session || session.state !== "ready") return;
          session.draftLabels = session.draftLabels.filter((entry) => entry !== label);
          session.labelsDirty = true;
          renderDraftLabels();
          notePanel.labelsStatus.textContent = tmTranslate("Etiket bu kişinin taslağından kaldırıldı. Kalıcı olması için Etiketleri kaydet'e basın.");
          preservePersonDraft();
          safeFocus(notePanel.labelsInput);
        },
      });
      paintLabel(chip, colorForLabel(label));
      notePanel.labelsChips.appendChild(chip);
    }
  }

  function addDraftLabel() {
    if (!noteSession || noteSession.state !== "ready") return;
    const label = notePanel.labelsInput.value.trim();
    if (!label) {
      notePanel.labelsStatus.textContent = tmTranslate("Önce bir etiket yazın.");
      return;
    }
    if (label.length > 64) {
      notePanel.labelsStatus.textContent = tmTranslate("Etiket en fazla 64 karakter olabilir.");
      return;
    }
    const key = ContentModel.normalizeLabelKey(label);
    if (noteSession.draftLabels.some((entry) => entry.trim().toLocaleLowerCase("tr-TR") === key)) {
      notePanel.labelsStatus.textContent = tmTranslate("Bu etiket zaten taslakta var.");
      return;
    }
    noteSession.draftLabels.push(label);
    notePanel.labelsInput.value = "";
    noteSession.labelsDirty = true;
    renderDraftLabels();
    notePanel.labelsStatus.textContent = tmTranslate("Etiket taslağa eklendi. Kalıcı olması için Etiketleri kaydet'e basın.");
    preservePersonDraft();
  }

  function ensureNotePanel() {
    if (notePanel) return notePanel;
    const panel = doc.createElement("aside");
    panel.dataset.tmPanel = "person";
    panel.className = "tm-note-panel tm-person-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "tm-note-title");
    panel.hidden = true;

    const title = doc.createElement("h2");
    title.id = "tm-note-title";
    title.className = "tm-note-title tm-panel-title";
    const personLine = doc.createElement("p");
    personLine.className = "tm-note-person";

    const labelsTitle = doc.createElement("h3");
    labelsTitle.className = "tm-panel-subtitle";
    labelsTitle.textContent = tmTranslate("İsim etiketleri");
    const labelsInput = doc.createElement("input");
    labelsInput.type = "text";
    labelsInput.className = "tm-labels-input";
    labelsInput.maxLength = 64;
    labelsInput.setAttribute("autocomplete", "off");
    const labelsChips = doc.createElement("div");
    labelsChips.className = "tm-label-draft-chips";
    labelsChips.setAttribute("role", "group");
    labelsChips.setAttribute("aria-label", tmTranslate("Kaydedilecek etiketler; kaldırmak için etikete basın"));
    const labelsSave = makeLocalButton({
      text: tmTranslate("Etiketleri kaydet"),
      ariaLabel: tmTranslate("Etiketleri kaydet"),
      className: "tm-btn tm-label-save",
      onClick: () => saveLabels(),
    });
    const labelsStatus = doc.createElement("p");
    labelsStatus.className = "tm-note-status tm-labels-status";
    labelsStatus.setAttribute("role", "status");
    labelsStatus.setAttribute("aria-live", "polite");

    const noteTitle = doc.createElement("h3");
    noteTitle.className = "tm-panel-subtitle";
    noteTitle.textContent = tmTranslate("Not defteri");
    const textarea = doc.createElement("textarea");
    textarea.rows = 3;
    textarea.className = "tm-note-text";
    const status = doc.createElement("p");
    status.className = "tm-note-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const closeButton = makeLocalButton({
      text: tmTranslate("Kapat"),
      ariaLabel: tmTranslate("Kişi panelini kapat"),
      className: "tm-btn tm-note-close",
      onClick: () => closeNotePanel(),
    });
    const saveButton = makeLocalButton({
      text: tmTranslate("Notu kaydet"),
      ariaLabel: tmTranslate("Notu kaydet"),
      className: "tm-btn tm-note-save",
      onClick: () => saveNote(),
    });
    labelsInput.addEventListener("input", () => {
      if (noteSession) noteSession.labelsDirty = true;
    });
    let composingLabel = false;
    labelsInput.addEventListener("compositionstart", () => { composingLabel = true; });
    labelsInput.addEventListener("compositionend", () => { composingLabel = false; });
    labelsInput.addEventListener("keydown", (event) => {
      injector.stopLocalEvent(event);
      if (event.isComposing || composingLabel || event.keyCode === 229) return;
      if (event.key === "Enter") {
        injector.guardLocalEvent(event);
        addDraftLabel();
      } else if (event.key === "Escape") {
        injector.guardLocalEvent(event);
        closeNotePanel();
      }
    });
    textarea.addEventListener("input", () => {
      if (noteSession) noteSession.dirty = true;
    });
    textarea.addEventListener("keydown", (event) => {
      injector.stopLocalEvent(event);
      if (event.key === "Escape") {
        injector.guardLocalEvent(event);
        closeNotePanel();
      }
    });

    const header = doc.createElement("div");
    header.className = "tm-panel-header";
    header.append(title, closeButton);
    const fields = doc.createElement("div");
    fields.className = "tm-person-fields";
    const labelsField = doc.createElement("section");
    labelsField.className = "tm-person-label-field";
    labelsInput.setAttribute("placeholder", tmTranslate("Etiket yazın, Enter'a basın"));
    const labelsHint = doc.createElement("p");
    labelsHint.className = "tm-note-person";
    labelsHint.textContent = tmTranslate("Enter ile ekleyin; çipe basarak bu kişiden kaldırın. Değişiklikler Kaydet'e kadar taslaktır.");
    labelsField.append(labelsTitle, labelsInput, labelsChips, labelsHint, labelsSave, labelsStatus);
    const colorSection = doc.createElement("details");
    colorSection.className = "tm-label-colors";
    const colorSummary = doc.createElement("summary");
    colorSummary.textContent = tmTranslate("Etiket rengi seç");
    const colorTarget = doc.createElement("select");
    colorTarget.className = "tm-label-color-target";
    colorTarget.setAttribute("aria-label", tmTranslate("Rengi değiştirilecek kayıtlı etiket"));
    const colorPreview = doc.createElement("span");
    colorPreview.className = "tm-chip tm-label-color-preview";
    const palette = doc.createElement("div");
    palette.className = "tm-label-color-palette";
    const presets = (ContentModel.LABEL_COLOR_PRESETS || []).map(({ name, color }) => {
      const button = makeLocalButton({ text: tmTranslate(name), ariaLabel: tmTranslate(name) + tmTranslate(" rengini önizle"), className: "tm-label-color-preset", onClick: () => previewLabelColor(color) });
      button.dataset.tmColor = color;
      paintLabel(button, color);
      button.style.color = "#ffffff";
      palette.appendChild(button);
      return button;
    });
    const customLabel = doc.createElement("label");
    customLabel.textContent = tmTranslate("Özel renk ");
    const colorCustom = doc.createElement("input");
    colorCustom.type = "color";
    colorCustom.className = "tm-label-color-custom";
    colorCustom.setAttribute("aria-label", tmTranslate("Etiket için özel renk seç"));
    customLabel.appendChild(colorCustom);
    const colorSave = makeLocalButton({ text: tmTranslate("Rengi kaydet"), className: "tm-btn tm-label-color-save", onClick: saveLabelColor });
    const colorStatus = doc.createElement("p");
    colorStatus.className = "tm-note-status tm-label-color-status";
    colorStatus.setAttribute("role", "status");
    colorTarget.addEventListener("change", () => loadLabelColor());
    colorCustom.addEventListener("input", () => previewLabelColor(colorCustom.value));
    colorSection.append(colorSummary, colorTarget, colorPreview, palette, customLabel, colorSave, colorStatus);
    labelsField.appendChild(colorSection);
    const noteField = doc.createElement("section");
    noteField.className = "tm-person-note-field";
    noteField.append(noteTitle, textarea, saveButton, status);
    fields.append(labelsField, noteField);
    panel.append(header, personLine, fields);
    doc.body.appendChild(panel);
    observePanelSize(panel);
    notePanel = {
      root: panel, title, personLine,
      labelsInput, labelsChips, labelsSave, labelsStatus,
      textarea, status, saveButton, closeButton,
      colorSection, colorTarget, colorPreview, colorCustom, colorSave, colorStatus, presets,
    };
    return notePanel;
  }

  function colorControlsDisabled(disabled) {
    if (!notePanel) return;
    for (const control of [notePanel.colorTarget, notePanel.colorCustom, notePanel.colorSave, ...notePanel.presets]) control.disabled = disabled;
  }

  function populateLabelColors(labels) {
    if (!notePanel || !noteSession) return;
    const panel = notePanel;
    const old = panel.colorTarget.value;
    const saved = ContentModel.normalizeLabels(labels).filter((label) => {
      try { ContentModel.normalizeLabelKey(label); return true; } catch { return false; }
    });
    panel.colorTarget.textContent = "";
    for (const label of saved) {
      const option = doc.createElement("option");
      option.value = label;
      option.textContent = label;
      panel.colorTarget.appendChild(option);
    }
    panel.colorTarget.value = saved.includes(old) ? old : saved[0] || "";
    void loadLabelColor();
  }

  async function loadLabelColor() {
    const session = noteSession;
    const panel = notePanel;
    if (!session || !panel) return;
    const token = (session.colorSeq || 0) + 1;
    session.colorSeq = token;
    session.colorLoaded = false;
    session.colorDirty = false;
    colorControlsDisabled(true);
    const label = panel.colorTarget.value;
    panel.colorPreview.textContent = label;
    paintLabel(panel.colorPreview, null);
    if (!label) {
      panel.colorStatus.textContent = tmTranslate("Renk seçmek için önce bir etiket kaydedin.");
      return;
    }
    panel.colorStatus.textContent = tmTranslate("Renk yükleniyor...");
    try {
      const client = resolveClient();
      let style = client && typeof client.getLabelStyle === "function"
        ? await client.getLabelStyle(label) : { color: null, version: 0 };
      if (noteSession !== session || session.colorSeq !== token) return;
      const key = ContentModel.normalizeLabelKey(label);
      if ((labelStyleVersions.get(key) || 0) > style.version) {
        style = { color: labelStyles.get(key), version: labelStyleVersions.get(key) };
      }
      session.colorLabel = label;
      session.colorVersion = style.version;
      session.colorLoaded = true;
      session.colorBusy = false;
      panel.colorCustom.value = style.color || "#e5e5e5";
      paintLabel(panel.colorPreview, style.color);
      colorControlsDisabled(false);
      for (const preset of panel.presets) preset.setAttribute("aria-pressed", preset.dataset.tmColor === style.color ? "true" : "false");
      panel.colorStatus.textContent = tmTranslate("Aynı etiketi taşıyan tüm kişilerde geçerli. Önizleme henüz kaydedilmez.");
    } catch (error) {
      if (noteSession !== session || session.colorSeq !== token) return;
      panel.colorTarget.disabled = false;
      panel.colorStatus.textContent = tmTranslate("Renk okunamadı: ") + tmTranslate(error.message);
    }
  }

  function previewLabelColor(color) {
    if (!noteSession || !noteSession.colorLoaded || noteSession.colorBusy) return;
    try {
      const safe = ContentModel.normalizeLabelColor(color);
      notePanel.colorCustom.value = safe;
      paintLabel(notePanel.colorPreview, safe);
      noteSession.colorDirty = true;
      for (const preset of notePanel.presets) preset.setAttribute("aria-pressed", preset.dataset.tmColor === safe ? "true" : "false");
      notePanel.colorStatus.textContent = tmTranslate("Önizleme; uygulamak için Rengi kaydet.");
    } catch {
      notePanel.colorStatus.textContent = tmTranslate("Geçerli bir renk seçin (#RRGGBB).");
    }
  }

  async function saveLabelColor() {
    const session = noteSession;
    const panel = notePanel;
    if (!session || session.state !== "ready" || !session.colorLoaded || session.colorBusy) return;
    const token = session.colorSeq;
    const label = session.colorLabel;
    session.colorBusy = true;
    colorControlsDisabled(true);
    try {
      const client = resolveClient();
      const pending = client.getPendingOperationFor ? client.getPendingOperationFor("tm.labels.setColor", label) : null;
      const sent = pending ? pending.message.color : ContentModel.normalizeLabelColor(panel.colorCustom.value);
      let result = pending ? await client.retryPendingOperation(pending.key)
        : await client.setLabelColor(label, sent, session.colorVersion);
      const key = ContentModel.normalizeLabelKey(label);
      if ((labelStyleVersions.get(key) || 0) > result.version) {
        result = { ...result, color: labelStyles.get(key), version: labelStyleVersions.get(key) };
      } else {
        labelStyles.set(key, ContentModel.normalizeLabelColor(result.color));
        labelStyleVersions.set(key, result.version);
      }
      for (const card of adapter.findPostElements(doc)) {
        const analyzed = adapter.analyzeCard(card, doc);
        if (analyzed) await renderAuthorLabels(card, analyzed).catch(() => {});
      }
      if (noteSession !== session || session.colorSeq !== token) return;
      session.colorVersion = result.version;
      renderDraftLabels();
      if (result.color !== sent) {
        panel.colorStatus.textContent = tmTranslate("Başka görünümde renk değişti; önizlemeniz korundu. Tekrar kaydetmek güncel rengin üzerine yazar.");
        session.colorDirty = true;
      } else {
        panel.colorCustom.value = result.color;
        paintLabel(panel.colorPreview, result.color);
        session.colorDirty = false;
        panel.colorStatus.textContent = tmTranslate("Etiket rengi kaydedildi.");
      }
    } catch (error) {
      if (noteSession !== session || session.colorSeq !== token) return;
      if (error.code === "VERSION_CONFLICT" && error.details && Number.isInteger(error.details.currentVersion)) session.colorVersion = error.details.currentVersion;
      panel.colorStatus.textContent = error.code === "UNCERTAIN_OUTCOME"
        ? tmTranslate("Sonuç belirsiz; tekrar Kaydet aynı işlemi doğrular.")
        : "Renk kaydedilemedi: " + tmTranslate(error.message);
    } finally {
      session.colorBusy = false;
      if (noteSession === session && session.colorSeq === token) colorControlsDisabled(!session.colorLoaded);
    }
  }

  function closeNotePanel() {
    if (!notePanel) return;
    preservePersonDraft();
    notePanel.root.hidden = true;
    const trigger = noteSession && noteSession.trigger;
    if (trigger && typeof trigger.setAttribute === "function") {
      trigger.setAttribute("aria-expanded", "false");
    }
    const focusTarget = isTriggerCurrent(noteSession, "person") ? trigger : null;
    noteSession = null;
    safeFocus(focusTarget);
  }

  async function openPersonPanel(postEl, trigger, focusTarget) {
    const data = adapter.extractPost(postEl, doc);
    if (!data) {
      showStatus(tmTranslate("Kişi paneli açılamadı: kart artık doğrulanamıyor."));
      return;
    }
    const handle = data.authorHandle;
    const triggerButton = resolveTriggerButton(trigger) || null;
    if (triggerButton && notePanel && !notePanel.root.hidden && noteSession &&
        noteSession.trigger === triggerButton && noteSession.handle === handle) {
      closeNotePanel();
      return;
    }
    const panel = ensureNotePanel();
    preserveAllDrafts();
    hideOtherPanels("person");
    // Every opening is a distinct session. Async completions below
    // apply only while this exact session is still the panel's.
    const session = {
      id: ++noteSessionSeq,
      state: "loading",
      handle,
      displayName: data.authorDisplayName,
      baseVersion: 0,
      labelsBaseVersion: 0,
      draftLabels: [],
      dirty: false,
      labelsDirty: false,
      pendingRetry: false,
      labelsPendingRetry: false,
      trigger: triggerButton,
      cardEl: postEl,
    };
    noteSession = session;
    if (session.trigger && typeof session.trigger.setAttribute === "function") {
      session.trigger.setAttribute("aria-expanded", "true");
    }
    panel.title.textContent = data.authorDisplayName + tmTranslate(" · Etiketler ve notlar");
    panel.personLine.textContent = "@" + handle + tmTranslate(" · Yalnız sizin yerel hafızanızda");
    panel.labelsInput.setAttribute("aria-label", "@" + handle + tmTranslate(" için yeni etiket; Enter ile taslağa ekleyin"));
    panel.labelsSave.setAttribute("aria-label", "@" + handle + tmTranslate(" için etiketleri kaydet"));
    panel.textarea.setAttribute("aria-label", "@" + handle + tmTranslate(" için serbest metin notu"));
    panel.saveButton.setAttribute("aria-label", "@" + handle + tmTranslate(" için notu kaydet"));
    panel.root.hidden = false;
    positionPanel(panel.root, session.trigger);
    // Never let the previous person's fields remain visible or
    // writable under the new handle: clear and lock while loading.
    panel.labelsInput.value = "";
    panel.labelsChips.textContent = "";
    panel.labelsInput.disabled = true;
    panel.labelsSave.disabled = true;
    panel.labelsStatus.textContent = tmTranslate("Etiketler yükleniyor...");
    panel.textarea.value = "";
    panel.textarea.disabled = true;
    panel.saveButton.disabled = true;
    panel.status.textContent = tmTranslate("Not yükleniyor...");
    panel.colorTarget.textContent = "";
    panel.colorTarget.value = "";
    panel.colorPreview.textContent = "";
    panel.colorStatus.textContent = "";
    colorControlsDisabled(true);
    try {
      const view = await getView(handle, true);
      if (noteSession !== session) return; // superseded or closed
      session.baseVersion = view.versions.notes;
      session.labelsBaseVersion = view.versions.labels;
      session.draftLabels = [...view.labels];
      panel.textarea.value = view.note;
      session.dirty = false;
      session.labelsDirty = false;
      // Restore this person's preserved unsaved draft, if any.
      // Its ORIGINAL base versions are kept: if storage moved on
      // meanwhile, saving will surface a real VERSION_CONFLICT
      // instead of silently rebasing onto (and overwriting) the
      // newer external write.
      const draft = localDrafts.get("person:" + handle);
      let labelsVersionMismatch = false;
      let noteVersionMismatch = false;
      if (draft) {
        // Field-level restore: only a field that is dirty or has
        // its own uncertain operation gets its text, original
        // version and retry state back. A clean field keeps the
        // freshly loaded storage value AND its current version,
        // so saving it later cannot silently roll back an
        // external update with a stale value.
        if (draft.labelsDirty || draft.labelsOpId) {
          // In-memory drafts from this view keep chips and unfinished
          // input separate. The old string shape is read only as a
          // legacy draft; new input never splits on commas.
          session.draftLabels = Array.isArray(draft.labels)
            ? [...draft.labels] : ContentModel.normalizeLabels(String(draft.labels || "").split(","));
          panel.labelsInput.value = draft.labelsInput || "";
          session.labelsDirty = draft.labelsDirty;
          labelsVersionMismatch = draft.labelsBaseVersion !== view.versions.labels;
          session.labelsBaseVersion = draft.labelsBaseVersion;
          session.labelsPendingRetry = Boolean(draft.labelsOpId);
        }
        if (draft.noteDirty || draft.noteOpId) {
          panel.textarea.value = draft.note;
          session.dirty = draft.noteDirty;
          noteVersionMismatch = draft.noteBaseVersion !== view.versions.notes;
          session.baseVersion = draft.noteBaseVersion;
          session.pendingRetry = Boolean(draft.noteOpId);
        }
      }
      session.state = "ready";
      renderDraftLabels();
      populateLabelColors(view.labels);
      panel.labelsInput.disabled = false;
      panel.labelsSave.disabled = false;
      panel.textarea.disabled = false;
      panel.saveButton.disabled = false;
      panel.labelsStatus.textContent =
        draft && labelsVersionMismatch
          ? tmTranslate("Taslağınız korundu ancak etiketler dışarıda güncellendi (taslak eski sürüme dayanıyor); Kaydet çatışma verir, bilinçli çözmeden ezilmez.")
          : draft && draft.labelsDirty
            ? tmTranslate("Kaydedilmemiş etiket taslağınız korundu.")
            : "";
      panel.status.textContent =
        draft && noteVersionMismatch
          ? tmTranslate("Taslağınız korundu ancak not dışarıda güncellendi (taslak eski sürüme dayanıyor); Kaydet çatışma verir, bilinçli çözmeden ezilmez.")
          : draft && draft.noteDirty
            ? tmTranslate("Kaydedilmemiş not taslağınız korundu.")
            : "";
      positionPanel(panel.root, session.trigger);
      const focusEl = focusTarget === "note" ? panel.textarea : panel.labelsInput;
      if (typeof focusEl.focus === "function") focusEl.focus();
      return session;
    } catch (error) {
      if (noteSession !== session) return;
      session.state = "error";
      panel.labelsInput.value = "";
      panel.labelsChips.textContent = "";
      panel.labelsInput.disabled = true;
      panel.labelsSave.disabled = true;
      panel.labelsStatus.textContent = tmTranslate("Etiketler yüklenemedi: ") + tmTranslate(error.message);
      panel.textarea.value = "";
      panel.textarea.disabled = true;
      panel.saveButton.disabled = true;
      panel.status.textContent = tmTranslate("Not yüklenemedi: ") + tmTranslate(error.message);
    }
  }

  function openNotes(postEl, trigger) {
    return openPersonPanel(postEl, trigger, "note");
  }

  async function saveLabels() {
    if (!noteSession || !notePanel) return;
    const session = noteSession;
    if (session.state !== "ready" || session.labelsBusy) return;
    const panel = notePanel;
    session.labelsBusy = true;
    const sentLabels = [...session.draftLabels];
    panel.labelsSave.disabled = true;
    try {
      const client = resolveClient();
      if (!client) throw new Error(tmTranslate("Uzantı depolaması hazır değil."));
      const pending = typeof client.getPendingOperationFor === "function"
        ? client.getPendingOperationFor("tm.person.setLabels", session.handle)
        : null;
      const usePendingRetry = Boolean(session.labelsPendingRetry && pending);
      const effectiveSent = usePendingRetry ? pending.message.labels : sentLabels;
      const result = usePendingRetry
        ? await client.retryPendingOperation(pending.key)
        : await client.setLabels(session.handle, sentLabels, session.labelsBaseVersion);
      invalidateView(session.handle);
      await refreshLabelsForHandle(session.handle);
      if (noteSession !== session) return;
      session.labelsPendingRetry = false;
      session.labelsBaseVersion = result.version;
      populateLabelColors(result.value || sentLabels);
      if (result.deduplicated && JSON.stringify(result.value) !== JSON.stringify(effectiveSent)) {
        session.labelsDirty = true;
        panel.labelsStatus.textContent =
          tmTranslate("Başka görünümde daha yeni etiketler kaydedilmiş; taslağınız korundu. Tekrar kaydederseniz güncel sürüm üzerine yazılır.");
        return;
      }
      // Dirty is measured against what was actually sent
      // (effectiveSent), not against the draft at retry-click time:
      // an edit made after a lost A write must stay unsaved even
      // when A's retry later succeeds.
      session.labelsDirty =
        Boolean(panel.labelsInput.value) || JSON.stringify(session.draftLabels) !== JSON.stringify(effectiveSent);
      panel.labelsStatus.textContent = session.labelsDirty
        ? tmTranslate("Etiketler kaydedildi: @") + session.handle + tmTranslate(" — yeni düzenlemeleriniz henüz kaydedilmedi.") +
          (panel.labelsInput.value ? tmTranslate(" Girişteki yazıyı Enter ile etikete dönüştürün.") : "")
        : tmTranslate("Etiketler kaydedildi: @") + session.handle;
      preservePersonDraft();
    } catch (error) {
      if (noteSession !== session) return;
      if (error.code === "UNCERTAIN_OUTCOME") {
        session.labelsPendingRetry = true;
        panel.labelsStatus.textContent = tmTranslate("Sonuç belirsiz; taslağınız duruyor. Tekrar denemek için Kaydet'e basın.");
      } else if (error.code === "VERSION_CONFLICT") {
        // Explicit conflict first; the current version is adopted
        // only now, so a second deliberate save is the conscious
        // resolution — the first one never overwrote anything.
        if (error.details && Number.isInteger(error.details.currentVersion)) {
          session.labelsBaseVersion = error.details.currentVersion;
        }
        panel.labelsStatus.textContent = tmTranslate("Çatışma: etiketler başka görünümde değişti. Taslağınız duruyor; bilinçli olarak üzerine yazmak için tekrar kaydedin.");
      } else {
        panel.labelsStatus.textContent = tmTranslate("Etiketler kaydedilemedi: ") + tmTranslate(error.message);
      }
    } finally {
      // Per-field busy: a note save finishing first must not leave
      // this button stuck, and vice versa.
      session.labelsBusy = false;
      if (noteSession === session) panel.labelsSave.disabled = session.state !== "ready";
    }
  }

  async function saveNote() {
    if (!noteSession || !notePanel) return;
    const session = noteSession;
    // Loading/error sessions can never write: in particular the
    // previous person's text cannot be saved under a new handle
    // before that person's note has loaded. Busy is per-field, so
    // a labels save in flight does not block the note (or reverse).
    if (session.state !== "ready" || session.noteBusy) return;
    const panel = notePanel;
    session.noteBusy = true;
    panel.saveButton.disabled = true;
    try {
      const client = resolveClient();
      if (!client) throw new Error(tmTranslate("Uzantı depolaması hazır değil."));
      const pending = typeof client.getPendingOperationFor === "function"
        ? client.getPendingOperationFor("tm.person.setNote", session.handle)
        : null;
      const usePendingRetry = Boolean(session.pendingRetry && pending);
      // Snapshot the exact text being sent. The textarea stays
      // editable while the worker reply is in flight, so the live
      // draft may move ahead of this snapshot; the two must not be
      // conflated when the reply arrives.
      const sentText = usePendingRetry ? pending.message.note : panel.textarea.value;
      let result;
      if (usePendingRetry) {
        result = await client.retryPendingOperation(pending.key);
      } else {
        result = await client.setNote(session.handle, sentText, session.baseVersion);
      }
      if (noteSession !== session) return;
      session.pendingRetry = false;
      session.baseVersion = result.version;
      // A deduplicated retry whose stored value differs from the
      // sent text means another tab's newer write is now current.
      // It was not overwritten — and our text was not saved either:
      // keep it as a dirty draft on the new base version instead
      // of silently claiming success.
      const supersededByOtherTab = Boolean(result.deduplicated && result.value !== sentText);
      // Only the sent snapshot is saved. If the user kept editing
      // during the flight, the current draft is still unsaved:
      // keep it dirty so storage notifications cannot overwrite it.
      const hasUnsavedNewerEdit = panel.textarea.value !== sentText;
      session.dirty = supersededByOtherTab || hasUnsavedNewerEdit;
      session.state = "ready";
      invalidateView(session.handle);
      // Success is shown only now: after the persistent worker reply.
      panel.status.textContent = supersededByOtherTab
        ? tmTranslate("Başka sekmede daha yeni bir not kaydedilmiş; metniniz taslak olarak korundu. Tekrar kaydederseniz güncel sürüm üzerine yazılır.")
        : hasUnsavedNewerEdit
          ? "Not kaydedildi: @" + session.handle + tmTranslate(" — yeni düzenlemeleriniz henüz kaydedilmedi.")
          : "Not kaydedildi: @" + session.handle;
      showStatus(panel.status.textContent);
      preservePersonDraft();
    } catch (error) {
      if (noteSession !== session) return;
      session.state = "ready";
      if (error.code === "UNCERTAIN_OUTCOME") {
        session.pendingRetry = true;
        panel.status.textContent = tmTranslate("Sonuç belirsiz; notunuz taslak olarak duruyor. Tekrar denemek için Kaydet'e basın.");
      } else if (error.code === "VERSION_CONFLICT") {
        if (error.details && Number.isInteger(error.details.currentVersion)) {
          session.baseVersion = error.details.currentVersion;
        }
        panel.status.textContent = tmTranslate("Çatışma: not başka görünümde değişti. Taslağınız duruyor; bilinçli olarak üzerine yazmak için tekrar kaydedin.");
      } else {
        panel.status.textContent = tmTranslate("Not kaydedilemedi: ") + tmTranslate(error.message);
      }
    } finally {
      // Per-field busy, and a late completion of a previous
      // session's save must not touch the current panel session.
      session.noteBusy = false;
      if (noteSession === session) {
        panel.saveButton.disabled = session.state !== "ready";
      }
    }
  }

  /* ---------------- panels: visibility helper ---------------- */

  function hideOtherPanels(except) {
    for (const session of [noteSession, saveSession, watchSession]) {
      if (session && session.trigger) session.trigger.setAttribute("aria-expanded", "false");
    }
    if (except !== "person" && notePanel) notePanel.root.hidden = true;
    if (except !== "save" && savePanel) savePanel.root.hidden = true;
    if (except !== "watch" && watchPanel) watchPanel.root.hidden = true;
    // Drafts were preserved before this transition. Invalidate hidden
    // sessions so a late load/save cannot steal focus from the new panel.
    if (except !== "person") noteSession = null;
    if (except !== "save") saveSession = null;
    if (except !== "watch") watchSession = null;
    if (except !== "labels" && labelFeedPanel) {
      labelFeedPanel.root.hidden = true;
      labelFeedSession = null;
      labelFeedSeq += 1;
    }
  }

  /* ---------------- save-reason panel ---------------- */

  function ensureSavePanel() {
    if (savePanel) return savePanel;
    const panel = doc.createElement("aside");
    panel.dataset.tmPanel = "save-reason";
    panel.className = "tm-note-panel tm-save-panel tm-save-reason-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "tm-save-title");
    panel.hidden = true;
    const title = doc.createElement("h2");
    title.id = "tm-save-title";
    title.className = "tm-note-title tm-panel-title";
    title.textContent = tmTranslate("Neden kaydettim?");
    const input = doc.createElement("textarea");
    input.rows = 4;
    input.className = "tm-note-text tm-reason-input";
    input.setAttribute("placeholder", tmTranslate("İsteğe bağlı: bu gönderiyi neden kaydettiniz?"));
    const status = doc.createElement("p");
    status.className = "tm-note-status tm-reason-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const closeButton = makeLocalButton({
      text: tmTranslate("Kapat"),
      ariaLabel: tmTranslate("Kayıt gerekçesi panelini kapat"),
      className: "tm-btn tm-note-close",
      onClick: () => closeSavePanel(),
    });
    const saveButton = makeLocalButton({
      text: tmTranslate("Gerekçeyi kaydet"),
      ariaLabel: tmTranslate("Kayıt gerekçesini kaydet"),
      className: "tm-btn tm-reason-save",
      onClick: () => saveSaveReason(),
    });
    const removeButton = makeLocalButton({
      text: tmTranslate("Hafızadan çıkar"),
      ariaLabel: tmTranslate("Gönderiyi hafızadan çıkar (geri alınabilir)"),
      className: "tm-btn tm-post-remove",
      onClick: () => togglePostRemoval(),
    });
    input.addEventListener("input", () => {
      if (saveSession) saveSession.dirty = true;
    });
    input.addEventListener("keydown", (event) => {
      injector.stopLocalEvent(event);
      if (event.key === "Escape") {
        injector.guardLocalEvent(event);
        closeSavePanel();
      }
    });
    const header = doc.createElement("div");
    header.className = "tm-panel-header";
    header.append(title, closeButton);
    panel.append(header, input, saveButton, removeButton, status);
    doc.body.appendChild(panel);
    observePanelSize(panel);
    savePanel = { root: panel, title, input, status, saveButton, removeButton, closeButton };
    return savePanel;
  }

  function closeSavePanel() {
    if (!savePanel) return;
    preserveSaveDraft();
    savePanel.root.hidden = true;
    const trigger = saveSession && saveSession.trigger;
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    const focusTarget = isTriggerCurrent(saveSession, "post") ? trigger : null;
    saveSession = null;
    safeFocus(focusTarget);
  }

  function updateRemoveButton() {
    if (!savePanel || !saveSession) return;
    const removed = saveSession.memoryStatus === "removed";
    // An uncertain removal/undo is resolved first, with its
    // original operation — the button must say so, never offer
    // a fresh opposite action.
    let hasPending = Boolean(saveSession.removalPendingRetry);
    if (!hasPending) {
      const client = resolveClient();
      if (client && typeof client.getPendingOperationFor === "function" && saveSession.post) {
        hasPending = Boolean(
          client.getPendingOperationFor("tm.posts.remove", saveSession.post.id) ||
            client.getPendingOperationFor("tm.posts.restore", saveSession.post.id)
        );
      }
    }
    savePanel.removeButton.textContent = hasPending
      ? tmTranslate("Sonucu doğrula")
      : removed
        ? tmTranslate("Geri al")
        : tmTranslate("Geri al");
    savePanel.removeButton.setAttribute(
      "aria-label",
      hasPending
        ? tmTranslate("Bekleyen kaldırma/geri alma işleminin sonucunu doğrula")
        : removed
          ? tmTranslate("Gönderiyi hafızaya geri al")
          : tmTranslate("Gönderiyi hafızadan çıkar (geri alınabilir)")
    );
    savePanel.removeButton.disabled = saveSession.state !== "ready" || saveSession.removalBusy;
  }

  /**
   * Explicit remove / undo. Only this post's memory state moves;
   * its reason and the person's labels/notes are untouched. A
   * late reply can never flip the panel back to the old state
   * (session identity + state version are authoritative).
   */
  async function togglePostRemoval() {
    if (!saveSession || !savePanel) return;
    const session = saveSession;
    if (session.state !== "ready" || session.removalBusy) return;
    const panel = savePanel;

    // Resolve an uncertain removal/undo FIRST, with its exact
    // original operation — never invent the opposite operation
    // from the (possibly changed) current status.
    {
      const client0 = resolveClient();
      const pendingRemove = client0 && typeof client0.getPendingOperationFor === "function"
        ? client0.getPendingOperationFor("tm.posts.remove", session.post.id)
        : null;
      const pendingRestore = client0 && typeof client0.getPendingOperationFor === "function"
        ? client0.getPendingOperationFor("tm.posts.restore", session.post.id)
        : null;
      const pending = pendingRemove || pendingRestore;
      if (pending) {
        session.removalBusy = true;
        updateRemoveButton();
        try {
          const result = await client0.retryPendingOperation(pending.key);
          if (saveSession !== session) return;
          session.removalPendingRetry = false;
          let currentStatus = result.value && result.value.status
            ? result.value.status
            : result.removed
              ? "removed"
              : "active";
          let currentVersion = result.version;
          try {
            const state = await client0.getPostState(session.post);
            if (saveSession !== session) return;
            if (state && state.post) {
              currentStatus = state.status;
              currentVersion = state.version;
            }
          } catch { /* use operation result */ }
          if (currentVersion >= session.stateVersion) {
            session.stateVersion = currentVersion;
            session.memoryStatus = currentStatus;
          }
          panel.status.textContent =
            tmTranslate("Önceki işlemin sonucu doğrulandı: gönderi şu anda ") +
            (session.memoryStatus === "removed" ? tmTranslate("hafızada değil.") : tmTranslate("hafızada."));
          updateRemoveButton();
        } catch (error) {
          if (saveSession !== session) return;
          panel.status.textContent =
            error.code === "UNCERTAIN_OUTCOME"
              ? tmTranslate("Önceki işlemin sonucu hâlâ belirsiz; yeni işlem başlatılmadı.")
              : tmTranslate("Önceki işlem doğrulanamadı: ") + tmTranslate(error.message);
        } finally {
          session.removalBusy = false;
          if (saveSession === session) updateRemoveButton();
        }
        return;
      }
    }

    const removing = session.memoryStatus !== "removed";
    session.removalBusy = true;
    updateRemoveButton();
    try {
      const client = resolveClient();
      if (!client) throw new Error(tmTranslate("Uzantı depolaması hazır değil."));
      const pendingType = removing ? "tm.posts.remove" : "tm.posts.restore";
      const pending = typeof client.getPendingOperationFor === "function"
        ? client.getPendingOperationFor(pendingType, session.post.id)
        : null;
      const useRetry = Boolean(session.removalPendingRetry && pending);
      const result = useRetry
        ? await client.retryPendingOperation(pending.key)
        : removing
          ? await client.removePost(session.post, session.stateVersion)
          : await client.restorePost(session.post, session.stateVersion);
      if (saveSession !== session) return;
      session.removalPendingRetry = false;
      // Re-read the single current state and apply it
      // monotonically: a late or deduplicated reply can never
      // move the panel's version or status backwards.
      let currentStatus = result.value && result.value.status
        ? result.value.status
        : result.removed
          ? "removed"
          : "active";
      let currentVersion = result.version;
      try {
        const activeClient = resolveClient();
        if (activeClient && typeof activeClient.getPostState === "function") {
          const state = await activeClient.getPostState(session.post);
          if (saveSession !== session) return;
          if (state && state.post) {
            currentStatus = state.status;
            currentVersion = state.version;
          }
        }
      } catch {
        /* fall back to the operation result */
      }
      if (currentVersion >= session.stateVersion) {
        session.stateVersion = currentVersion;
        session.memoryStatus = currentStatus;
      }
      panel.status.textContent = removing
        ? tmTranslate("Hafızadan çıkarıldı. Geri al ile kurtarabilirsiniz.")
        : tmTranslate("Gönderi hafızaya geri alındı.");
      showStatus(panel.status.textContent);
      updateRemoveButton();
      void scan();
    } catch (error) {
      if (saveSession !== session) return;
      if (error.code === "UNCERTAIN_OUTCOME") {
        session.removalPendingRetry = true;
        panel.status.textContent = tmTranslate("Sonuç belirsiz; durumunuz korundu. Tekrar denemek için aynı düğmeye basın.");
      } else if (error.code === "VERSION_CONFLICT") {
        session.removalPendingRetry = false;
        if (error.details && Number.isInteger(error.details.currentVersion)) {
          session.stateVersion = error.details.currentVersion;
        }
        panel.status.textContent = tmTranslate("Çatışma: hafıza durumu başka görünümde değişti. Taslağınız duruyor; bilinçli olarak tekrar deneyin.");
      } else {
        session.removalPendingRetry = false;
        panel.status.textContent = tmTranslate("İşlem yapılamadı: ") + tmTranslate(error.message);
      }
    } finally {
      session.removalBusy = false;
      if (saveSession === session) updateRemoveButton();
    }
  }

  async function openSavePanel(postEl, trigger) {
    const data = adapter.extractPost(postEl, doc);
    if (!data) {
      showStatus(tmTranslate("Kayıt paneli açılamadı: kart artık doğrulanamıyor."));
      return;
    }
    const triggerButton = resolveTriggerButton(trigger) || null;
    if (triggerButton && savePanel && !savePanel.root.hidden && saveSession &&
        saveSession.trigger === triggerButton && saveSession.postKey === ContentModel.postKeyFor(data)) {
      closeSavePanel();
      return;
    }
    const panel = ensureSavePanel();
    preserveAllDrafts();
    hideOtherPanels("save");
    const session = {
      id: ++saveSessionSeq,
      state: "loading",
      postKey: ContentModel.postKeyFor(data),
      post: { id: data.id, url: data.url, authorHandle: data.authorHandle, authorDisplayName: data.authorDisplayName },
      baseVersion: 0,
      stateVersion: 0,
      memoryStatus: "active",
      removalBusy: false,
      removalPendingRetry: false,
      dirty: false,
      pendingRetry: false,
      trigger: triggerButton,
      cardEl: postEl,
    };
    saveSession = session;
    if (session.trigger) session.trigger.setAttribute("aria-expanded", "true");
    panel.input.setAttribute("aria-label", "@" + data.authorHandle + tmTranslate(" gönderisi için kayıt gerekçesi (isteğe bağlı)"));
    panel.root.hidden = false;
    positionPanel(panel.root, session.trigger);
    panel.input.value = "";
    panel.input.disabled = true;
    panel.saveButton.disabled = true;
    updateRemoveButton();
    panel.status.textContent = tmTranslate("Kayıt yükleniyor...");
    try {
      const client = resolveClient();
      if (!client) throw new Error(tmTranslate("Uzantı depolaması hazır değil."));
      // Single-identity state read (no active/removed list race).
      const state = typeof client.getPostState === "function"
        ? await client.getPostState(session.post)
        : null;
      if (saveSession !== session) return;
      if (!state || !state.post) throw new Error(tmTranslate("Kayıtlı gönderi bulunamadı."));
      session.memoryStatus = state.status === "removed" ? "removed" : "active";
      session.stateVersion = state.version || 0;
      updateRemoveButton();
      session.baseVersion = state.reasonVersion || 0;
      const record = { reason: state.reason };
      panel.input.value = record.reason || "";
      session.dirty = false;
      const draft = localDrafts.get("save:" + session.postKey);
      let draftVersionMismatch = false;
      if (draft) {
        panel.input.value = draft.reason;
        session.dirty = true;
        draftVersionMismatch = draft.baseVersion !== session.baseVersion;
        session.baseVersion = draft.baseVersion;
        session.pendingRetry = Boolean(draft.opId);
      }
      session.state = "ready";
      panel.input.disabled = false;
      panel.saveButton.disabled = false;
      // A removal/undo whose response was lost in a previous
      // panel session is retried with its ORIGINAL opId (the
      // client still holds it), never a fresh one.
      const reopenClient = resolveClient();
      if (reopenClient && typeof reopenClient.getPendingOperationFor === "function") {
        session.removalPendingRetry = Boolean(
          reopenClient.getPendingOperationFor("tm.posts.remove", data.id) ||
            reopenClient.getPendingOperationFor("tm.posts.restore", data.id)
        );
      }
      updateRemoveButton();
      panel.status.textContent = draft
        ? draftVersionMismatch
          ? tmTranslate("Taslağınız korundu ancak gerekçe dışarıda güncellendi; Kaydet çatışma verir, bilinçli çözmeden ezilmez.")
          : tmTranslate("Kaydedilmemiş gerekçe taslağınız korundu.")
        : "";
      if (typeof panel.input.focus === "function") panel.input.focus();
    } catch (error) {
      if (saveSession !== session) return;
      session.state = "error";
      panel.input.value = "";
      panel.input.disabled = true;
      panel.saveButton.disabled = true;
      panel.status.textContent = tmTranslate("Kayıt yüklenemedi: ") + tmTranslate(error.message);
    }
  }

  async function saveSaveReason() {
    if (!saveSession || !savePanel) return;
    const session = saveSession;
    if (session.state !== "ready") return;
    const panel = savePanel;
    session.state = "saving";
    panel.saveButton.disabled = true;
    const sentReason = panel.input.value;
    try {
      const client = resolveClient();
      if (!client) throw new Error(tmTranslate("Uzantı depolaması hazır değil."));
      const pending = typeof client.getPendingOperationFor === "function"
        ? client.getPendingOperationFor("tm.posts.setReason", session.post.id)
        : null;
      const usePendingRetry = Boolean(session.pendingRetry && pending);
      const effectiveSent = usePendingRetry ? pending.message.reason : sentReason;
      const result = usePendingRetry
        ? await client.retryPendingOperation(pending.key)
        : await client.setPostReason(session.post, sentReason, session.baseVersion);
      if (saveSession !== session) return;
      session.pendingRetry = false;
      session.baseVersion = result.version;
      if (result.deduplicated && result.value !== effectiveSent) {
        session.dirty = true;
        panel.status.textContent =
          tmTranslate("Başka görünümde daha yeni bir gerekçe kaydedilmiş; taslağınız korundu. Tekrar kaydederseniz güncel sürüm üzerine yazılır.");
        session.state = "ready";
        return;
      }
      session.dirty = panel.input.value !== effectiveSent;
      session.state = "ready";
      panel.status.textContent = session.dirty
        ? tmTranslate("Gerekçe kaydedildi — yeni düzenlemeleriniz henüz kaydedilmedi.")
        : tmTranslate("Gerekçe kaydedildi.");
      preserveSaveDraft();
    } catch (error) {
      if (saveSession !== session) return;
      session.state = "ready";
      if (error.code === "UNCERTAIN_OUTCOME") {
        session.pendingRetry = true;
        panel.status.textContent = tmTranslate("Sonuç belirsiz; taslağınız duruyor. Tekrar denemek için Kaydet'e basın.");
      } else if (error.code === "VERSION_CONFLICT") {
        if (error.details && Number.isInteger(error.details.currentVersion)) {
          session.baseVersion = error.details.currentVersion;
        }
        panel.status.textContent = tmTranslate("Çatışma: gerekçe başka görünümde değişti. Taslağınız duruyor; bilinçli olarak üzerine yazmak için tekrar kaydedin.");
      } else {
        panel.status.textContent = tmTranslate("Gerekçe kaydedilemedi: ") + tmTranslate(error.message);
      }
    } finally {
      if (saveSession === session) panel.saveButton.disabled = session.state !== "ready";
    }
  }

  /* ---------------- watch (tmTranslate("Bu ne olmuş?")) panel ---------------- */

  function ensureWatchPanel() {
    if (watchPanel) return watchPanel;
    const panel = doc.createElement("aside");
    panel.dataset.tmPanel = "watch";
    panel.className = "tm-note-panel tm-watch-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "tm-watch-title");
    panel.hidden = true;
    const title = doc.createElement("h2");
    title.id = "tm-watch-title";
    title.className = "tm-note-title tm-panel-title";
    title.textContent = tmTranslate("Bu ne olmuş?");
    const draft = doc.createElement("textarea");
    draft.rows = 4;
    draft.className = "tm-note-text tm-watch-draft";
    draft.setAttribute("placeholder", tmTranslate("İzlenecek gelişme notu (yalnız yerel taslak)"));
    const status = doc.createElement("p");
    status.className = "tm-note-status tm-watch-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const closeButton = makeLocalButton({
      text: tmTranslate("Kapat"),
      ariaLabel: tmTranslate("Bu ne olmuş panelini kapat"),
      className: "tm-btn tm-note-close",
      onClick: () => closeWatchPanel(),
    });
    const saveButton = makeLocalButton({
      text: tmTranslate("Taslağı kaydet"),
      ariaLabel: tmTranslate("Takip taslağını kaydet"),
      className: "tm-btn tm-watch-save",
      onClick: () => saveWatchDraft(),
    });
    const startNote = doc.createElement("p");
    startNote.className = "tm-note-person";
    const removeButton = makeLocalButton({
      text: tmTranslate("Yerel taslağı kaldır"),
      ariaLabel: tmTranslate("Yerel taslağı kaldır"),
      className: "tm-btn tm-watch-remove",
      onClick: () => removeCurrentWatch(),
    });
    const centerTitle = doc.createElement("h3");
    centerTitle.className = "tm-panel-subtitle";
    centerTitle.textContent = tmTranslate("Takip merkezi");
    const centerList = doc.createElement("ul");
    centerList.className = "tm-watch-center";

    const researchEvent = doc.createElement("textarea");
    researchEvent.rows = 3;
    researchEvent.className = "tm-note-text tm-research-event";
    researchEvent.setAttribute("placeholder", tmTranslate("Genel kamu olayını kendi sözlerinizle yazın"));
    researchEvent.setAttribute("aria-label", tmTranslate("Araştırılacak genel kamu olayı metni"));
    const researchDate = doc.createElement("input");
    researchDate.type = "date";
    researchDate.className = "tm-research-date";
    researchDate.setAttribute("aria-label", tmTranslate("Olay başlangıç tarihi"));
    const researchSource = doc.createElement("input");
    researchSource.type = "url";
    researchSource.className = "tm-research-source";
    researchSource.setAttribute("placeholder", tmTranslate("İsteğe bağlı herkese açık kaynak (https://...)"));
    researchSource.setAttribute("aria-label", tmTranslate("İsteğe bağlı herkese açık kaynak bağlantısı"));
    const researchApproveLabel = doc.createElement("label");
    researchApproveLabel.className = "tm-note-person tm-research-consent";
    const researchApprove = doc.createElement("input");
    researchApprove.type = "checkbox";
    researchApprove.className = "tm-research-approve";
    researchApprove.setAttribute("aria-label", tmTranslate("Bu genel kamu olayı metninin araştırılmasını onaylıyorum"));
    researchApproveLabel.append(researchApprove, doc.createElement("span"));
    researchApproveLabel.children[1].textContent = tmTranslate("Bu gönderi metni ve bağlantısı Meta'ya gönderilsin. Kendi anahtarımla tek ücretli araştırmayı onaylıyorum; notlarım ve etiketlerim gönderilmez.");
    const researchButton = makeLocalButton({
      text: tmTranslate("Güncel durumu sor"),
      ariaLabel: tmTranslate("Tek seferlik Sonra ne oldu araştırması"),
      className: "tm-btn tm-research-run",
      onClick: (event) => runResearchOnce(event),
    });
    const researchCancel = makeLocalButton({
      text: tmTranslate("İptal"),
      ariaLabel: tmTranslate("Araştırmayı iptal et"),
      className: "tm-btn tm-research-cancel",
      onClick: () => cancelResearch(),
    });
    researchCancel.hidden = true;
    const researchStatusLine = doc.createElement("p");
    researchStatusLine.className = "tm-note-status tm-research-status";
    researchStatusLine.setAttribute("role", "status");
    researchStatusLine.setAttribute("aria-live", "polite");
    const researchResults = doc.createElement("ul");
    researchResults.className = "tm-research-results";
    const setupButton = makeLocalButton({
      text: tmTranslate("Kurulum durumunu denetle"),
      ariaLabel: tmTranslate("Araştırma kurulum durumunu denetle"),
      className: "tm-btn tm-research-setup",
      onClick: () => checkResearchSetup(),
    });
    draft.addEventListener("input", () => {
      if (watchSession) watchSession.dirty = true;
    });
    draft.addEventListener("keydown", (event) => {
      injector.stopLocalEvent(event);
      if (event.key === "Escape") {
        injector.guardLocalEvent(event);
        closeWatchPanel();
      }
    });
    const header = doc.createElement("div");
    header.className = "tm-panel-header";
    header.append(title, closeButton);
    const question = doc.createElement("p");
    question.className = "tm-research-question";
    question.textContent = tmTranslate("Gönderideki iddia veya olay şu an ne durumda?");
    const review = doc.createElement("details");
    review.className = "tm-research-review";
    const reviewTitle = doc.createElement("summary");
    reviewTitle.textContent = tmTranslate("Gönderilecek metin ve kaynak");
    const dateHint = doc.createElement("p");
    dateHint.className = "tm-note-person";
    dateHint.textContent = tmTranslate("Olayın başlangıç tarihi biliniyorsa ekleyin; boşsa bilinmiyor olarak araştırılır.");
    researchDate.setAttribute("aria-label", tmTranslate("Olay başlangıç tarihi (biliniyorsa, isteğe bağlı)"));
    review.append(reviewTitle, researchEvent, dateHint, researchDate, researchSource);
    const consent = doc.createElement("div");
    consent.className = "tm-research-confirmation";
    consent.append(review, researchApproveLabel, researchButton);
    const local = doc.createElement("details");
    local.className = "tm-local-interests";
    const localTitle = doc.createElement("summary");
    localTitle.textContent = tmTranslate("Yerel ilgi notları");
    startNote.textContent = tmTranslate("Takiplerinizi bu cihazda saklayın ve yukarıdan otomatik kontrolü seçin.");
    local.append(localTitle, startNote, draft, saveButton, status, removeButton, centerTitle, centerList);
    const followUp = doc.createElement("section");
    followUp.className = "tm-follow-up";
    followUp.hidden = true;
    const followTitle = doc.createElement("h3");
    followTitle.className = "tm-panel-subtitle";
    followTitle.textContent = tmTranslate("Bu olayla ilgileniyorum");
    const followNote = doc.createElement("p");
    followNote.className = "tm-note-person";
    followNote.textContent = tmTranslate("Otomatik kontrol seçilirse günde en fazla bir API isteği yapılır. Tarayıcı açık ve API anahtarı kayıtlı olmalıdır.");
    const followDurationLabel = doc.createElement("label");
    followDurationLabel.textContent = tmTranslate("İlgi süresi (tercih) ");
    const followDuration = doc.createElement("select");
    followDuration.className = "tm-follow-duration";
    followDuration.setAttribute("aria-label", tmTranslate("Yerel ilgi tercihinin süresi"));
    for (const days of [1, 7, 30]) {
      const option = doc.createElement("option");
      option.value = String(days);
      option.textContent = days + tmTranslate(" gün");
      followDuration.appendChild(option);
    }
    followDuration.value = "7";
    followDurationLabel.appendChild(followDuration);
    const followCustom = doc.createElement("textarea");
    followCustom.className = "tm-follow-custom";
    followCustom.maxLength = 500;
    followCustom.placeholder = tmTranslate("Neyi takip etmek istediğinizi yazın");
    followCustom.setAttribute("aria-label", tmTranslate("Manuel takip konusu"));
    const automaticLabel = doc.createElement("label");
    const automatic = doc.createElement("input");
    automatic.type = "checkbox";
    const automaticText = doc.createElement("span");
    automaticText.textContent = " " + tmTranslate("Günde bir otomatik kontrol ve bildirim (API ücreti uygulanabilir)");
    automaticLabel.append(automatic, automaticText);
    const followActions = doc.createElement("div");
    followActions.className = "tm-follow-up-actions";
    const followButtons = [
      ["until-end", tmTranslate("Olay sonuna kadar gelişmeler")],
      ["result-and-commentary", tmTranslate("Sonuç ve sonrasındaki yorumlar")],
      ["custom", tmTranslate("Manuel konu kaydet")],
    ].map(([mode, text]) => {
      const button = makeLocalButton({ text, className: "tm-btn tm-follow-choice", onClick: () => saveFollowUp(mode) });
      button.dataset.tmFollowMode = mode;
      button.setAttribute("aria-pressed", "false");
      followActions.appendChild(button);
      return button;
    });
    const followStatus = doc.createElement("p");
    followStatus.className = "tm-note-status tm-follow-status";
    followStatus.setAttribute("role", "status");
    followUp.append(followTitle, followNote, followDurationLabel, followCustom, automaticLabel, followActions, followStatus);
    panel.append(header, question, consent, researchCancel, setupButton, researchStatusLine, researchResults, followUp, local);
    doc.body.appendChild(panel);
    observePanelSize(panel);
    watchPanel = {
      root: panel, title, draft, status,
      saveButton, removeButton, centerList, closeButton,
      researchEvent, researchDate, researchSource, researchApprove,
      researchButton, researchCancel, setupButton, researchStatusLine, researchResults,
      consent, followUp, followDuration, followCustom, automatic, followButtons, followStatus,
    };
    return watchPanel;
  }

  function closeWatchPanel() {
    if (!watchPanel) return;
    preserveWatchDraft();
    watchPanel.root.hidden = true;
    const trigger = watchSession && watchSession.trigger;
    if (trigger && typeof trigger.setAttribute === "function") {
      trigger.setAttribute("aria-expanded", "false");
    }
    const focusTarget = isTriggerCurrent(watchSession, "post") ? trigger : null;
    watchSession = null;
    safeFocus(focusTarget);
  }

  let watchRenderSeq = 0;

  async function renderWatchCenter() {
    if (!watchPanel) return;
    // Diagnosis: this was an async render race, not duplicated
    // stored data. Concurrent renders (save completion, storage
    // notification, reopen) each cleared the list and appended
    // after their await, stacking identical rows in the DOM; a
    // fresh render on reopen showed the single stored record.
    // Only the latest render may paint, and it replaces the list
    // in one synchronous step after its read resolves.
    const token = ++watchRenderSeq;
    const client = resolveClient();
    const list = watchPanel.centerList;
    if (!client) return;
    let watches = [];
    try {
      watches = await client.listWatches();
    } catch {
      return;
    }
    if (token !== watchRenderSeq || !watchPanel) return;
    list.textContent = "";
    for (const watch of watches) {
      const li = doc.createElement("li");
      const label = doc.createElement("span");
      label.textContent =
        watch.authorDisplayName + " (@" + watch.authorHandle + (watch.followUp && watch.followUp.automatic ? tmTranslate(") — Otomatik takip") : tmTranslate(") — Manuel takip")) +
        (watch.followUp ? " — " + (watch.followUp.mode === "custom" ? watch.followUp.customPrompt : watch.followUp.mode === "until-end" ? tmTranslate("Olay sonuna kadar gelişmeler") : tmTranslate("Sonuç ve sonrasındaki yorumlar")) + " · " + watch.followUp.durationDays + tmTranslate(" gün tercihi") : "") +
        (watch.draft ? " — " + watch.draft.slice(0, 60) : "");
      const remove = makeLocalButton({
        text: tmTranslate("Taslağı kaldır"),
        ariaLabel: "@" + watch.authorHandle + tmTranslate(" için yerel takip taslağını kaldır"),
        className: "tm-btn tm-watch-center-remove",
        onClick: async () => {
          const removalSession = watchSession;
          const draftAtClick = watchSession && watchSession.postKey === watch.postKey ? watchPanel.draft.value : null;
          try {
            const result = await client.removeWatch(
              { id: watch.postId, url: watch.url, authorHandle: watch.authorHandle },
              watch.version || 0
            );
            if (watchSession === removalSession && watchSession && watchSession.postKey === watch.postKey) {
              watchSession.baseVersion = result.version;
              watchSession.followUp = null;
              watchPanel.followStatus.textContent = tmTranslate("Yerel ilgi tercihi kaldırıldı.");
              renderFollowUpSelection();
              // A draft typed while the removal was in flight is
              // newer than the removed one and must survive.
              if (watchPanel.draft.value === draftAtClick) {
                watchSession.dirty = false;
                watchPanel.draft.value = "";
                localDrafts.delete("watch:" + watch.postKey);
              } else {
                watchSession.dirty = true;
                watchPanel.status.textContent = tmTranslate("Taslak kaldırıldı; bu arada yazdığınız yeni taslak korundu.");
                await renderWatchCenter();
                return;
              }
            } else {
              localDrafts.delete("watch:" + watch.postKey);
            }
            if (watchSession === removalSession) watchPanel.status.textContent = tmTranslate("Yerel taslak kaldırıldı; etkin bir takip yoktu.");
            await renderWatchCenter();
          } catch (error) {
            if (watchSession === removalSession) watchPanel.status.textContent = tmTranslate("Taslak kaldırılamadı: ") + tmTranslate(error.message);
          }
        },
      });
      li.append(label, remove);
      list.appendChild(li);
    }
  }

  async function openWatchPanel(postEl, trigger) {
    const data = adapter.extractPost(postEl, doc);
    if (!data) {
      showStatus(tmTranslate("Bu ne olmuş açılamadı: kart artık doğrulanamıyor."));
      return;
    }
    const panel = ensureWatchPanel();
    preserveAllDrafts();
    hideOtherPanels("watch");
    const session = {
      id: ++watchSessionSeq,
      state: "loading",
      postKey: ContentModel.postKeyFor(data),
      post: { id: data.id, url: data.url, authorHandle: data.authorHandle, authorDisplayName: data.authorDisplayName },
      baseVersion: 0,
      dirty: false,
      pendingRetry: false,
      trigger: resolveTriggerButton(trigger) || null,
      cardEl: postEl,
    };
    watchSession = session;
    if (session.trigger && typeof session.trigger.setAttribute === "function") {
      session.trigger.setAttribute("aria-expanded", "true");
    }
    panel.draft.setAttribute("aria-label", "@" + data.authorHandle + tmTranslate(" gönderisi için izlenecek gelişme notu (yerel taslak)"));
    // Research state is view-independent: closing or switching
    // never resets a started call. (An in-flight call keeps its
    // identity in researchState/researchInFlight.)
    panel.researchEvent.value = data.text;
    panel.researchDate.value = "";
    panel.researchSource.value = data.url;
    panel.researchApprove.checked = false;
    panel.researchResults.textContent = "";
    panel.researchButton.disabled = false;
    panel.researchCancel.hidden = true;
    panel.researchStatusLine.textContent = "";
    panel.followUp.hidden = true;
    panel.followStatus.textContent = "";
    panel.followDuration.value = "7";
    panel.root.hidden = false;
    positionPanel(panel.root, session.trigger);
    panel.draft.value = "";
    panel.draft.disabled = true;
    panel.saveButton.disabled = true;
    panel.status.textContent = tmTranslate("Takip taslağı yükleniyor...");
    try {
      const client = resolveClient();
      if (!client) throw new Error(tmTranslate("Uzantı depolaması hazır değil."));
      // Read this post's own state (including a removed tombstone's
      // current version) instead of guessing version 0 from the
      // center list, which hides tombstones.
      const watchState = typeof client.getWatch === "function"
        ? await client.getWatch(session.post)
        : null;
      if (watchSession !== session) return;
      const existing = watchState && watchState.watch ? watchState.watch : null;
      session.followUp = existing && existing.followUp || null;
      if (session.followUp) panel.followDuration.value = String(session.followUp.durationDays);
      panel.followCustom.value = session.followUp && session.followUp.customPrompt || "";
      panel.automatic.checked = Boolean(session.followUp && session.followUp.automatic);
      renderFollowUpSelection();
      session.baseVersion = watchState ? watchState.version || 0 : 0;
      panel.draft.value = existing ? existing.draft || "" : "";
      session.dirty = false;
      const draft = localDrafts.get("watch:" + session.postKey);
      let draftVersionMismatch = false;
      if (draft) {
        panel.draft.value = draft.draft;
        session.dirty = true;
        draftVersionMismatch = draft.baseVersion !== session.baseVersion;
        session.baseVersion = draft.baseVersion;
        session.pendingRetry = Boolean(draft.opId);
      }
      session.state = "ready";
      panel.draft.disabled = false;
      panel.saveButton.disabled = false;
      panel.status.textContent = draft
        ? draftVersionMismatch
          ? tmTranslate("Taslağınız korundu ancak taslak dışarıda güncellendi; Kaydet çatışma verir, bilinçli çözmeden ezilmez.")
          : tmTranslate("Kaydedilmemiş takip taslağınız korundu.")
        : existing
          ? tmTranslate("Yerel taslak yüklendi (bağlantı bekleniyor).")
          : watchState && watchState.status === "removed"
            ? tmTranslate("Önceki taslak kaldırılmış; yeni taslak oluşturabilirsiniz.")
            : "";
      renderResearchState();
      await renderWatchCenter();
      if (watchSession !== session) return;
      if (typeof panel.researchApprove.focus === "function") panel.researchApprove.focus();
      void checkResearchSetup();
    } catch (error) {
      if (watchSession !== session) return;
      session.state = "error";
      panel.draft.value = "";
      panel.draft.disabled = true;
      panel.saveButton.disabled = true;
      panel.status.textContent = tmTranslate("Takip taslağı yüklenemedi: ") + tmTranslate(error.message);
    }
  }

  function renderFollowUpSelection() {
    if (!watchPanel || !watchSession) return;
    watchPanel.followDuration.disabled = Boolean(watchSession.followBusy);
    for (const button of watchPanel.followButtons) {
      button.setAttribute("aria-pressed", watchSession.followUp &&
        watchSession.followUp.mode === button.dataset.tmFollowMode ? "true" : "false");
      button.disabled = Boolean(watchSession.followBusy);
    }
  }

  async function saveFollowUp(mode) {
    const session = watchSession;
    const panel = watchPanel;
    if (!session || !panel || session.followBusy || session.state !== "ready") return;
    if (session.dirty) {
      panel.followStatus.textContent = tmTranslate("Kaydedilmemiş ilgi notunuz var; önce Yerel ilgi notları bölümünde kaydedin.");
      return;
    }
    if (mode === "custom" && !panel.followCustom.value.trim()) {
      panel.followStatus.textContent = tmTranslate("Takip konusunu yazın.");
      return;
    }
    if (panel.automatic.checked && !panel.researchEvent.value.trim()) {
      panel.followStatus.textContent = tmTranslate("Otomatik takip için olay metnini girin.");
      return;
    }
    session.followBusy = true;
    renderFollowUpSelection();
    try {
      const client = resolveClient();
      const pending = typeof client.getPendingOperationFor === "function"
        ? client.getPendingOperationFor("tm.watch.setDraft", session.post.id) : null;
      let result;
      if (pending) {
        if (!pending.message.followUp) throw new Error(tmTranslate("Önce Yerel ilgi notları bölümündeki belirsiz kaydı doğrulayın."));
        result = await client.retryPendingOperation(pending.key);
      } else {
        const current = await client.getWatch(session.post);
        if (watchSession !== session) return;
        result = await client.setWatchDraft(session.post, current.watch ? current.watch.draft || "" : "", current.version || 0, {
          followUp: { mode, durationDays: Number(panel.followDuration.value), ...(mode === "custom" ? { customPrompt: panel.followCustom.value.trim() } : {}), automatic: panel.automatic.checked, ...(panel.automatic.checked ? { eventText: panel.researchEvent.value.trim().slice(0, 2000), scheduledAt: Date.now() } : {}) },
        });
      }
      if (watchSession !== session) return;
      const value = result.watch || result.value;
      session.followUp = value && value.status !== "removed" && value.followUp || null;
      if (session.followUp) panel.followDuration.value = String(session.followUp.durationDays);
      // Preserve a newer local edit's original base; it still needs
      // conscious conflict resolution, never silently rebase it.
      if (!session.dirty) {
        panel.draft.value = value && value.draft || "";
        session.baseVersion = result.version;
      }
      panel.followStatus.textContent = result.deduplicated
        ? tmTranslate("Takip tercihi kaydedildi.")
        : tmTranslate("Takip tercihi kaydedildi.");
      await renderWatchCenter();
    } catch (error) {
      if (watchSession !== session) return;
      panel.followStatus.textContent = error.code === "UNCERTAIN_OUTCOME"
        ? tmTranslate("Kayıt sonucu belirsiz. Aynı seçeneğe tekrar basmak önceki işlemi doğrular; yeni araştırma başlatmaz.")
        : "Tercih kaydedilemedi: " + tmTranslate(error.message);
    } finally {
      session.followBusy = false;
      if (watchSession === session) renderFollowUpSelection();
    }
  }

  async function saveWatchDraft() {
    if (!watchSession || !watchPanel) return;
    const session = watchSession;
    if (session.state !== "ready") return;
    const panel = watchPanel;
    session.state = "saving";
    panel.saveButton.disabled = true;
    const sentDraft = panel.draft.value;
    try {
      const client = resolveClient();
      if (!client) throw new Error(tmTranslate("Uzantı depolaması hazır değil."));
      const pending = typeof client.getPendingOperationFor === "function"
        ? client.getPendingOperationFor("tm.watch.setDraft", session.post.id)
        : null;
      const usePendingRetry = Boolean(session.pendingRetry && pending);
      const effectiveSent = usePendingRetry ? pending.message.draft : sentDraft;
      const result = usePendingRetry
        ? await client.retryPendingOperation(pending.key)
        : await client.setWatchDraft(session.post, sentDraft, session.baseVersion);
      if (watchSession !== session) return;
      session.pendingRetry = false;
      session.baseVersion = result.version;
      const storedDraft = result.watch ? result.watch.draft : result.value && result.value.draft;
      if (result.deduplicated && storedDraft !== effectiveSent) {
        session.dirty = true;
        panel.status.textContent =
          tmTranslate("Başka görünümde daha yeni bir taslak kaydedilmiş; taslağınız korundu. Tekrar kaydederseniz güncel sürüm üzerine yazılır.");
        session.state = "ready";
        return;
      }
      session.dirty = panel.draft.value !== effectiveSent;
      session.state = "ready";
      panel.status.textContent = session.dirty
        ? tmTranslate("Taslak kaydedildi (bağlantı bekleniyor) — yeni düzenlemeleriniz henüz kaydedilmedi.")
        : tmTranslate("Taslak kaydedildi (bağlantı bekleniyor; etkin takip yok).");
      preserveWatchDraft();
      await renderWatchCenter();
    } catch (error) {
      if (watchSession !== session) return;
      session.state = "ready";
      if (error.code === "UNCERTAIN_OUTCOME") {
        session.pendingRetry = true;
        panel.status.textContent = tmTranslate("Sonuç belirsiz; taslağınız duruyor. Tekrar denemek için Kaydet'e basın.");
      } else if (error.code === "VERSION_CONFLICT") {
        if (error.details && Number.isInteger(error.details.currentVersion)) {
          session.baseVersion = error.details.currentVersion;
        }
        panel.status.textContent = tmTranslate("Çatışma: taslak başka görünümde değişti. Taslağınız duruyor; bilinçli olarak üzerine yazmak için tekrar kaydedin.");
      } else {
        panel.status.textContent = tmTranslate("Taslak kaydedilemedi: ") + tmTranslate(error.message);
      }
    } finally {
      if (watchSession === session) panel.saveButton.disabled = session.state !== "ready";
    }
  }

  async function removeCurrentWatch() {
    if (!watchSession || !watchPanel) return;
    const session = watchSession;
    const draftAtStart = watchPanel.draft.value;
    try {
      const client = resolveClient();
      if (!client) throw new Error(tmTranslate("Uzantı depolaması hazır değil."));
      const result = await client.removeWatch(session.post, session.baseVersion);
      if (watchSession !== session) return;
      session.baseVersion = result.version;
      session.followUp = null;
      watchPanel.followStatus.textContent = tmTranslate("Yerel ilgi tercihi kaldırıldı.");
      renderFollowUpSelection();
      // Text written while the removal was in flight belongs to a
      // newer draft; the completed removal must not clear it (nor
      // a newer A-B-A session, guarded by identity above).
      if (watchPanel.draft.value === draftAtStart) {
        session.dirty = false;
        watchPanel.draft.value = "";
        localDrafts.delete("watch:" + session.postKey);
        watchPanel.status.textContent = tmTranslate("Yerel taslak kaldırıldı; etkin bir takip yoktu.");
      } else {
        session.dirty = true;
        watchPanel.status.textContent = tmTranslate("Taslak kaldırıldı; bu arada yazdığınız yeni taslak korundu.");
      }
      await renderWatchCenter();
    } catch (error) {
      if (watchSession === session) {
        if (error.code === "VERSION_CONFLICT") {
          watchPanel.status.textContent = tmTranslate("Çatışma: taslak başka görünümde değişti; taslağınız duruyor.");
        } else {
          watchPanel.status.textContent = tmTranslate("Taslak kaldırılamadı: ") + tmTranslate(error.message);
        }
      }
    }
  }

  /* ---------------- one-shot research ---------------- */

  let researchSeq = 0;
  let researchInFlight = null; // { opId, sessionId, promise }
  /**
   * The single research state, independent of any panel/view
   * session. Closing a panel or switching targets never resets
   * it: a started call stays started, a terminal outcome
   * (cancelled/completed/uncertain/failed) keeps the run locked,
   * and only a definite zero-network "not-connected" answer
   * leaves a later conscious first attempt possible.
   */
  let researchState = { phase: "idle" };
  const TERMINAL_RESEARCH_PHASES = new Set(["cancelled", "completed", "uncertain", "failed"]);

  function researchEventKey(postKey, eventText, startDate) {
    return postKey + "|" + String(eventText || "").trim() + "|" + String(startDate || "");
  }

  function renderResearchState() {
    if (!watchPanel || !watchSession) return;
    const panel = watchPanel;
    const state = researchState;
    panel.consent.hidden = state.phase === "inflight";
    panel.followUp.hidden = false;
    if (state.phase === "not-connected") {
      // A definite zero-network answer unlocks every target and
      // always reads the same, accurate message.
      panel.researchButton.disabled = false;
      panel.researchCancel.hidden = true;
      panel.researchStatusLine.textContent =
        tmTranslate("Araştırma bağlantısı bekleniyor: bağlantı kurulmadığı için ağ isteği yapılmadı ve sonuç üretilmedi.");
      return;
    }
    if (state.phase === "inflight") {
      panel.researchButton.disabled = true;
      panel.researchCancel.hidden = state.postKey !== watchSession.postKey;
      panel.researchStatusLine.textContent =
        state.postKey === watchSession.postKey
          ? tmTranslate("Araştırma çalışıyor...")
          : tmTranslate("Başka bir araştırma sürüyor; yeni çağrı yapılmaz.");
      return;
    }
    if (!TERMINAL_RESEARCH_PHASES.has(state.phase)) {
      panel.researchButton.disabled = false;
      panel.researchCancel.hidden = true;
      return;
    }
    if (state.postKey !== watchSession.postKey) {
      // Another event's outcome is never drawn here, and the
      // global one-shot lock stays visible and closed on every
      // target — never silently re-enabled.
      panel.researchResults.textContent = "";
      panel.researchButton.disabled = false;
      panel.researchCancel.hidden = true;
      panel.researchStatusLine.textContent = "";
      return;
    }
    // Same post: the shown event/date always match the outcome.
    if (state.eventText) panel.researchEvent.value = state.eventText;
    if (state.startDate) panel.researchDate.value = state.startDate;
    panel.researchButton.disabled = false;
    panel.researchCancel.hidden = true;
    if (state.phase === "completed") {
      renderResearchEvents(state.events, state);
      panel.researchStatusLine.textContent =
        (state.format === "muse-text" ? (state.searched ? tmTranslate("Muse yanıtı; web araması yapıldı. Kaynak atfı bulunamadı. Kontrol zamanı: ") : tmTranslate("Muse yanıtı; web araması doğrulanmadı. Kontrol zamanı: ")) : state.format === "search-results" ? tmTranslate("Ham arama sonuçları. Kontrol zamanı: ") : tmTranslate("Araştırma tamamlandı. Muse yanıtı bağımsız doğrulama değildir. Kontrol zamanı: ")) +
        (state.checkedAt || tmTranslate("bilinmiyor"));
    } else if (state.phase === "cancelled") {
      panel.researchStatusLine.textContent =
        tmTranslate("İptal edildi. Dış çağrı tamamlanmış veya ücretlenmiş olabilir; sonucu gösterilmeyecek.");
    } else if (state.phase === "uncertain") {
      panel.researchStatusLine.textContent =
        tmTranslate("Araştırma sonucu belirsiz: yanıt alınamadı. Otomatik tekrar yapılmadı ve bu oturumda yeni ücretli çağrı önerilmez.");
    } else if (state.phase === "failed") {
      panel.researchStatusLine.textContent = tmTranslate("Araştırma yapılamadı: ") + (state.message || tmTranslate("bilinmeyen hata"));
    }
  }

  async function checkResearchSetup() {
    if (!watchPanel || !watchSession) return;
    const session = watchSession;
    const phase = researchState.phase;
    // A setup check never overwrites a terminal research state
    // with its own status wording.
    if (phase === "inflight" || TERMINAL_RESEARCH_PHASES.has(phase)) return;
    try {
      const client = resolveClient();
      if (!client || typeof client.researchSetupStatus !== "function") {
        watchPanel.researchStatusLine.textContent = tmTranslate("Araştırma bağlantısı bekleniyor (kurulum denetlenemedi).");
        return;
      }
      const status = await client.researchSetupStatus();
      if (watchSession !== session || researchState.phase !== phase || watchPanel.root.hidden) return;
      watchPanel.researchStatusLine.textContent =
        status && status.status === "configured-unverified"
          ? tmTranslate("Yapılandırma hazır; bağlantı henüz doğrulanmadı (otomatik sınama yapılmadı).")
          : tmTranslate("Araştırma bağlantısı bekleniyor: kurulum henüz tamamlanmadı. Adımlar: yan panel Ayarlar'dan kendi Meta anahtarınızı bu oturum için girin, api.meta.ai iznini açık düğmeyle verin, sonra tek seferlik araştırmayı çalıştırın.");
    } catch {
      if (watchSession !== session || researchState.phase !== phase || watchPanel.root.hidden) return;
      watchPanel.researchStatusLine.textContent = tmTranslate("Araştırma bağlantısı bekleniyor (kurulum denetlenemedi).");
    }
  }

  function renderResearchEvents(events, result) {
    const list = watchPanel.researchResults;
    list.textContent = "";
    if (result && result.format === "search-results") {
      for (const hit of Array.isArray(result.hits) ? result.hits : []) {
        const url = ContentResearchLib.httpsUrlOrNull(hit && hit.url);
        if (!url) continue;
        const li = doc.createElement("li");
        const link = doc.createElement("a");
        link.textContent = hit.title || url;
        link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
        const snippet = doc.createElement("p");
        snippet.textContent = typeof hit.snippet === "string" ? hit.snippet : "";
        li.append(link, snippet); list.appendChild(li);
      }
      return;
    }
    if (result && (result.format === "cited-text" || result.format === "muse-text")) {
      const answer = doc.createElement("li");
      const label = doc.createElement("strong");
      label.textContent = tmTranslate("Muse yanıtı");
      const text = doc.createElement("p");
      // Only recognize bold markers. Everything else stays inert text;
      // never interpret model-supplied HTML or links.
      const raw = typeof result.answerText === "string" ? result.answerText : "";
      const parts = raw.split(/(\*\*[^*\n]+\*\*)/g);
      for (const part of parts) {
        const node = doc.createElement(part.startsWith("**") && part.endsWith("**") && part.length > 4 ? "strong" : "span");
        node.textContent = node.tagName === "STRONG" ? part.slice(2, -2) : part;
        text.appendChild(node);
      }
      answer.append(label, text);
      list.appendChild(answer);
      const seen = new Set();
      for (const citation of Array.isArray(result.citations) ? result.citations : []) {
        const url = ContentResearchLib.httpsUrlOrNull(citation && citation.url);
        if (!url) continue;
        const key = ContentResearchLib.canonicalUrlKey(url);
        if (seen.has(key)) continue;
        seen.add(key);
        const source = doc.createElement("li");
        const link = doc.createElement("a");
        link.textContent = citation.title || url;
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        source.appendChild(link);
        list.appendChild(source);
      }
      return;
    }
    const kindLabels = new Map([
      ["reported-fact", tmTranslate("Kaynakta bildirilen")],
      ["claim", tmTranslate("İddia")],
      ["plan", tmTranslate("Plan / niyet")],
      ["uncertain", tmTranslate("Belirsizlik")],
    ]);
    for (const event of events || []) {
      const li = doc.createElement("li");
      const title = doc.createElement("span");
      // Model output is untrusted text: textContent only, never HTML.
      title.textContent = event.title;
      const meta = doc.createElement("span");
      meta.textContent =
        " — " + (kindLabels.get(event.kind) || tmTranslate("Kaynaklı bulgu")) +
        tmTranslate(" | Kaynak: ") + event.source +
        tmTranslate(" | Olay tarihi: ") + (event.eventDate || tmTranslate("bilinmiyor")) +
        tmTranslate(" | Yayın tarihi: ") + (event.publishedAt || tmTranslate("bilinmiyor"));
      const link = doc.createElement("a");
      link.textContent = event.url;
      const url = ContentResearchLib.httpsUrlOrNull(event.url);
      if (url) {
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      li.append(title, meta, link);
      list.appendChild(li);
    }
  }

  function cancelResearch() {
    if (!watchPanel) return;
    // Invalidate the in-flight result locally. The external call
    // may still complete (and may have been charged); we say so
    // honestly and never draw its result here.
    researchSeq += 1;
    researchInFlight = null;
    if (watchSession) watchSession.researchConsumed = true;
    if (researchState.phase === "inflight") {
      researchState = { ...researchState, phase: "cancelled" };
    }
    renderResearchState();
  }

  async function runResearchOnce(event) {
    if (!watchSession || !watchPanel) return;
    const session = watchSession;
    const panel = watchPanel;
    // A paid research run requires a real user gesture: synthetic
    // page-dispatched events (isTrusted === false) are rejected.
    if (event && event.isTrusted === false) {
      panel.researchStatusLine.textContent = tmTranslate("Araştırma yalnız gerçek kullanıcı onayıyla başlatılır.");
      return;
    }
    if (!panel.researchApprove.checked) {
      panel.researchStatusLine.textContent = tmTranslate("Önce genel kamu olayı metnini düzenleyip onaylayın.");
      return;
    }
    const eventText = panel.researchEvent.value.trim();
    const startDate = panel.researchDate.value || null;
    const sourceUrl = panel.researchSource.value.trim() || null;
    if (!eventText || eventText.length > 1000 || (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate))) {
      panel.researchStatusLine.textContent = tmTranslate("Gönderilecek metin 1–1000 karakter olmalı. Tarih eklediyseniz YYYY-AA-GG biçimini kullanın.");
      return;
    }
    if (sourceUrl && !sourceUrl.startsWith("https://")) {
      panel.researchStatusLine.textContent = tmTranslate("Kaynak yalnız https olabilir.");
      return;
    }
    // Programmatic guard: a terminal outcome locks the run even
    // if the button is somehow re-enabled, and an in-flight call
    // is shared, never duplicated. Only "not-connected" (zero
    // network, definite) leaves a conscious first attempt open.
    if (researchState.phase === "inflight") {
      renderResearchState();
      return researchInFlight ? researchInFlight.promise : undefined;
    }
    panel.researchApprove.checked = false;
    const opId =
      typeof ContentClientLib.generateOpId === "function"
        ? ContentClientLib.generateOpId()
        : "op-research-" + ++researchSeq;
    const mySeq = ++researchSeq;
    researchState = {
      phase: "inflight",
      opId,
      postKey: session.postKey,
      eventKey: researchEventKey(session.postKey, eventText, startDate),
      eventText,
      startDate,
      sourceUrl,
    };
    panel.researchButton.disabled = true;
    panel.researchCancel.hidden = false;
    panel.researchStatusLine.textContent = tmTranslate("Araştırma çalışıyor...");
    renderResearchState();
    const promise = (async () => {
      try {
        const client = resolveClient();
        if (!client || typeof client.researchOnce !== "function") {
          throw new Error(tmTranslate("Araştırma istemcisi hazır değil."));
        }
        // Only the user-approved public event fields leave the
        // panel — never notes, labels, account data or the feed.
        const result = await client.researchOnce({ eventText, startDate, sourceUrl, opId });
        if (researchState.opId !== opId || researchState.phase !== "inflight") return; // cancelled/superseded
        if (result.status === "not-connected") {
          // Definite zero-network answer: does NOT consume the
          // one-shot; a conscious first attempt stays possible
          // after setup is completed.
          researchState = { phase: "not-connected" };
          researchInFlight = null;
          // Refresh the CURRENT panel (any target): unlock with
          // the accurate zero-network message.
          if (watchPanel) renderResearchState();
          return;
        }
        researchState = {
          phase: "completed",
          opId,
          postKey: session.postKey,
          eventKey: researchEventKey(session.postKey, eventText, startDate),
          eventText,
          startDate,
          events: result.events,
          format: result.format,
          answerText: result.answerText,
          citations: result.citations,
          hits: result.hits,
          searched: result.searched,
          checkedAt: result.checkedAt || null,
        };
        researchInFlight = null;
        // Refresh the CURRENT panel: same post draws its
        // outcome; any other target shows the global lock and
        // never this result.
        if (watchPanel) renderResearchState();
      } catch (error) {
        if (researchState.opId !== opId || researchState.phase !== "inflight") return;
        researchState = {
          phase: error.code === "UNCERTAIN_OUTCOME" ? "uncertain" : "failed",
          opId,
          postKey: session.postKey,
          eventKey: researchEventKey(session.postKey, eventText, startDate),
          eventText,
          startDate,
          message: error.message,
        };
        researchInFlight = null;
        if (watchPanel) renderResearchState();
      }
    })();
    researchInFlight = { opId, sessionId: session.id, promise };
    return promise;
  }

  /* ---------------- scanning / injection ---------------- */

  function updateSaveButton(card, data, savedKeys) {
    const button = injector.findByDataAttr(card, "tmAction", "save");
    if (!button) return;
    button.setAttribute("aria-expanded", saveSession && saveSession.trigger === button &&
      savePanel && !savePanel.root.hidden ? "true" : "false");
    const key = ContentModel.postKeyFor(data);
    const saved = savedKeys.has(key) || savedKeys.has(data.url) || (data.id && savedKeys.has("post:" + data.id));
    if (button.dataset.tmBusy === "1") return;
    button.dataset.tmSaved = saved ? "1" : "0";
    button.setAttribute("aria-pressed", saved ? "true" : "false");
    button.setAttribute(
      "aria-label",
      saved
        ? tmTranslate("Gönderi kişisel hafızada kayıtlı: @") + data.authorHandle + tmTranslate(" (kayıt gerekçesi için aç)")
        : tmTranslate("Gönderiyi kişisel hafızaya ekle: @") + data.authorHandle
    );
    const tooltipText = saved ? tmTranslate("Kayıtlı — nedeni düzenle") : tmTranslate("Hafızaya ekle");
    if (typeof button.getAttribute !== "function" || button.getAttribute("data-tooltip") !== tooltipText) {
      button.setAttribute("data-tooltip", tooltipText);
    }
    // The real tooltip lives in the top layer (doc.body); keep its
    // text in sync with the saved/unsaved description — without
    // rewriting identical text (which would mutate every scan).
    if (button._tmTooltipEl && button._tmTooltipEl.textContent !== tooltipText) {
      button._tmTooltipEl.textContent = tooltipText;
    }
  }

  function ensurePersonIcon(card, analyzed) {
    const { data } = analyzed;
    const authorEl = analyzed.authorEl;
    const host = parentOf(authorEl) || analyzed.headerEl;
    if (!host) return null;
    // Narrow layout fix on the verified author host only: the
    // author link may be an inline element inside a block parent
    // as wide as the link itself, which drops a following icon
    // button onto a new line. Making THIS host a row keeps the
    // icon beside the name without touching any other header,
    // badge or label element.
    if (host === parentOf(authorEl)) {
      const classes = typeof host.className === "string" ? host.className.split(/\s+/) : [];
      if (!classes.includes("tm-author-host")) {
        host.className = [...classes.filter(Boolean), "tm-author-host"].join(" ");
      }
    }
    let button = injector.findByDataAttr(host, "tmAction", "person");
    if (!button) {
      if (tracker) tracker.tryMark(elementScope(card) + ":author", "person");
      button = makeIconButton({
        action: "person",
        icon: "person",
        ariaLabel: "@" + data.authorHandle + tmTranslate(" kişi panelini aç (etiketler ve notlar)"),
        tooltip: "@" + data.authorHandle + tmTranslate(" — etiketler ve notlar"),
        onClick: (event) => {
          const currentCard = findCardAncestor(button) || card;
          return openPersonPanel(currentCard, event && event.target ? event.target : button);
        },
      });
      button.classListAdd ? button.classListAdd("tm-person-btn") : (button.className += " tm-person-btn");
      if (typeof host.insertBefore === "function") {
        host.insertBefore(button, authorEl.nextSibling || null);
      } else {
        host.appendChild(button);
      }
    }
    button.setAttribute("aria-label", "@" + data.authorHandle + tmTranslate(" kişi panelini aç (etiketler ve notlar)"));
    button.setAttribute("data-tooltip", "@" + data.authorHandle + tmTranslate(" — etiketler ve notlar"));
    button.setAttribute(
      "aria-expanded",
      noteSession && noteSession.trigger === button && notePanel && !notePanel.root.hidden
        ? "true"
        : "false"
    );
    return button;
  }

  async function doScan() {
    await readLabelStyles().catch(() => {});
    const cards = adapter.findPostElements(doc);
    let savedKeys = new Set();
    const client = resolveClient();
    if (client) {
      try {
        const posts = await client.listPosts();
        for (const post of posts) {
          savedKeys.add(post.key);
          savedKeys.add(post.url);
          if (post.id) savedKeys.add("post:" + post.id);
          const seen = postStateSeen.get(post.key);
          if (!seen || (post.stateVersion || 0) >= seen.version) {
            postStateSeen.set(post.key, { status: "active", version: post.stateVersion || 0 });
          }
        }
        if (typeof client.listRemovedPosts === "function") {
          const removed = await client.listRemovedPosts().catch(() => []);
          for (const post of removed) {
            const seen = postStateSeen.get(post.key);
            if (!seen || (post.stateVersion || 0) >= seen.version) {
              postStateSeen.set(post.key, { status: "removed", version: post.stateVersion || 0 });
            }
          }
        }
      } catch {
        savedKeys = new Set();
      }
    }

    let processed = 0;
    for (const card of cards) {
      const analyzed = adapter.analyzeCard(card, doc);
      if (!analyzed) {
        const labels = injector.findByDataAttr(card, "tmAction", "labels");
        if (labels) {
          labels.textContent = "";
          labels.hidden = true;
          delete labels.dataset.tmLabelSignature;
          labelRenderTokens.set(labels, {});
        }
        continue; // ambiguous/unmatched card: skip
      }
      const { data } = analyzed;
      processed += 1;

      ensurePersonIcon(card, analyzed);
      await renderAuthorLabels(card, analyzed);

      injector.ensureActionIcons({
        postEl: card,
        // Bookmark/radar live in the main post's own action row,
        // never under the reply composer or a quote's row. The
        // adapter only returns cards with a verified action group.
        mountEl: analyzed.actionsEl,
        scope: elementScope(card),
        doc,
        tracker,
        actions: [
          {
            action: "watch",
            iconSvg: iconSvg("radar"),
            ariaLabel: tmTranslate("Bu ne olmuş panelini aç: @") + data.authorHandle + tmTranslate(" gönderisi"),
            tooltip: tmTranslate("Bu ne olmuş?"),
            onClick: (currentCard, event) => {
              const trigger = event && event.target ? event.target : null;
              return openWatchPanel(currentCard, trigger);
            },
          },
        ],
      });

      const watchButton = injector.findByDataAttr(card, "tmAction", "watch");
      if (watchButton) {
        watchButton.setAttribute(
          "aria-expanded",
          watchSession && watchSession.trigger === watchButton && watchPanel && !watchPanel.root.hidden ? "true" : "false"
        );
      }
    }
    return processed;
  }

  async function scan() {
    if (scanning) {
      scanQueued = true;
      return 0;
    }
    scanning = true;
    try {
      let result = await doScan();
      while (scanQueued) {
        scanQueued = false;
        result = await doScan();
      }
      return result;
    } finally {
      scanning = false;
    }
  }

  async function handleStorageChange() {
    viewEpoch += 1;
    viewCache.clear();
    await scan();
    // Refresh an open, clean note panel; never touch a dirty draft
    // or a session that is still loading / failed to load.
    if (notePanel && !notePanel.root.hidden && noteSession && noteSession.state === "ready") {
      const session = noteSession;
      try {
        const view = await getView(session.handle, true);
        if (noteSession !== session) return;
        const decision = session.noteBusy
          ? { applied: false, externalChangePending: false }
          : ContentClientLib.resolveExternalDraftUpdate({
              draft: notePanel.textarea.value,
              dirty: session.dirty,
              incomingValue: view.note,
            });
        if (decision.applied) {
          notePanel.textarea.value = decision.value;
          session.baseVersion = view.versions.notes;
          session.dirty = false;
        } else if (decision.externalChangePending) {
          notePanel.status.textContent = tmTranslate("Başka görünümde not güncellendi; taslağınız silinmedi.");
        }
        // Labels are an independent field: refresh only a clean
        // labels draft, never overwrite an unsaved one.
        if (!session.labelsDirty && !session.labelsBusy) {
          session.draftLabels = [...view.labels];
          notePanel.labelsInput.value = "";
          renderDraftLabels();
          session.labelsBaseVersion = view.versions.labels;
          if (!session.colorDirty && !session.colorBusy) populateLabelColors(view.labels);
        } else if (session.labelsDirty) {
          notePanel.labelsStatus.textContent = tmTranslate("Başka görünümde etiketler güncellendi; taslağınız silinmedi.");
        }
      } catch {
        // Keep the current panel content on read failure.
      }
    }
    if (watchPanel && !watchPanel.root.hidden) {
      await renderWatchCenter().catch(() => {});
    }
    if (labelFeedPanel && !labelFeedPanel.root.hidden) await refreshLabelFeed();
    // An open save panel tracks the post's live memory state via
    // one identity read; its reason draft is never touched here.
    if (savePanel && !savePanel.root.hidden && saveSession && saveSession.state === "ready" && !saveSession.removalBusy) {
      const session = saveSession;
      try {
        const client = resolveClient();
        if (client && typeof client.getPostState === "function") {
          const state = await client.getPostState(session.post);
          if (saveSession === session && state && state.post && state.version >= session.stateVersion) {
            session.stateVersion = state.version;
            session.memoryStatus = state.status;
            postStateSeen.set(session.postKey, { status: state.status, version: state.version });
            updateRemoveButton();
          }
        }
      } catch {
        /* keep the panel state on read failure */
      }
    }
  }

  // Reposition open panels on scroll/resize (the trigger may
  // have moved; identity is re-validated inside).
  {
    const view = (doc && doc.defaultView) || (typeof window !== "undefined" ? window : null);
    if (view && typeof view.addEventListener === "function") {
      view.addEventListener("scroll", () => repositionOpenPanels(), true);
      view.addEventListener("resize", () => repositionOpenPanels());
    }
  }

  if (typeof doc.addEventListener === "function") {
    doc.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (savePanel && !savePanel.root.hidden) {
        injector.guardLocalEvent(event);
        closeSavePanel();
      } else if (watchPanel && !watchPanel.root.hidden) {
        injector.guardLocalEvent(event);
        closeWatchPanel();
      } else if (notePanel && !notePanel.root.hidden) {
        injector.guardLocalEvent(event);
        closeNotePanel();
      } else if (labelFeedPanel && !labelFeedPanel.root.hidden) {
        injector.guardLocalEvent(event);
        closeLabelFeed();
      }
    });
  }

  return {
    scan,
    handleStorageChange,
    openNotes,
    openPersonPanel,
    openSavePanel,
    openWatchPanel,
    closeNotePanel,
    closeSavePanel,
    closeWatchPanel,
    openLabelFeed,
    closeLabelFeed,
    getNoteSession: () => (noteSession ? { ...noteSession, trigger: undefined } : null),
    getPersonSession: () => (noteSession ? { ...noteSession, trigger: undefined } : null),
    getSaveSession: () => (saveSession ? { ...saveSession, trigger: undefined } : null),
    getWatchSession: () => (watchSession ? { ...watchSession, trigger: undefined } : null),
    repositionOpenPanels,
    adapter,
  };
}

/* ---------------- mutation ownership filter ---------------- */

/**
 * True when a DOM node belongs to this extension (an injected
 * control, panel, status, or the top-layer tooltip portal), as
 * opposed to host page content. Text nodes resolve via parents.
 */
function isExtensionOwnedNode(node) {
  let current = node && node.nodeType === 3 ? node.parentNode || node.parentElement : node;
  while (current) {
    const dataset = current.dataset || {};
    if (
      dataset.tmTooltipPortal ||
      dataset.tmAction ||
      dataset.tmActions ||
      dataset.tmPanel ||
      dataset.tmStatus
    ) {
      return true;
    }
    if (typeof current.closest === "function") {
      try {
        if (
          current.closest(
            "[data-tm-action],[data-tm-actions],[data-tm-panel],[data-tm-status],[data-tm-tooltip-portal]"
          )
        ) {
          return true;
        }
      } catch {
        /* keep walking manually */
      }
    }
    current = current.parentNode || current.parentElement || null;
  }
  return false;
}

/**
 * Bootstrap observer rule: extension-owned mutations (including
 * tooltip text/add/remove in the body portal) never schedule a
 * scan; genuine host mutations (a new card, a permalink change)
 * always do.
 */
function shouldScheduleScanForMutations(mutations) {
  return (mutations || []).some((mutation) => {
    if (isExtensionOwnedNode(mutation.target)) return false;
    if (mutation.type === "childList") {
      const changed = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
      if (changed.length > 0 && changed.every((node) => isExtensionOwnedNode(node))) {
        return false;
      }
    }
    return true;
  });
}

/* ---------------- extension bootstrap ---------------- */

let extensionClient = null;
function getExtensionClient() {
  if (extensionClient) return extensionClient;
  if (
    typeof chrome === "undefined" ||
    !chrome.runtime ||
    typeof chrome.runtime.sendMessage !== "function" ||
    typeof window === "undefined" ||
    !window.ThreadsMemoryClient
  ) {
    return null;
  }
  extensionClient = window.ThreadsMemoryClient.createExtensionClient({
    sendMessage: (message) => chrome.runtime.sendMessage(message),
  });
  return extensionClient;
}

let liveController = null;
function scanLiveThreads() {
  if (liveController) return liveController.scan();
  return Promise.resolve(LiveThreadsAdapter.findPostElements(document).length);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  liveController = createLiveController({
    document,
    clientProvider: getExtensionClient,
  });

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (!message || message.type !== "tm.ui.openTagFeed" || !sender || sender.id !== chrome.runtime.id || !sender.url || !sender.url.startsWith(chrome.runtime.getURL("src/sidepanel.html"))) return false;
      if (typeof message.label !== "string" || !message.label.trim() || message.label.length > 64) { respond({ ok: false }); return false; }
      liveController.openLabelFeed(message.label, null, null).then(() => respond({ ok: true })).catch(() => respond({ ok: false }));
      return true;
    });
  }

  // Other views' writes refresh this view via storage notifications;
  // open drafts are protected inside the controller.
  if (typeof chrome !== "undefined" && window.ThreadsMemoryClient) {
    window.ThreadsMemoryClient.onStorageChanged(chrome, "tm.v2.", () => {
      void liveController.handleStorageChange();
    });
  }

  let scanTimer = null;
  const scheduleScan = () => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      void liveController.scan();
    }, 60);
  };

  if (typeof MutationObserver !== "undefined" && document.body) {
    const observer = new MutationObserver((mutations) => {
      // Ignore mutations caused by our own injected UI, including
      // the top-layer tooltip portal under body.
      if (shouldScheduleScanForMutations(mutations)) scheduleScan();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "data-interactive-id", "data-pagelet"],
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void Promise.resolve(globalThis.ThreadsMemoryI18n?.ready).then(() => liveController.scan()), { once: true });
  } else {
    void Promise.resolve(globalThis.ThreadsMemoryI18n?.ready).then(() => liveController.scan());
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    LiveThreadsAdapter,
    computePanelPlacement,
    createLiveController,
    scanLiveThreads,
    getExtensionClient,
    isExtensionOwnedNode,
    shouldScheduleScanForMutations,
  };
}
