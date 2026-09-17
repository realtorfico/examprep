// What a phone visitor sees in the first second of an ad landing page (/cdl), and whether the copy
// on it is honest. Added 2026-09-17 after measuring the live page on an emulated Pixel 7 at
// 1.6Mbps/150ms RTT with 4x CPU throttling (Playwright, see the run in that day's session):
//
//   first paint            1012ms   (blank cream page -- every element in <body> is an empty div)
//   first CONTENTFUL paint 2748ms
//   largest contentful     3840ms
//   headline readable     ~2800ms
//
// Nothing was on screen for the first ~2.8s because index.html ships no content at all: /cdl's HTML
// has an empty <div id="app"></div> and the entire hero is built by app.min.js -- which couldn't
// even start downloading until 2258ms, queued behind ~10 other scripts. A visitor who leaves "after
// a couple of seconds" never saw the page.
//
// Three fixes, all in our own code:
// 1. _worker.js server-renders the static top of the hero (eyebrow, H1, subhead, mobile CTA) into
//    #app, so readable content is in the HTML itself. app.js still owns the page: its own
//    appEl.innerHTML render replaces this markup wholesale, so the two must MATCH -- tests below
//    compare the server's hero against the client's, string for string, or the swap would show as a
//    flash/shift on the site's highest-traffic pages (the 2026-09-09 CLS fix history).
// 2. css/hero.css: a small BLOCKING stylesheet for just that server-rendered hero. style.min.css
//    stays on its preload + deferred-attach path (load-css.js), whose safety argument was
//    explicitly "this page has zero visible content before app.js renders anything" -- true before
//    fix 1, false after it, so server-rendered text would otherwise paint unstyled and then reflow.
//    Inline <style> is not an option: _headers pins style-src to 'self' with no 'unsafe-inline'.
// 3. index.html preloads app.min.js at high fetchpriority so the file that renders everything else
//    stops being last in the queue.
//
// Plus two copy/logic defects found in the same pass:
// 4. The subhead was built with kind.toLowerCase(), which printed "commercial driver (cdl) exam" --
//    lowercased acronym -- on every category landing page, including the paid CDL destination.
// 5. The state banner said "Based on your saved location" even on a visitor's very first hit, where
//    the state came from _worker.js's request.cf geolocation, not from anything they saved. The
//    worker now stamps <meta name="pxq-geo-state"> on exactly the response where it geo-set the
//    cookie, so the client can say "Based on your location" there and stay neutral otherwise --
//    deliberately NOT a second cookie, so the privacy page's "We set one cookie" stays true.
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp, waitFor, settle } = require('../test-support/boot-app');

const WWWROOT = path.join(__dirname, '..', 'wwwroot');
const WORKER = fs.readFileSync(path.join(WWWROOT, '_worker.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(WWWROOT, 'index.html'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(WWWROOT, 'css', 'style.css'), 'utf8');
const HERO_CSS_FILE = path.join(WWWROOT, 'css', 'hero.css');

// _worker.js is an ES module (export default) inside a "type": "commonjs" package, so it can't be
// require()d here the way a test would normally import the code under test. Rather than assert on
// its source as a string -- which would let the server hero drift from the client's without any
// test noticing -- pull the hero builder out from between its sentinel comments and eval it, so the
// equivalence tests below run the worker's REAL markup. Same trick keeps CATEGORY_HERO honest.
function loadWorkerBlocks() {
  const hero = WORKER.match(/\/\/ >>> SSR-HERO[\s\S]*?\/\/ <<< SSR-HERO/);
  const header = WORKER.match(/\/\/ >>> SSR-HEADER[\s\S]*?\/\/ <<< SSR-HEADER/);
  assert.ok(hero, '_worker.js should keep its hero builder between "// >>> SSR-HERO" and "// <<< SSR-HERO" markers, so this test can exercise it');
  assert.ok(header, '_worker.js should keep its header builder between "// >>> SSR-HEADER" and "// <<< SSR-HEADER" markers');
  const exported = {};
  // Both blocks are deliberately self-contained (their own escape/case helpers, no reference to the
  // worker's other top-level consts or to env) precisely so this eval exercises them faithfully.
  new Function('exports', hero[0] + '\n' + header[0] +
    '\nexports.CATEGORY_HERO = CATEGORY_HERO;' +
    '\nexports.categoryHeroHtml = categoryHeroHtml;' +
    '\nexports.siteHeaderHtml = siteHeaderHtml;' +
    '\nexports.headerPromoRibbonHtml = headerPromoRibbonHtml;' +
    '\nexports.HEADER_RIBBON_FALLBACK = HEADER_RIBBON_FALLBACK;\n')(exported);
  return exported;
}

const { CATEGORY_HERO, categoryHeroHtml, siteHeaderHtml, headerPromoRibbonHtml, HEADER_RIBBON_FALLBACK } = loadWorkerBlocks();

// Text of one element from an HTML string, by id -- the server hero is a string, not a DOM.
function tagText(html, id) {
  const m = html.match(new RegExp('<[a-z0-9]+[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)<\\/'));
  return m ? m[1].trim() : null;
}
function classOf(html, id) {
  const m = html.match(new RegExp('<[a-z0-9]+[^>]*id="' + id + '"[^>]*class="([^"]*)"'));
  return m ? m[1] : null;
}

async function bootCategory(t, slug, extra) {
  const booted = await bootApp(Object.assign({ url: 'https://passexamhq.com/' + slug }, extra || {}));
  t.after(() => booted.dom.window.close());
  await waitFor(() => booted.document.getElementById('category-hero-headline'));
  await settle();
  return booted;
}

// ---- 1. The server ships readable hero content -------------------------------------------------

test('the worker injects the hero into #app rather than leaving it empty', () => {
  assert.match(WORKER, /\.on\('#app'/, 'withSeoMeta (or a sibling rewriter) should target #app to inject the first-paint hero');
  assert.match(WORKER, /setInnerContent\(\s*hero/i, 'the hero HTML should be written into #app as html');
});

test('every category the client can render has a server-rendered hero', () => {
  // Source of truth is app.js's own HUB_KIND_SLUGS -- the list of slugs route() will render a
  // category page for -- read from its source rather than restated here, so a new category kind
  // can't quietly ship without the server hero and go back to painting blank for ~2.8s. (SEO_META
  // would be the wrong list: it carries /blog, which is not a category page, and has no entries
  // for the four national kinds.)
  const APP_JS = fs.readFileSync(path.join(WWWROOT, 'js', 'app.js'), 'utf8');
  const mapSrc = APP_JS.slice(APP_JS.indexOf('var HUB_KIND_SLUGS = {'));
  const pairs = [...mapSrc.slice(0, mapSrc.indexOf('};')).matchAll(/'([^']+)':\s*'([^']+)'/g)];
  assert.ok(pairs.length >= 12, 'expected to parse HUB_KIND_SLUGS out of app.js, found ' + pairs.length + ' entries');
  for (const [, kind, slug] of pairs) {
    assert.equal(CATEGORY_HERO[slug], kind, 'CATEGORY_HERO[' + slug + '] should be the same kind label app.js uses');
    const html = categoryHeroHtml(slug);
    assert.match(html, /<h1 id="category-hero-headline">/, '/' + slug + ' hero should carry the H1');
    assert.match(html, /id="category-hero-subhead"/, '/' + slug + ' hero should carry the subhead');
    assert.match(html, /data-act="scroll-to-category-sample"/, '/' + slug + ' hero should carry the practice CTA');
  }
});

test('the server hero is empty for anything that is not a category landing page', () => {
  assert.equal(categoryHeroHtml('not-a-category'), '', 'unknown slugs must not get a hero');
  assert.equal(categoryHeroHtml(''), '', 'the homepage must not get a category hero');
  assert.equal(categoryHeroHtml('blog'), '', '/blog has SEO_META but is not a category page');
});

// ---- 2. Server hero == client hero (or the swap is a visible flash) ----------------------------

for (const slug of ['cdl', 'notary', 'dat']) {
  test('the server hero matches the client hero on /' + slug, async (t) => {
    const { document } = await bootCategory(t, slug);
    const server = categoryHeroHtml(slug);

    assert.equal(
      tagText(server, 'category-hero-headline'),
      document.getElementById('category-hero-headline').textContent.trim(),
      'server and client H1 must match exactly, or the client render visibly re-writes the headline',
    );
    assert.equal(
      tagText(server, 'category-hero-subhead'),
      document.getElementById('category-hero-subhead').textContent.trim(),
      'server and client subhead must match exactly',
    );
    assert.equal(
      document.querySelector('.hub-hero-copy .section-eyebrow'),
      null,
      'the eyebrow above the H1 repeated the H1 word for word; it was removed 2026-09-17 to give the offer and CTA that space on a phone',
    );
    assert.ok(!server.includes('section-eyebrow'), 'the server hero must not reintroduce the eyebrow either');
  });
}

// ---- 2d. The server-rendered CTA works before app.min.js has loaded ---------------------------

// The hero's practice button is on screen at ~1s but app.min.js, which owns every data-act
// handler, doesn't run until ~3s. A tap in that 2-second window did nothing at all -- the worst
// possible impression on the page this whole change exists to fix. js/early-cta.js is a ~0.5KB
// deferred script that records the click; app.js replays it once the page is really rendered.
test('index.html loads the early CTA script before the bundle', () => {
  assert.match(INDEX, /<script defer src="\/js\/early-cta\.js\?v=\d+"><\/script>/, 'early-cta.js should load with defer from <head>, so it runs long before app.min.js');
  // Against the <script> tag, not the preload <link> -- the preload is deliberately near the top
  // of <head>, well before this.
  assert.ok(
    INDEX.indexOf('early-cta.js') < INDEX.indexOf('<script defer src="/js/app.min.js'),
    'it must come before app.min.js\'s script tag in document order',
  );
});

test('the early CTA script records a click on the server-rendered button', () => {
  const src = fs.readFileSync(path.join(WWWROOT, 'js', 'early-cta.js'), 'utf8');
  const window = { location: { pathname: '/cdl' } };
  const listeners = {};
  const doc = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    readyState: 'loading',
  };
  new Function('window', 'document', src)(window, doc);
  assert.ok(listeners.click, 'early-cta.js should attach a click listener');

  // A click on the CTA is recorded...
  let defaultPrevented = false;
  const target = { closest: (sel) => (sel.includes('scroll-to-category-sample') ? target : null) };
  listeners.click({ target, preventDefault: () => { defaultPrevented = true; } });
  assert.equal(window.__pendingHeroCta, true, 'the click should be recorded for app.js to replay');
  assert.equal(defaultPrevented, true, 'and the dead click should not do anything else in the meantime');

  // ...and a click on anything else is ignored.
  window.__pendingHeroCta = false;
  listeners.click({ target: { closest: () => null }, preventDefault: () => {} });
  assert.equal(window.__pendingHeroCta, false, 'unrelated clicks must pass straight through');
});

test('app.js replays a CTA click that happened before it loaded', async (t) => {
  const { document, window } = await bootApp({
    url: 'https://passexamhq.com/cdl',
    windowSetup: (w) => {
      w.__pendingHeroCta = true;
      // jsdom has no layout, so scrollIntoView is a no-op stub -- record what it was called on.
      w.Element.prototype.scrollIntoView = function () { w.__lastScrollIntoViewId = this.id; };
    },
  });
  t.after(() => window.close());
  await waitFor(() => document.getElementById('category-hero-headline'));
  await settle();

  assert.equal(window.__pendingHeroCta, false, 'app.js should consume the pending click rather than leaving it to fire again on the next render');
  assert.ok(window.__lastScrollIntoViewId === 'category-sample', 'app.js should scroll to the sample widget, the same thing the button does once it is live (got: ' + window.__lastScrollIntoViewId + ')');
});

test('the server hero ships the same mobile CTA button as the client hero', async (t) => {
  const { document } = await bootCategory(t, 'cdl');
  const clientBtn = document.querySelector('.hub-hero-cta-early .hub-hero-btn');
  const server = categoryHeroHtml('cdl');
  assert.ok(clientBtn, 'client hero should still have the early (mobile) CTA this test compares against');
  assert.ok(server.includes(clientBtn.className), 'server CTA classes should match the client CTA (' + clientBtn.className + ')');
  assert.ok(server.includes('>' + clientBtn.textContent.trim() + '<'), 'server CTA label should match the client CTA label');
  assert.ok(server.includes('class="hub-hero-cta hub-hero-cta-early"'), 'server CTA wrapper should match the client wrapper, which is what CSS shows on mobile only');
});

// ---- 2a2. CDL's own hero copy -----------------------------------------------------------------

// CDL is the paid-traffic destination and gets copy written for it rather than the generic per-kind
// template: a headline that matches how people search ("CDL Exam Prep", not the registry's
// "Commercial Driver (CDL) Exam Prep") and a subhead that says what the product actually is.
// Requested by the user 2026-09-17. Kept in code, not the category-content CMS, so the worker can
// server-render it at first paint -- hero_headline/hero_subhead are null for cdl in the API, and a
// CMS value would arrive ~2s later and change the text under the visitor.
const CDL_SUBHEAD = 'Pass your state\'s CDL knowledge test with real practice questions built from your own state\'s official CDL handbook — all 50 states, instant access, one-time purchase.';

test('the CDL hero uses its own headline and subhead', async (t) => {
  const { document } = await bootCategory(t, 'cdl');
  assert.equal(document.getElementById('category-hero-headline').textContent.trim(), 'CDL Exam Prep');
  assert.equal(document.getElementById('category-hero-subhead').textContent.trim(), CDL_SUBHEAD);
});

test('the server renders CDL\'s own copy too', () => {
  const server = categoryHeroHtml('cdl');
  assert.equal(tagText(server, 'category-hero-headline'), 'CDL Exam Prep');
  assert.ok(server.includes(CDL_SUBHEAD.replace(/&/g, '&amp;')), 'the server hero should carry the same subhead, or the client render rewrites it');
});

test('other categories keep the generic per-kind copy', async (t) => {
  const { document } = await bootCategory(t, 'notary');
  assert.equal(document.getElementById('category-hero-headline').textContent.trim(), 'Notary Exam Prep');
  assert.match(document.getElementById('category-hero-subhead').textContent, /^Practice questions for your state's notary exam/);
});

// ---- 2b. Server header == client header (this is what keeps CLS at zero) ----------------------

// #site-header is an empty div until app.js fills it. Once the hero paints at ~0.8s, that late fill
// shoved the hero down and took CLS from ~0 to 1.34 (measured on /cdl, 2026-09-17). A CSS height
// reservation can't fix it honestly -- the header measures 98px to 212px depending on width and on
// how the promo text wraps -- so the worker ships the header's real markup, including the real
// promo, and the browser computes the height. These tests are what keep the two renders identical;
// any divergence is a shift.
const PROMO = {
  id: 4242,
  title: 'First-time buyers: {{refundPct}}% off full CDL access',
  body: 'ignored in the ribbon variant',
  promoCode: 'NEWCDL20',
  requiredEmailDomain: null,
  ctaLabel: null,
  ctaUrl: null,
  requiredTrackKind: 'Commercial Driver (CDL)',
};

test('the server header markup matches what app.js renders for a logged-out visitor', async (t) => {
  const { document, window } = await bootCategory(t, 'cdl');
  // app.js's own header render, with its ribbon filled by its own promo markup -- compared against
  // the worker's. Both sides get the same promo and the same config defaults.
  const clientRibbon = window.promoBannersHtml([PROMO], true, false);
  const clientHeader = document.getElementById('site-header').innerHTML;
  const serverHeader = siteHeaderHtml(clientRibbon);

  // The ribbon's content differs by construction here (the boot harness stubs /promotions empty),
  // so compare the header with its ribbon slot normalised away, then compare ribbons separately.
  const stripRibbon = (html) => html.replace(/(<div id="promo-ribbon-wrap" class="promo-ribbon">)[\s\S]*?(<\/div>\s*)$/, '$1$2').trim();
  assert.equal(stripRibbon(serverHeader), stripRibbon(clientHeader), 'server and client header rows must be identical markup, or app.js\'s re-render shifts the page');
});

test('the server ribbon markup matches app.js\'s own promo ribbon', async (t) => {
  const { window } = await bootCategory(t, 'cdl');
  const client = window.promoBannersHtml([PROMO], true, false);
  const server = headerPromoRibbonHtml(PROMO, { refundFailurePercent: window.refundFailurePercent });
  assert.equal(server, client, 'the ribbon is the tallest, most variable part of the header -- a mismatch here is a visible jump');
});

test('the server ribbon falls back to the same tagline app.js uses when there is no promo', async (t) => {
  const { window } = await bootCategory(t, 'cdl');
  assert.equal(headerPromoRibbonHtml(null, {}), window.promoRibbonFallbackHtml(), 'no-promo fallback must match too, or pages without a promo shift instead');
  assert.equal(HEADER_RIBBON_FALLBACK, window.promoRibbonFallbackHtml());
});

test('promo placeholders resolve the same way on both sides', async (t) => {
  const { window } = await bootCategory(t, 'cdl');
  const server = headerPromoRibbonHtml(PROMO, { refundFailurePercent: 35, accuracyPassPct: 80, coveragePassPct: 50 });
  assert.ok(server.includes('35% off'), 'the worker should substitute {{refundPct}} from /config, got: ' + server.slice(0, 160));
  assert.ok(!server.includes('{{'), 'no placeholder should survive into the server-rendered ribbon');
  // And app.js's own default, when /config hasn't answered, is what the worker falls back to.
  assert.ok(headerPromoRibbonHtml(PROMO, {}).includes(window.refundFailurePercent + '% off'), 'with no config the worker should use app.js\'s own pre-fetch default');
});

test('the real promo ribbon only goes into pages that are not edge-cached', () => {
  const handler = WORKER.slice(WORKER.indexOf('const ribbonHtml ='), WORKER.indexOf('const ribbonHtml =') + 400);
  assert.match(handler, /url\.pathname === '\/' \|\| isCategoryPageRequest/, 'a promo-specific ribbon must only be injected on the responses already marked private/no-store, or a cached page would serve an expired promo');
  assert.match(handler, /HEADER_RIBBON_FALLBACK/, 'every other HTML page should get the static, cache-safe fallback ribbon');
});

// ---- 2c. The client re-render must not undo the server's work ---------------------------------

// Server-rendering the header fixed the hero being shoved DOWN, and uncovered the mirror image:
// renderSiteHeader() rebuilds the header with an EMPTY ribbon (fillPromoRibbon's fetch fills it a
// beat later), so on a server-rendered page the ribbon collapsed from its real height to the
// reserved 2.25rem and everything jumped UP 54px, then back down when the fetch landed. Measured
// as two more shifts, 0.40 and 0.88. The ribbon's current content has to survive a header
// re-render.
test('a header re-render keeps the ribbon that is already on screen', async (t) => {
  const { document, window } = await bootCategory(t, 'cdl');
  const wrap = document.getElementById('promo-ribbon-wrap');
  assert.ok(wrap, 'the header should have a ribbon wrap after the first render');
  const sentinel = '<div class="promo-banner"><strong>SERVER RENDERED PROMO</strong></div>';
  wrap.innerHTML = sentinel;

  window.renderSiteHeader();

  const after = document.getElementById('promo-ribbon-wrap');
  assert.ok(after, 'the ribbon wrap should still exist after a re-render');
  assert.equal(after.innerHTML, sentinel, 'a header re-render must not blank a ribbon that already has content -- that collapse is a visible jump');
});

// The footer is a real, visible element at first paint: #app holds only the server-rendered hero
// (~320px), so on a phone the footer sits at ~838px, inside the viewport, and then slides as #app
// fills to its real ~5100px. Reserving a viewport's worth of height for #app while it holds only
// the server hero puts the footer below the fold from the start, where it ends up anyway. Safe in
// both directions: once app.js renders, #app is the whole page and always taller than 100vh.
test('the worker marks #app as holding only the server-rendered hero', () => {
  assert.match(WORKER, /setAttribute\('class', 'app-ssr-reserve'\)|app-ssr-reserve/, '_worker.js should mark #app so CSS can reserve a viewport of height for the server-only render');
});

test('style.css reserves a viewport of height for the server-only render', () => {
  assert.match(STYLE_CSS, /#app\.app-ssr-reserve\s*\{[^}]*min-height:\s*100vh/, 'style.css should carry the #app.app-ssr-reserve reservation');
  const heroCss = fs.readFileSync(HERO_CSS_FILE, 'utf8');
  assert.match(heroCss, /app-ssr-reserve/, 'the reservation must be in hero.css too -- it has to apply at the very first paint, before style.min.css attaches');
});

test('app.js drops the reservation once it renders the real page', async (t) => {
  const { document } = await bootCategory(t, 'cdl');
  assert.equal(document.getElementById('app').classList.contains('app-ssr-reserve'), false, 'app.js should remove the reservation class when it renders, so the class never outlives the server-only state');
});

test('the hero fonts are deliberately not preloaded', () => {
  // Measured both ways on 2026-09-17. Preloading them removed a 4px reflow when they swap in
  // (0.007 CLS -- invisible), and cost ~420ms of first contentful paint: 113KB of high-priority
  // font bytes ahead of everything else on a 1.6Mbps link took FCP from ~800ms to a consistent
  // ~1220ms over three runs. This test exists so the "obvious" optimisation isn't re-added without
  // re-measuring; hero.css's @font-face with font-display:swap is the right trade here.
  assert.ok(!/rel="preload"[^>]*as="font"/.test(INDEX), 'a font preload is back in index.html -- re-measure FCP before keeping it');
  const heroCss = fs.readFileSync(HERO_CSS_FILE, 'utf8');
  assert.match(heroCss, /font-display:\s*swap/, 'the hero fonts must stay font-display:swap, so text paints in a fallback face rather than waiting');
});

// ---- 3. The hero paints styled, and app.min.js stops being last in the queue -------------------

test('index.html loads hero.css as a blocking stylesheet', () => {
  assert.match(INDEX, /<link rel="stylesheet" href="\/css\/hero\.css\?v=\d+">/, 'the server-rendered hero needs its critical CSS applied at first paint, so this one must be a plain blocking <link> (not the preload + deferred-attach path style.min.css uses)');
  assert.ok(fs.existsSync(HERO_CSS_FILE), 'wwwroot/css/hero.css should exist');
});

test('index.html preloads app.min.js at high priority, at the version it actually loads', () => {
  const script = INDEX.match(/<script defer src="\/js\/app\.min\.js\?v=(\d+)">/);
  assert.ok(script, 'index.html should still load app.min.js with defer');
  const preload = INDEX.match(/<link rel="preload" as="script" fetchpriority="high" href="\/js\/app\.min\.js\?v=(\d+)">/);
  assert.ok(preload, 'app.min.js should be preloaded at high fetchpriority -- it renders the whole page and was starting last, at 2258ms');
  assert.equal(preload[1], script[1], 'the preload and the script tag must carry the same ?v= or the browser downloads the bundle twice');
});

test('the committed hero.css is what style.css currently generates', () => {
  // hero.css is a generated subset of style.css (scripts/build-hero-css.js). Regenerating here and
  // comparing means a retuned design token or an edited hero rule can't leave the critical
  // stylesheet stale -- which would paint the hero in last week's colours and then correct itself
  // when style.min.css attaches.
  const { buildHeroCss } = require('../scripts/build-hero-css');
  assert.equal(
    fs.readFileSync(HERO_CSS_FILE, 'utf8'),
    buildHeroCss(STYLE_CSS),
    'wwwroot/css/hero.css is out of date with style.css -- run `npm run build`',
  );
});

test('hero.css carries the design tokens and the hero rules, and stays small', () => {
  const heroCss = fs.readFileSync(HERO_CSS_FILE, 'utf8');
  for (const needed of ['--accent', '--bg', '.hub-hero', '.section-eyebrow', '.btn-primary', '@font-face']) {
    assert.ok(heroCss.includes(needed), 'hero.css should carry ' + needed + ' for the first paint to look right');
  }
  // It is a blocking stylesheet on the critical path of every ad landing page: if it ever grows to
  // style.min.css's size it has stopped being a critical subset and is just blocking render again.
  assert.ok(heroCss.length < 12000, 'hero.css has grown to ' + heroCss.length + ' bytes -- keep the critical subset small');
});

// ---- 4. No duplicate API calls on the landing page ---------------------------------------------

test('a category page fetches each API path at most once', async (t) => {
  const calls = [];
  const record = (body) => (href) => { calls.push(href); return body; };
  await bootCategory(t, 'cdl', {
    fetchOverrides: [
      [/\/promotions\?/, record({ promotions: [] })],
      [/\/questions\/counts/, record({ counts: {} })],
      [/\/category-content/, record({ categories: [] })],
    ],
  });
  const duplicated = calls.filter((href, i) => calls.indexOf(href) !== i);
  assert.deepEqual([...new Set(duplicated)], [], 'the live page fired /promotions three times and /questions/counts twice on one load; identical in-flight GETs should be shared');
});

test('apiFetch shares one in-flight request between identical concurrent GETs', async (t) => {
  let hits = 0;
  const { window } = await bootCategory(t, 'cdl', {
    fetchOverrides: [[/\/config$/, () => { hits += 1; return {}; }]],
  });
  const before = hits;
  await Promise.all([window.apiFetch('/config'), window.apiFetch('/config'), window.apiFetch('/config')]);
  assert.equal(hits - before, 1, 'three concurrent GETs of the same path should share one network request');
});

test('apiFetch does not dedupe writes', async (t) => {
  let posts = 0;
  const { window } = await bootCategory(t, 'cdl', {
    fetchOverrides: [[/\/track\/visit/, () => { posts += 1; return {}; }]],
  });
  const before = posts;
  await Promise.all([
    window.apiFetch('/track/visit', { method: 'POST', body: { a: 1 } }),
    window.apiFetch('/track/visit', { method: 'POST', body: { a: 1 } }),
  ]);
  assert.equal(posts - before, 2, 'POSTs must never be collapsed -- two visits/answers/purchases are two events');
});

// ---- 5. Subhead keeps acronyms in the case they are actually written in ------------------------

test('a kind with an acronym is not lowercased in the generic subhead', async (t) => {
  // CDL was the page this bug was found on ("Practice questions for your state's commercial driver
  // (cdl) exam", live on every CDL ad click) but it has its own hand-written copy now, and it is
  // the only kind whose label carries a parenthesised acronym -- so assert the helper itself.
  const { window } = await bootCategory(t, 'cdl');
  assert.equal(window.sentenceKindLabel('Commercial Driver (CDL)'), 'commercial driver (CDL)');
  assert.equal(window.sentenceKindLabel('Real Estate Salesperson'), 'real estate salesperson');
  assert.equal(window.sentenceKindLabel('DAT'), 'DAT');
});

test('an all-caps exam kind keeps its case in the subhead', async (t) => {
  const { document } = await bootCategory(t, 'dat');
  const subhead = document.getElementById('category-hero-subhead').textContent;
  assert.ok(subhead.includes('DAT'), 'DAT must not become "dat", got: ' + subhead);
});

test('a multi-word kind is sentence-cased in the subhead', async (t) => {
  const { document } = await bootCategory(t, 'real-estate-salesperson');
  const subhead = document.getElementById('category-hero-subhead').textContent;
  assert.ok(subhead.includes('real estate salesperson'), 'expected lowercased ordinary words, got: ' + subhead);
});

// ---- 6. The state banner says where the state actually came from -------------------------------

// The worker geo-sets pxq_state from request.cf on a visitor's first hit (so ad clicks landing
// straight on /cdl see their own state), then stamps this meta on that same response. The client
// reads it to tell "we detected this" apart from "you chose this at some point".
test('the worker stamps the geo-detected state on the response where it sets the cookie', () => {
  assert.match(WORKER, /pxq-geo-state/, '_worker.js should stamp <meta name="pxq-geo-state"> on the response whose Set-Cookie it just wrote');
  const geoBlock = WORKER.slice(WORKER.indexOf('KNOWN_STATE_CODES.has(region)'));
  assert.match(geoBlock.slice(0, 600), /pxq-geo-state|geoState/, 'the stamp should be driven by the same branch that geo-sets the cookie, not guessed elsewhere');
});

test('a geo-detected state is described as the visitor\'s location, not something they saved', async (t) => {
  const probe = await bootApp({ url: 'https://passexamhq.com/cdl' });
  const state = probe.document.querySelector('.category-state-select').value;
  probe.dom.window.close();

  const { document } = await bootCategory(t, 'cdl', {
    cookie: 'pxq_state=' + state,
    windowSetup: (window) => {
      const meta = window.document.createElement('meta');
      meta.name = 'pxq-geo-state';
      meta.content = state;
      window.document.head.appendChild(meta);
    },
  });
  const banner = document.getElementById('category-state-detected-banner');
  assert.ok(banner, 'the state banner should still show when the state was not picked this page load');
  assert.ok(banner.textContent.includes('Based on your location'), 'expected location wording, got: ' + banner.textContent);
  assert.ok(!banner.textContent.includes('saved location'), 'a first-time visitor saved nothing -- this was the live copy on every geo-detected ad click');
});

test('a state carried in from an earlier session is described neutrally', async (t) => {
  const probe = await bootApp({ url: 'https://passexamhq.com/cdl' });
  const state = probe.document.querySelector('.category-state-select').value;
  probe.dom.window.close();

  const { document } = await bootCategory(t, 'cdl', { cookie: 'pxq_state=' + state });
  const banner = document.getElementById('category-state-detected-banner');
  assert.ok(banner, 'the banner should show for a cookie-sourced state');
  assert.ok(!banner.textContent.includes('Based on your location'), 'without the geo stamp we cannot claim we detected it: ' + banner.textContent);
  assert.ok(!banner.textContent.includes('saved location'), 'and we cannot claim they saved it either: ' + banner.textContent);
  assert.ok(/We're showing/.test(banner.textContent), 'expected neutral "We\'re showing X exam info" wording, got: ' + banner.textContent);
});

test('with no state signal at all the banner still says it is only an example', async (t) => {
  const { document } = await bootCategory(t, 'cdl', { cookie: 'pxq_state=ZZ' });
  const banner = document.getElementById('category-state-detected-banner');
  assert.ok(banner, 'the fallback banner should show');
  assert.ok(/as an example/.test(banner.textContent), 'expected the existing example wording, got: ' + banner.textContent);
});
