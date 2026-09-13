// Loads the site stylesheet without blocking initial HTML parsing/paint -- a native
// <link rel="stylesheet"> tag blocks rendering until the CSS downloads and parses (PageSpeed
// Insights flagged ~840ms of render-blocking-request cost here, 2026-09-13 mobile performance
// investigation). Inserting the link via script instead starts the same fetch immediately (this
// script is intentionally NOT deferred -- it runs synchronously, right where the <link> tag used
// to sit, so the CSS request begins as early as possible) but doesn't block parsing on the fetch's
// completion the way the native tag would.
//
// The standard rel="preload" + onload="" swap trick isn't usable here -- it needs an inline
// onload="" attribute, which this site's CSP script-src (deliberately kept free of
// 'unsafe-inline', see turnstile-callback.js/gtag-init.js/clarity-init.js for the same reasoning)
// would silently block, leaving the page with no styles applied at all and no visible error.
//
// Safe to do here specifically because this page has zero visible content before app.js renders
// anything (every element in <body> starts as an empty div) -- there's no flash-of-unstyled-content
// risk to weigh against the render-blocking savings. A <noscript> fallback in index.html covers the
// no-JS case (which, on a JS-rendered SPA with no server-rendered content, wouldn't show anything
// styled or not anyway, but costs nothing to include).
//
// Keep this file's ?v= and the href below in sync with index.html's own style.min.css reference
// whenever style.css/style.min.css changes.
(function () {
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/css/style.min.css?v=1';
  document.head.appendChild(link);
})();
