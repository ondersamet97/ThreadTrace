"use strict";

/*
 * DOM injection helpers shared by the fixture demo and (later) the
 * verified live adapter. The guard is two-layered:
 *  1) a tracker remembers (scope, action) pairs already handled;
 *  2) the DOM itself is checked for an existing [data-tm-action]
 *     element, so re-scans after dynamic navigation never add
 *     a second copy of the same button.
 * Only generic DOM APIs are used (children / appendChild / dataset),
 * no Threads selectors live here.
 */

function createInjectionTracker() {
  const seen = new Set();
  const keyOf = (scope, action) => String(scope) + "::" + String(action);
  return {
    /** Returns true the first time a (scope, action) pair is marked. */
    tryMark(scope, action) {
      const key = keyOf(scope, action);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    has(scope, action) {
      return seen.has(keyOf(scope, action));
    },
    unmark(scope, action) {
      seen.delete(keyOf(scope, action));
    },
    clear() {
      seen.clear();
    },
    get size() {
      return seen.size;
    },
  };
}

function findByDataAttr(root, attr, value) {
  if (!root) return null;
  const children = root.children || root.childNodes || [];
  for (const child of children) {
    if (child.dataset && child.dataset[attr] === value) return child;
    const nested = findByDataAttr(child, attr, value);
    if (nested) return nested;
  }
  return null;
}

function guardLocalEvent(event) {
  if (!event) return;
  if (typeof event.preventDefault === "function") event.preventDefault();
  if (typeof event.stopPropagation === "function") event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
}

function stopLocalEvent(event) {
  if (event && typeof event.stopPropagation === "function") event.stopPropagation();
}

function makeButton(doc, action, text) {
  const button = doc.createElement("button");
  button.type = "button";
  button.dataset.tmAction = action;
  button.className = "tm-btn tm-btn-" + action;
  button.textContent = text;
  if (typeof button.setAttribute === "function") button.setAttribute("aria-label", text);
  // Our buttons live inside the host's pressable card: pressing one
  // must never activate the card's own follow/like/share/navigation.
  button.addEventListener("pointerdown", stopLocalEvent);
  button.addEventListener("mousedown", stopLocalEvent);
  return button;
}

/**
 * Ensures exactly one "save" button and one separate "notes" button
 * exist inside postEl. Safe to call repeatedly (e.g. on every
 * MutationObserver pass during SPA navigation).
 */
function ensurePostButtons({ postEl, postKey, scope, doc, tracker, onSave, onOpenNotes }) {
  if (!postEl || !doc) throw new TypeError("postEl and doc are required");
  // Tracker scope must identify the element, not just the post/person:
  // the same post or person may legitimately appear twice in a feed.
  const trackScope = scope || postKey;
  const created = [];

  let actionsBar = findByDataAttr(postEl, "tmActions", "bar");
  if (!actionsBar) {
    actionsBar = doc.createElement("div");
    actionsBar.dataset.tmActions = "bar";
    actionsBar.className = "tm-actions";
    actionsBar.addEventListener("pointerdown", stopLocalEvent);
    actionsBar.addEventListener("mousedown", stopLocalEvent);
    postEl.appendChild(actionsBar);
  }

  const specs = [
    { action: "save", text: "Hafızaya ekle", handler: onSave },
    { action: "notes", text: "Notlar", handler: onOpenNotes },
  ];

  for (const spec of specs) {
    const alreadyInDom = findByDataAttr(postEl, "tmAction", spec.action);
    if (alreadyInDom) {
      if (tracker) tracker.tryMark(trackScope, spec.action);
      continue;
    }
    if (tracker && !tracker.tryMark(trackScope, spec.action)) continue;
    const button = makeButton(doc, spec.action, spec.text);
    if (typeof spec.handler === "function") {
      // Handlers receive the element at click time, never data captured
      // at injection time: hosts may recycle one element for another
      // post/person, and the click must target the current content.
      button.addEventListener("click", (event) => {
        guardLocalEvent(event);
        return spec.handler(postEl, event);
      });
    }
    actionsBar.appendChild(button);
    created.push(spec.action);
  }

  return { created, skipped: created.length === 0 };
}

/** Ensures one editable-label slot next to a person's name. */
function ensureLabelSlot({ hostEl, personKey, scope, doc, tracker, afterElement }) {
  if (!hostEl || !doc) throw new TypeError("hostEl and doc are required");
  const trackScope = scope || personKey;
  const existing = findByDataAttr(hostEl, "tmAction", "labels");
  if (existing) {
    if (tracker) tracker.tryMark(trackScope, "labels");
    return { slot: existing, created: false };
  }
  if (tracker && !tracker.tryMark(trackScope, "labels")) {
    return { slot: null, created: false };
  }
  const slot = doc.createElement("span");
  slot.dataset.tmAction = "labels";
  slot.className = "tm-labels";
  // Prefer placing the slot immediately after the author's name link
  // ("next to the name") when the host supports it.
  const parent = afterElement && (afterElement.parentNode || afterElement.parentElement);
  if (parent === hostEl && typeof hostEl.insertBefore === "function") {
    hostEl.insertBefore(slot, afterElement.nextSibling || null);
  } else {
    hostEl.appendChild(slot);
  }
  return { slot, created: true };
}

let tooltipSeq = 0;

/** Clamps a tooltip box fully inside the viewport (8px margins). */
function clampTooltipPosition({ buttonRect, tooltipSize, viewport }) {
  const margin = 8;
  const maxLeft = Math.max(margin, viewport.width - tooltipSize.width - margin);
  let left = buttonRect.left + buttonRect.width / 2 - tooltipSize.width / 2;
  left = Math.min(Math.max(left, margin), maxLeft);
  let top = buttonRect.top - tooltipSize.height - 6;
  if (top < margin) top = buttonRect.bottom + 6;
  if (top + tooltipSize.height > viewport.height - margin) {
    top = Math.max(margin, viewport.height - tooltipSize.height - margin);
  }
  return { left: Math.round(left), top: Math.round(top) };
}

function positionTooltip(button, tooltip, doc) {
  if (!button || !tooltip || typeof button.getBoundingClientRect !== "function") return;
  const view = (doc && doc.defaultView) || (typeof window !== "undefined" ? window : null);
  if (!view || typeof view.innerWidth !== "number") return;
  const rect = button.getBoundingClientRect();
  const size = {
    width: tooltip.offsetWidth || Math.min(260, (tooltip.textContent || "").length * 7 + 16),
    height: tooltip.offsetHeight || 28,
  };
  const pos = clampTooltipPosition({
    buttonRect: rect,
    tooltipSize: size,
    viewport: { width: view.innerWidth, height: view.innerHeight },
  });
  tooltip.style.left = pos.left + "px";
  tooltip.style.top = pos.top + "px";
}

/** Children as a real array (Chrome HTMLCollection has no .find). */
function childArray(el) {
  if (!el || !el.children) return [];
  return Array.from(el.children);
}

/** Class check safe for SVG elements (className is SVGAnimatedString). */
function hasClass(el, name) {
  if (!el) return false;
  if (el.classList && typeof el.classList.contains === "function") {
    try {
      return el.classList.contains(name);
    } catch {
      /* fall through */
    }
  }
  const value = el.className;
  const text =
    typeof value === "string"
      ? value
      : value && typeof value.baseVal === "string"
        ? value.baseVal
        : "";
  return text.split(/\s+/).includes(name);
}

/** Removes top-layer tooltips whose owner button left the DOM. */
function cleanupDetachedTooltips(doc) {
  const root = doc && doc.body;
  if (!root) return;
  for (const el of childArray(root)) {
    if (hasClass(el, "tm-tooltip") && el._tmOwner && el._tmOwner.isConnected === false) {
      if (typeof el.remove === "function") el.remove();
      else if (el.parentNode) el.parentNode.children = childArray(el.parentNode).filter((c) => c !== el);
    }
  }
}

/**
 * Creates/reuses an accessible tooltip in the top layer (doc.body),
 * never inside the button: a transformed/overflowing card ancestor
 * would otherwise clip it. One tooltip per button; its text always
 * matches the button's current aria description. It hides on
 * mouseleave/blur and on scroll/resize (and is repositioned if the
 * button is still shown afterwards via a fresh hover/focus).
 */
function attachTooltip(button, doc, text) {
  cleanupDetachedTooltips(doc);
  let span = button._tmTooltipEl || null;
  const root = doc && doc.body ? doc.body : button;
  if (span && span.parentNode !== root && typeof root.appendChild === "function") {
    root.appendChild(span);
  }
  if (!span) {
    span = doc.createElement("span");
    span.className = "tm-tooltip";
    // Reliable ownership marker: host mutation observers must be
    // able to tell this top-layer portal apart from page content.
    if (span.dataset) span.dataset.tmTooltipPortal = "true";
    if (typeof span.setAttribute === "function") span.setAttribute("role", "tooltip");
    tooltipSeq += 1;
    span.id = button.dataset && button.dataset.tmTooltipId
      ? button.dataset.tmTooltipId
      : "tm-tooltip-" + tooltipSeq;
    if (button.dataset) button.dataset.tmTooltipId = span.id;
    span._tmOwner = button;
    button._tmTooltipEl = span;
    root.appendChild(span);
  }
  if (span.textContent !== text) span.textContent = text;
  if (typeof button.setAttribute === "function") {
    button.setAttribute("aria-describedby", span.id);
  }
  if (!button._tmTooltipWired) {
    button._tmTooltipWired = true;
    const view = (doc && doc.defaultView) || (typeof window !== "undefined" ? window : null);
    const show = () => {
      if (button.isConnected === false) {
        if (span.parentNode && typeof span.remove === "function") span.remove();
        return;
      }
      positionTooltip(button, span, doc);
      span.className = "tm-tooltip tm-tooltip-visible";
    };
    const hide = () => {
      span.className = "tm-tooltip";
    };
    button._tmTooltipHide = hide;
    button.addEventListener("mouseenter", show);
    button.addEventListener("focus", show);
    button.addEventListener("mouseleave", hide);
    button.addEventListener("blur", hide);
    if (view && typeof view.addEventListener === "function") {
      view.addEventListener("scroll", hide, true);
      view.addEventListener("resize", hide);
    }
  }
  return span;
}

/**
 * Ensures a compact row of icon-only action buttons inside the
 * post's own action row (mountEl, falling back to the card). No
 * visible text is rendered; each button carries an accessible name
 * and a viewport-clamped tooltip (hover and keyboard focus).
 * Enter/Space activate exactly once and never leak to the host
 * card's keyboard navigation.
 * actions: [{ action, ariaLabel, tooltip, iconSvg, onClick }]
 */
function ensureActionIcons({ postEl, mountEl, scope, doc, tracker, actions }) {
  if (!postEl || !doc) throw new TypeError("postEl and doc are required");
  const trackScope = scope || "card";
  const mount = mountEl || postEl;
  let bar = findByDataAttr(postEl, "tmActions", "bar");
  if (!bar) {
    bar = doc.createElement("div");
    bar.dataset.tmActions = "bar";
    bar.className = "tm-actions tm-icon-actions";
    bar.addEventListener("pointerdown", stopLocalEvent);
    bar.addEventListener("mousedown", stopLocalEvent);
    mount.appendChild(bar);
  } else if (bar !== mount && bar.parentNode !== mount && bar.parentElement !== mount) {
    mount.appendChild(bar);
  }
  const buttons = {};
  for (const spec of actions || []) {
    let button = findByDataAttr(postEl, "tmAction", spec.action);
    if (!button) {
      if (tracker && !tracker.tryMark(trackScope, spec.action)) continue;
      button = doc.createElement("button");
      button.type = "button";
      button.dataset.tmAction = spec.action;
      button.className = "tm-icon-btn tm-icon-" + spec.action;
      button.innerHTML = spec.iconSvg || "";
      let keyActivated = false;
      // A mouse press always starts a fresh activation: it clears
      // any stale keyboard flag (a preventDefaulted keydown may
      // never produce a native click to consume it).
      button.addEventListener("pointerdown", (event) => {
        keyActivated = false;
        stopLocalEvent(event);
      });
      button.addEventListener("mousedown", stopLocalEvent);
      button.addEventListener("keydown", (event) => {
        if (!event || (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar")) return;
        // Keep Enter/Space away from the host card's navigation.
        guardLocalEvent(event);
        if (event.repeat) return; // holding the key must not re-fire
        keyActivated = true;
        // Backstop: if no native click ever arrives, the flag
        // expires instead of swallowing a later mouse click.
        const view = (doc && doc.defaultView) || (typeof window !== "undefined" ? window : null);
        if (view && typeof view.setTimeout === "function") {
          view.setTimeout(() => {
            keyActivated = false;
          }, 1000);
        }
        return spec.onClick(postEl, event);
      });
      button.addEventListener("keyup", (event) => {
        if (event && (event.key === " " || event.key === "Spacebar")) stopLocalEvent(event);
      });
      button.addEventListener("click", (event) => {
        guardLocalEvent(event);
        if (keyActivated) {
          keyActivated = false;
          return undefined;
        }
        // Resolve the card at click time, never captured data.
        return spec.onClick(postEl, event);
      });
      bar.appendChild(button);
    } else if (tracker) {
      tracker.tryMark(trackScope, spec.action);
    }
    if (typeof button.setAttribute === "function") {
      button.setAttribute("aria-label", spec.ariaLabel);
      // Only (re)write the base tooltip when the spec text actually
      // changed; a state-specific tooltip (e.g. saved/unsaved) set
      // by the caller afterwards must survive later scans.
      if (!button._tmTooltipEl || button.dataset.tmSpecTooltip !== (spec.tooltip || spec.ariaLabel)) {
        button.setAttribute("data-tooltip", spec.tooltip || spec.ariaLabel);
        attachTooltip(button, doc, spec.tooltip || spec.ariaLabel);
        if (button.dataset) button.dataset.tmSpecTooltip = spec.tooltip || spec.ariaLabel;
      }
    }
    buttons[spec.action] = button;
  }
  return buttons;
}

const ThreadsMemoryInjectorApi = {
  createInjectionTracker,
  findByDataAttr,
  ensurePostButtons,
  ensureActionIcons,
  clampTooltipPosition,
  positionTooltip,
  attachTooltip,
  childArray,
  hasClass,
  cleanupDetachedTooltips,
  ensureLabelSlot,
  guardLocalEvent,
  stopLocalEvent,
};

if (typeof module !== "undefined" && module.exports) module.exports = ThreadsMemoryInjectorApi;
if (typeof window !== "undefined") window.ThreadsMemoryInjector = ThreadsMemoryInjectorApi;
if (typeof self !== "undefined") self.ThreadsMemoryInjector = ThreadsMemoryInjectorApi;
