// Makes the hero's "Start Free Practice Test" button survive being tapped before app.min.js has
// loaded. The button is server-rendered into the HTML (see _worker.js's SSR-HERO block) and is on
// screen at ~1s, but every data-act handler lives in app.min.js, which doesn't run until ~2.5-3s on
// a throttled phone -- so a tap in that window did absolutely nothing, on the one page this whole
// first-paint change exists to fix.
//
// This file is deliberately tiny and deferred: it runs right after the HTML is parsed, long before
// the bundle. It doesn't try to do the scroll itself -- the sample widget it would scroll to isn't
// rendered yet -- it just records that the visitor asked, and app.js replays the click once the
// real page is on screen (see the __pendingHeroCta check in renderCategoryPage).
//
// Its own file rather than an inline <script> for the same reason as turnstile.js and
// gtag-init.js: _headers pins script-src to 'self' with no 'unsafe-inline'.
(function () {
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-act="scroll-to-category-sample"]');
    if (!btn) return;
    // Only meaningful while app.js hasn't taken over; once it has, its own delegated handler runs
    // and this flag is never read again.
    window.__pendingHeroCta = true;
    e.preventDefault();
  });
})();
