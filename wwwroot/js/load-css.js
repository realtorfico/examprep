// Attaches the site stylesheet as an active <link> once the DOM is parsed. The actual network
// fetch is NOT triggered by this script -- it's already started by index.html's
// <link rel="preload" href="/css/style.min.css?..." as="style"> tag, which begins downloading the
// CSS immediately (in parallel with HTML parsing) without blocking rendering the way a plain
// <link rel="stylesheet"> would (PageSpeed Insights flagged ~840ms-1200ms of render-blocking-
// request cost here, 2026-09-13 mobile performance investigation). This script can safely be
// `defer`red (no rush) because by the time it runs, the preload has usually already finished or is
// well underway -- inserting the real stylesheet <link> here just tells the browser to apply CSS
// it's already fetching/fetched, at essentially zero extra cost.
//
// First attempt at this (since reverted) made this script itself do BOTH the fetch and the
// attach, loaded without defer so it would "start early" -- that backfired: a non-deferred
// <script src> blocks HTML parsing the same way a synchronous stylesheet does, so it just moved
// the blocking cost from the CSS request onto this script's own request, sequenced BEFORE the CSS
// fetch could even begin (worse, not better -- confirmed by a live PageSpeed re-test showing
// render-blocking cost go UP). Splitting fetch (preload, non-blocking) from attach (this script,
// deferred) avoids that trap.
//
// The standard rel="preload" + onload="" swap trick (skip this script entirely, just flip the
// preloaded link's rel via an inline onload) isn't usable here -- it needs an inline onload=""
// attribute, which this site's CSP script-src (deliberately kept free of 'unsafe-inline', see
// turnstile-callback.js/gtag-init.js/clarity-init.js for the same reasoning) would silently block,
// leaving the page with no styles applied at all and no visible error. This external-script
// attach is the CSP-safe equivalent.
//
// Safe to defer this attach step at all because this page has zero visible content before app.js
// renders anything (every element in <body> starts as an empty div) -- there's no flash-of-
// unstyled-content risk from the brief extra delay before styles apply. A <noscript> fallback in
// index.html covers the no-JS case.
//
// Keep this file's ?v=, index.html's rel="preload" href, and index.html's <noscript> fallback href
// all in sync whenever style.css/style.min.css changes.
(function () {
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/css/style.min.css?v=12';
  document.head.appendChild(link);
})();
