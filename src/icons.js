"use strict";

/*
 * Icons: Lucide (https://lucide.dev), ISC License.
 * The path data below is copied verbatim from the official Lucide
 * SVG sources (icons/bookmark.svg, icons/radar.svg,
 * icons/user-round.svg in lucide-icons/lucide); only width/height
 * are set at render time. Full license text:
 * LICENSES/Lucide-ISC.txt (also shipped in the extension package).
 * No icon package was installed.
 */

const LUCIDE_PATHS = {
  // lucide "bookmark" (official)
  bookmark:
    '<path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z" />',
  // lucide "radar" (official)
  radar:
    '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/>' +
    '<path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/>' +
    '<circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>',
  // lucide "user-round" (official)
  person: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
};

function lucideSvg(name, size) {
  const px = size || 19;
  return (
    '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px + '" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    LUCIDE_PATHS[name] +
    "</svg>"
  );
}

const ThreadsMemoryIconsApi = { LUCIDE_PATHS, lucideSvg };

if (typeof module !== "undefined" && module.exports) module.exports = ThreadsMemoryIconsApi;
if (typeof window !== "undefined") window.ThreadsMemoryIcons = ThreadsMemoryIconsApi;
if (typeof self !== "undefined") self.ThreadsMemoryIcons = ThreadsMemoryIconsApi;
