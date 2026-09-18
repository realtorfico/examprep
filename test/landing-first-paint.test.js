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
const APP_JS_SRC = fs.readFileSync(path.join(WWWROOT, 'js', 'app.js'), 'utf8');
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
// Shortened on 2026-09-17: the old 27-word version carried terms ("all 50 states, instant access,
// one-time purchase") that the state picker, the spec panel and the price line each state better,
// and a glance only reads the first sentence anyway.
const CDL_SUBHEAD = 'Practice questions for your state\'s CDL knowledge test, written from that state\'s own official handbook.';

test('the CDL hero uses its own headline and subhead', async (t) => {
  const { document } = await bootCategory(t, 'cdl');
  assert.equal(document.getElementById('category-hero-headline').textContent.trim(), 'CDL Exam Prep');
  assert.equal(document.getElementById('category-hero-subhead').textContent.trim(), CDL_SUBHEAD);
});

test('the category hero is a panel, and the homepage hero is left alone', async (t) => {
  // Ported from the /cdl1 prototype on 2026-09-17: the flat cream hero read as text on a page
  // rather than a product. Scoped to .hub-hero-panel because renderHub (the homepage) shares
  // .hub-hero and was deliberately not part of this change.
  const server = categoryHeroHtml('cdl');
  assert.match(server, /class="hub-hero hub-hero-panel"/, 'the server hero should carry the panel variant');
  assert.match(server, /class="hub-hero-kicker">Commercial driver's license</, 'the kicker spells out what the H1 abbreviates');
  // The seal is gone: it said the same thing as the subhead ("written from the official handbook"),
  // and the hero's job on a glance is one sentence, not two saying it twice.
  assert.ok(!server.includes('hub-hero-seal'), 'the seal duplicated the subhead and was removed');

  const { document } = await bootCategory(t, 'cdl');
  assert.ok(document.querySelector('.hub-hero.hub-hero-panel'), 'the client render should match');
  assert.ok(document.querySelector('.hub-hero-kicker'));
  assert.equal(document.querySelector('.hub-hero-seal'), null, 'and the client render drops it too');

  // The panel rules have to be in the blocking sheet or the first paint is an unstyled hero.
  const heroCss = fs.readFileSync(HERO_CSS_FILE, 'utf8');
  for (const rule of ['.hub-hero-panel', '.hub-hero-kicker', '#category-hero-subhead']) {
    assert.ok(heroCss.includes(rule), 'hero.css should carry ' + rule);
  }
  assert.ok(!/\.hub-hero\s*\{[^}]*radial-gradient/.test(STYLE_CSS), 'the panel background must not be attached to plain .hub-hero -- that is the homepage hero too');
});

test('a category without its own copy gets no empty kicker', async (t) => {
  const server = categoryHeroHtml('notary');
  assert.ok(!server.includes('hub-hero-kicker'), 'a kicker that repeats the headline is not worth a line');
  assert.ok(!server.includes('hub-hero-seal'));
  const { document } = await bootCategory(t, 'notary');
  assert.equal(document.querySelector('.hub-hero-kicker'), null);
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

// ---- 2a3. The client keeps the server's hero instead of rebuilding it -------------------------

// Replacing all of #app on boot destroyed the paragraph the visitor had been reading since ~1.2s
// and built a new one. The rebuilt node is a hair larger (28,400px² vs 27,384px², a line-wrap
// difference), so the browser recorded a NEW, larger LCP candidate at ~3.6s -- same words, same
// place, different DOM node. Measured on /cdl: LCP 3.2-4.4s in most runs, 1.2s when the two boxes
// happened to come out the same size, which is why it looked intermittent.
// The worker's own output, not a hand-copy: a copy goes stale the moment the hero changes, and
// then this test stops testing hydration and starts testing last week's markup.
const SSR_HERO = categoryHeroHtml('cdl');

async function bootWithSsrHero(t, slug) {
  const booted = await bootApp({ url: 'https://passexamhq.com/' + slug, appHtml: SSR_HERO });
  t.after(() => booted.dom.window.close());
  await waitFor(() => booted.document.getElementById('category-state-select'));
  await settle();
  return booted;
}

test('the server-rendered headline and subhead survive the client render', async (t) => {
  const { document } = await bootApp({ url: 'https://passexamhq.com/cdl', appHtml: SSR_HERO });
  t.after(() => document.defaultView.close());
  const before = document.getElementById('category-hero-subhead');
  const beforeH1 = document.getElementById('category-hero-headline');
  await waitFor(() => document.getElementById('category-state-select'));
  await settle();

  assert.equal(document.getElementById('category-hero-subhead'), before, 'the subhead node itself must be the same element -- a replacement is a second LCP candidate');
  assert.equal(document.getElementById('category-hero-headline'), beforeH1, 'and so must the H1');
});

test('the hydrated page still renders everything the full render does', async (t) => {
  const { document } = await bootWithSsrHero(t, 'cdl');
  // The track card and curriculum breakdown left this page in the 2026-09-17 consolidation (both
  // were the state page's content); the next-step CTA replaced them.
  for (const id of ['category-state-select', 'category-stats-wrap', 'category-next-step-wrap', 'category-testimonials-wrap', 'category-sample', 'category-hero-track-link-wrap']) {
    assert.ok(document.getElementById(id), 'hydrated page is missing #' + id);
  }
  // The trust badges left the hero on 2026-09-17; the state row is what now gets appended into the
  // server-rendered copy, which is the thing this assertion is really for -- that hydration fills
  // in around the server's markup instead of replacing it.
  assert.ok(document.querySelector('.hub-hero .category-state-detected-banner, .hub-hero .category-state-select-label'),
    'the state row should be appended into the server-rendered hero copy');
  assert.ok(document.querySelector('.hub-hero-btn-late'), 'and the later CTA');
  assert.equal(document.querySelectorAll('.hub-hero').length, 1, 'there must be exactly one hero, not the server\'s plus a new one');
  assert.equal(document.querySelector('.hub-hero').getAttribute('data-ssr-hero'), null, 'the marker should be consumed, so a later re-render takes the normal path');
});

test('hydrated and full renders produce the same hero markup', async (t) => {
  // The strong guarantee: whatever order the pieces go in, both paths end up identical, so CSS and
  // every querySelector in app.js behave the same either way.
  const hydrated = await bootWithSsrHero(t, 'cdl');
  const full = await bootCategory(t, 'cdl');
  const normalise = (html) => html.replace(/ data-ssr-hero="1"/, '');
  assert.equal(
    normalise(hydrated.document.querySelector('.hub-hero').outerHTML),
    normalise(full.document.querySelector('.hub-hero').outerHTML),
  );
});

test('the worker marks its hero so the client knows to keep it', () => {
  assert.match(WORKER, /data-ssr-hero="1"/, '_worker.js should mark the hero it renders');
  assert.ok(categoryHeroHtml('cdl').includes('data-ssr-hero="1"'));
});

// ---- 2a4. The hero's spec panel (phase 2 of the /cdl1 port) -----------------------------------

// The hero's second column used to be an aggregate card: "33,175 practice questions (across all
// states)", a State Tracks count and an Articles & Guides count -- figures about the catalog rather
// than about the exam the visitor is sitting. It now carries that state's own format, the
// endorsements by name, and that state's materials.
test('the hero spec panel shows the state\'s own exam format', async (t) => {
  const { document } = await bootCategory(t, 'cdl');
  const spec = document.querySelector('.category-spec');
  assert.ok(spec, 'the hero should have a spec panel');
  const labels = [...spec.querySelectorAll('.category-spec-fact dt')].map((el) => el.textContent);
  assert.deepEqual(labels, ['Questions', 'To pass', 'Time limit']);
  const values = [...spec.querySelectorAll('.category-spec-fact dd')].map((el) => el.textContent);
  assert.ok(values.every((v) => v && v !== '—'), 'the facts should come from the catalog, not render as dashes: ' + values.join(' | '));
});

test('the endorsements are named in the hero, not just as percentages further down', async (t) => {
  const { document } = await bootCategory(t, 'cdl');
  const chips = [...document.querySelectorAll('.category-spec-chips li')].map((el) => el.textContent);
  for (const endorsement of ['Air brakes', 'Combination vehicles', 'Doubles/Triples', 'HazMat', 'Passenger', 'School bus', 'Tanker']) {
    assert.ok(chips.includes(endorsement), 'missing endorsement chip: ' + endorsement);
  }
});

test('the materials fill in, whenever the counts arrive', async (t) => {
  // This shipped dashed twice. The counts are fetched at boot without gating the render, so whether
  // they're in hand at render time is a race -- and boot()'s repaint flag loses it in the direction
  // that matters: counts landing BEFORE the render means fillResourceCountSurfaces already ran and
  // returned early, so nothing repaints. The fill awaits the memoized load instead.
  assert.match(APP_JS_SRC, /await loadResourceCounts\(\);\s*\n\s*var counts = RESOURCE_COUNTS\[track\.examType\]/,
    'fillCategorySpecCounts must await the counts rather than hope they are already there');

  const { document } = await bootCategory(t, 'cdl', {
    fetchOverrides: [
      ['/resources/catalog', { counts: { ca_cdl: { tables: 5, decks: 3, cards: 30, audio: 3 } } }],
      ['/questions/counts', { counts: [{ exam_type: 'ca_cdl', count: 467 }] }],
    ],
  });
  const inv = [...document.querySelectorAll('.category-spec-inv li')].map((el) => el.textContent);
  assert.match(inv.join(' | '), /467/, 'the bank size comes from /questions/counts');
  assert.match(inv.join(' | '), /5/, 'quick-fact tables');
  assert.match(inv.join(' | '), /30 cards/, 'and the decks carry their card count');
  assert.ok(!inv.some((t) => t.trim().startsWith('—')), 'nothing should still be dashed once both responses are in: ' + inv.join(' | '));
});

test('the inventory is per state, and a dash until it is known', async (t) => {
  const { document } = await bootCategory(t, 'cdl');
  const items = [...document.querySelectorAll('.category-spec-inv li')].map((el) => el.textContent);
  assert.equal(items.length, 4, 'questions, tables, decks, audio');
  assert.ok(items.some((t) => /practice questions/.test(t)));
  // The old card's giveaway phrasing is gone.
  assert.ok(!document.body.textContent.includes('across all states'), 'the hero should no longer lead with a category-wide total');
  assert.ok(!document.body.textContent.includes('Real Coverage'), 'the "Real Coverage, Not Marketing Copy" card is gone');
});

test('the emoji feature tiles are gone and testimonials are trimmed to two', async (t) => {
  const { document } = await bootCategory(t, 'cdl', {
    fetchOverrides: [['/category-content', {
      categories: [{
        slug: 'cdl', hero_headline: null, hero_subhead: null,
        featureTiles: [{ icon: '📘', title: 'Built on handbooks', body: 'x' }],
        testimonials: [
          { quote: 'One', author: 'A' }, { quote: 'Two', author: 'B' },
          { quote: 'Three', author: 'C' }, { quote: 'Four', author: 'D' },
        ],
      }],
    }]],
  });
  assert.equal(document.querySelector('.category-feature-tiles'), null, 'the tiles repeated the trust chips directly above them');
  assert.equal(document.querySelectorAll('.category-testimonial-card').length, 2, 'four quotes was a screen of them, three screens below the decision');
});

test('everything inside the navy panel is styled for a dark ground', () => {
  // Found by screenshotting the live page after the port, not by any test here: components built
  // against the old cream hero went unreadable on the panel. "View full California CDL track
  // details →" and "Preview Free Resources →" were navy-on-navy, and the state banner's badge
  // overlapped its own sentence.
  for (const selector of [
    '\\.hub-hero-panel \\.btn-secondary',
    '\\.hub-hero-panel \\.btn-link',
    '\\.hub-hero-panel \\.category-state-detected-banner',
    '\\.hub-hero-panel \\.category-state-detected-text',
    '\\.hub-hero-panel \\.category-state-select',
    '\\.hub-hero-panel \\.category-waitlist-prompt',
  ]) {
    assert.match(STYLE_CSS, new RegExp(selector), 'nothing re-tints ' + selector.replace(/\\\\/g, '') + ' for the panel');
  }
  // The secondary buttons are in the first screen, so their fix has to be in the blocking sheet.
  const heroCss = fs.readFileSync(HERO_CSS_FILE, 'utf8');
  assert.match(heroCss, /\.hub-hero-panel \.btn-secondary/, 'hero.css needs it too, or those links paint unreadable');
});

test('the coverage bars and eyebrows match the panel, without touching shared surfaces', () => {
  // Phase 3 of the port. The bars already existed -- this is the panel's treatment applied to them.
  assert.match(STYLE_CSS, /\.category-breakdown \.breakdown-bar-fill \{\s*background: linear-gradient\(90deg, var\(--accent\), var\(--highlight\)\)/);
  assert.match(STYLE_CSS, /\.category-breakdown \.breakdown-row-top span:last-child \{[^}]*color: var\(--highlight\)/);
  // Scoped, because .breakdown-* is also the track page's and the buy page's value column.
  assert.ok(!/^\.breakdown-bar-fill \{[^}]*linear-gradient/m.test(STYLE_CSS), 'the gradient must not land on the bare .breakdown-bar-fill');
  // And the sample question's own option buttons are deliberately left alone: they are the real
  // quiz's buttons, and the sample exists to look like the quiz.
  assert.ok(!/\.category-sample \.option-btn/.test(STYLE_CSS), 'restyling the sample buttons would make the preview differ from the quiz it previews');
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

test('both hero fonts are preloaded', () => {
  // Measured four ways on 2026-09-17 (index.html's comment has the numbers). Each font causes a
  // different problem when it arrives after first paint: Inter re-wraps the header's promo ribbon
  // (intermittent CLS 0.18), and Fraunces repaints the H1 -- the LCP element -- so LCP lands on
  // that late paint instead of the first one, 1.2s becoming 3.3s.
  assert.match(INDEX, /<link rel="preload" as="font" type="font\/woff2" href="\/fonts\/inter-var-subset\.woff2" crossorigin>/, 'Inter must stay preloaded, or the promo ribbon re-wraps after paint');
  assert.match(INDEX, /<link rel="preload" as="font" type="font\/woff2" href="\/fonts\/fraunces-var-subset\.woff2" crossorigin>/, 'Fraunces must stay preloaded, or the H1 repaints late and LCP follows it');
  const heroCss = fs.readFileSync(HERO_CSS_FILE, 'utf8');
  assert.match(heroCss, /font-display:\s*swap/, 'the hero fonts must stay font-display:swap, so text paints in a fallback face rather than waiting');
});

test('the site serves the subset fonts, not the full downloads', () => {
  // scripts/build-fonts.js writes <name>-var-subset.woff2 next to the original download. The
  // originals stay in the repo as the source for re-subsetting; nothing should reference them.
  const heroCss = fs.readFileSync(HERO_CSS_FILE, 'utf8');
  for (const sheet of [STYLE_CSS, heroCss]) {
    assert.ok(!/-var-latin\.woff2/.test(sheet), 'a stylesheet still points at an unsubset font file');
    assert.match(sheet, /inter-var-subset\.woff2/);
    assert.match(sheet, /fraunces-var-subset\.woff2/);
  }
  for (const font of ['inter-var-subset.woff2', 'fraunces-var-subset.woff2']) {
    const file = path.join(WWWROOT, 'fonts', font);
    assert.ok(fs.existsSync(file), font + ' is missing -- run node scripts/build-fonts.js');
    // Inter is on the critical path (preloaded); keep an eye on both.
    assert.ok(fs.statSync(file).size < 70 * 1024, font + ' has grown to ' + Math.round(fs.statSync(file).size / 1024) + 'KB');
  }
});

// ---- 3. The hero paints styled, and app.min.js stops being last in the queue -------------------

test('index.html carries the critical CSS in the document itself', () => {
  // Was a blocking <link> to /css/hero.css until 2026-09-17, when PageSpeed flagged it as the
  // page's only render-blocking request. Now inlined, allowed by a CSP hash rather than
  // 'unsafe-inline' -- see test/critical-css-inline.test.js for the hash and its drift guard.
  assert.match(INDEX, /<!-- BEGIN-CRITICAL-CSS[^>]*--><style>@/, 'the server-rendered hero needs its critical CSS applied at first paint, with no request in front of it');
  assert.ok(fs.existsSync(HERO_CSS_FILE), 'wwwroot/css/hero.css should still be generated -- it is the input to the hash');
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
  // Ceiling raised from 12000 on 2026-09-17, when the server-rendered header's layout rules joined
  // the hero's: painting the header unstyled and then collapsing it moved the page up 229px (see
  // test/header-first-paint.test.js). Still the only guard against this file quietly becoming a
  // copy of style.css, so it blocks the first paint of every landing page for a reason.
  assert.ok(heroCss.length < 16000, 'hero.css has grown to ' + heroCss.length + ' bytes -- keep the critical subset small');
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

// ---- The waitlist prompt only when states are genuinely missing --------------------------------

test('a category with all 50 states offers no "get notified" prompt', async (t) => {
  // STATE_LABELS carries the 'US' national-track placeholder ("National"), and it was counted as a
  // missing state -- so CDL, with all 50 real states live, still asked "Don't see your state?" and
  // offered to notify the visitor when National launched. User-reported, 2026-09-17.
  const { document, window } = await bootCategory(t, 'cdl');
  const states = window.HUB_EXAMS.filter((e) => e.examKind === 'Commercial Driver (CDL)' && e.stateCode !== 'US');
  assert.ok(states.length >= 50, 'fixture should have all 50 CDL states, has ' + states.length);
  assert.equal(document.querySelector('.category-waitlist-prompt'), null,
    'nothing is missing, so there is nothing to be notified about');
});

test('a category that really is missing states still offers the prompt', async (t) => {
  // Boating is live in a subset of states, so this is the control case: the fix must not remove the
  // prompt everywhere.
  const { document, window } = await bootCategory(t, 'boating');
  const covered = new Set(window.HUB_EXAMS.filter((e) => e.examKind === 'Boating').map((e) => e.stateCode));
  const missing = Object.keys(window.STATE_LABELS).filter((c) => c !== 'US' && !covered.has(c));
  assert.ok(missing.length > 0, 'fixture should have states without a boating track');
  const prompt = document.querySelector('.category-waitlist-prompt');
  assert.ok(prompt, 'a category with real gaps should still offer the waitlist');
  const options = [...prompt.querySelectorAll('option')].map((o) => o.value).filter(Boolean);
  assert.ok(!options.includes('US'), 'and "National" must never be offered as a state to wait for');
});

// ---- The price has to be somewhere ------------------------------------------------------------

test('the page states a price, after the free question and not in the hero', async (t) => {
  // Removing the duplicated track card took the price off /cdl entirely for a few hours. The user's
  // ordering call stands -- judge the product, then see the figure -- so it belongs with the
  // next-step block that follows the sample, and nowhere above it.
  const { document } = await bootCategory(t, 'cdl', {
    fetchOverrides: [[/\/pricing\?/, { examType: 'ca_cdl', priceCents: 3699, currency: 'USD' }]],
  });
  const price = document.getElementById('category-next-step-price');
  assert.ok(price, 'the next-step block should carry the price line');
  assert.equal(price.textContent, '$36.99', 'filled from /pricing for the state on screen');

  const hero = document.querySelector('.hub-hero').textContent;
  assert.ok(!/\$\d/.test(hero), 'no price figure in the hero: ' + (hero.match(/\$\d[^\s]*/) || [''])[0]);
  const sampleAt = document.body.innerHTML.indexOf('id="category-sample"');
  const priceAt = document.body.innerHTML.indexOf('id="category-next-step-price"');
  assert.ok(sampleAt > -1 && priceAt > sampleAt, 'the price should come after the free question');
});

test('a failed pricing fetch leaves the line blank rather than guessing', async (t) => {
  const { document } = await bootCategory(t, 'cdl', {
    fetchOverrides: [[/\/pricing\?/, () => ({ status: 500, body: { error: 'nope' } })]],
  });
  assert.equal(document.getElementById('category-next-step-price').textContent, '',
    'better no number than a stale or invented one');
});
