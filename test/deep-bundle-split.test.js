// app.js is split in two: the eager bundle, and js/app-deep.js fetched on demand. Added 2026-09-17.
//
// PageSpeed reported 54 KiB of app.min.js unused on a landing page view. A call-graph pass over
// app.js found that the static/legal/marketing routes (#/terms, #/privacy, #/about, #/faq,
// #/guarantee, #/pass-rates, #/changelog, #/contact, the embed generator, /blog) are 53 KiB of
// source that nothing on a landing page, a track page, a quiz, an exam or the checkout can reach --
// and, crucially, that none of the four delegated listener chains referenced any of it, so the cut
// needs no surgery on the code every click on the site runs through. app.min.js went 268,822 ->
// 235,445 bytes, with a 35 KiB chunk loaded on demand or at idle.
//
// The invariant that keeps this safe: app.js may never NAME a function defined in app-deep.js. It
// reaches them through DEEP_EXPORTS, which app-deep.js fills in with registerDeep(). A direct call
// would be a ReferenceError on any page where the bundle has not landed yet -- which is most of
// them. That is asserted mechanically below, not by review.
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { bootApp, waitFor, settle } = require('../test-support/boot-app');

const JS_DIR = path.join(__dirname, '..', 'wwwroot', 'js');
const APP = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
const DEEP = fs.readFileSync(path.join(JS_DIR, 'app-deep.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'wwwroot', 'index.html'), 'utf8');

// Top-level declarations in a file: `function name(` / `var name = [` / `var name = {`.
function declaredNames(src) {
  const names = new Set();
  for (const line of src.split(/\r?\n/)) {
    const fn = line.match(/^(?:async )?function ([A-Za-z0-9_$]+)/);
    if (fn) names.add(fn[1]);
    const data = line.match(/^(?:var|const|let) ([A-Za-z0-9_$]+) = [[{]/);
    if (data) names.add(data[1]);
  }
  return names;
}
// Comments and string literals removed, so a name in prose or in a data-act string doesn't count.
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

test('app.js never names a function defined in the deep bundle', () => {
  const deepNames = declaredNames(DEEP);
  assert.ok(deepNames.size >= 20, 'expected the deep bundle to hold the moved set, found ' + deepNames.size);
  const appCode = code(APP);
  const offenders = [];
  for (const name of deepNames) {
    // The property access DEEP_EXPORTS.renderTerms is the sanctioned route, and deepBundleReady()
    // uses exactly that to detect the load; a bare identifier is what must never appear.
    const bare = new RegExp('(^|[^.\\w$])' + name.replace(/\$/g, '\\$') + '\\s*\\(');
    if (bare.test(appCode)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'app.js calls these before they can exist: ' + offenders.join(', '));
});

test('nothing was lost in the move: every deep name is declared exactly once', () => {
  const appNames = declaredNames(APP);
  const deepNames = declaredNames(DEEP);
  const both = [...deepNames].filter((n) => appNames.has(n));
  assert.deepEqual(both, [], 'declared in both files, so the deep copy shadows or is shadowed: ' + both.join(', '));
});

test('every route in DEEP_HASH_VIEWS points at something the deep bundle registers', () => {
  const table = APP.slice(APP.indexOf('var DEEP_HASH_VIEWS = {'));
  const views = [...table.slice(0, table.indexOf('};')).matchAll(/'?([a-z-]+)'?:\s*'([A-Za-z0-9_$]+)'/g)];
  assert.ok(views.length >= 9, 'expected the hash-route table, parsed ' + views.length + ' entries');
  const registered = DEEP.slice(DEEP.indexOf('registerDeep({'));
  for (const [, view, exportName] of views) {
    assert.match(registered, new RegExp('\\b' + exportName + ':\\s*' + exportName + '\\b'),
      '#/' + view + ' renders with ' + exportName + ', which registerDeep() does not expose');
    assert.match(DEEP, new RegExp('^(?:async )?function ' + exportName + '\\b', 'm'),
      exportName + ' is registered but not defined in the deep bundle');
  }
});

test('index.html does not load the deep bundle -- the router does', () => {
  assert.ok(!INDEX.includes('app-deep'), 'a <script> tag here would defeat the whole point');
  assert.match(APP, /var DEEP_BUNDLE_URL = '\/js\/app-deep\.min\.js\?v=/, 'app.js owns the URL');
});

test('the built app.min.js carries the real hash of the built deep bundle', () => {
  // The source keeps a DEEP_BUNDLE_HASH placeholder (app.js is what tests and edits read); the
  // build substitutes the content hash, so a changed deep bundle busts its own cache with no ?v=
  // to maintain. If these drift, visitors get a stale chunk against fresh calling code.
  const appMin = fs.readFileSync(path.join(JS_DIR, 'app.min.js'), 'utf8');
  const deepMin = fs.readFileSync(path.join(JS_DIR, 'app-deep.min.js'), 'utf8');
  const hash = crypto.createHash('sha256').update(deepMin, 'utf8').digest('hex').slice(0, 12);
  assert.match(APP, /DEEP_BUNDLE_HASH/, 'the source keeps the placeholder');
  assert.ok(appMin.includes('app-deep.min.js?v=' + hash),
    'run `npm run build` -- app.min.js points at a different deep bundle than the one on disk');
});

// ---- Behaviour: the lazy path ------------------------------------------------------------------

test('a landing page needs no deep bundle at all', async (t) => {
  const booted = await bootApp({ url: 'https://passexamhq.com/cdl', deepBundle: false });
  t.after(() => booted.dom.window.close());
  await waitFor(() => booted.document.getElementById('category-hero-headline'));
  await settle();
  assert.ok(booted.document.getElementById('category-hero-subhead'), 'the page rendered');
  const injected = [...booted.document.querySelectorAll('script')].filter((s) => (s.src || '').includes('app-deep'));
  assert.equal(injected.length, 0, 'nothing should have fetched it yet');
});

test('a deep route fetches the bundle and shows a skeleton while it lands', async (t) => {
  const booted = await bootApp({ url: 'https://passexamhq.com/#/guarantee', deepBundle: false });
  t.after(() => booted.dom.window.close());
  await settle();
  const injected = [...booted.document.querySelectorAll('script')].filter((s) => (s.src || '').includes('app-deep.min.js'));
  assert.equal(injected.length, 1, 'the router should have injected the bundle exactly once');
  assert.ok(booted.document.querySelector('.skeleton-wrap, .skeleton-line'),
    'and shown a skeleton rather than a blank page: ' + booted.document.getElementById('app').innerHTML.slice(0, 120));
});

test('once it lands, the route renders', async (t) => {
  // Same page, with the bundle eval'd (what boot-app does by default) -- the state after the fetch.
  const booted = await bootApp({ url: 'https://passexamhq.com/#/guarantee' });
  t.after(() => booted.dom.window.close());
  await waitFor(() => /guarantee/i.test(booted.document.getElementById('app').textContent));
  assert.match(booted.document.getElementById('app').textContent, /refund/i);
  assert.equal(booted.document.querySelector('.skeleton-wrap'), null, 'the skeleton is gone');
});

test('a second deep route reuses the one load', async (t) => {
  const booted = await bootApp({ url: 'https://passexamhq.com/#/guarantee', deepBundle: false });
  t.after(() => booted.dom.window.close());
  await settle();
  booted.window.location.hash = '#/privacy';
  booted.window.dispatchEvent(new booted.window.HashChangeEvent('hashchange'));
  await settle();
  const injected = [...booted.document.querySelectorAll('script')].filter((s) => (s.src || '').includes('app-deep.min.js'));
  assert.equal(injected.length, 1, 'one fetch, not one per route');
});

test('the blog is a deep route too, and keeps its slug', async (t) => {
  const booted = await bootApp({ url: 'https://passexamhq.com/blog/some-post', deepBundle: false });
  t.after(() => booted.dom.window.close());
  await settle();
  const injected = [...booted.document.querySelectorAll('script')].filter((s) => (s.src || '').includes('app-deep.min.js'));
  assert.equal(injected.length, 1);
  assert.match(APP, /renderDeepRoute\('renderBlogPost', blogPostMatch\[1\]\)/, 'the slug has to survive the deferral');
});

test('a failed fetch says so instead of leaving a skeleton forever', async (t) => {
  const booted = await bootApp({ url: 'https://passexamhq.com/#/about', deepBundle: false });
  t.after(() => booted.dom.window.close());
  await settle();
  const tag = [...booted.document.querySelectorAll('script')].filter((s) => (s.src || '').includes('app-deep.min.js'))[0];
  assert.ok(tag, 'expected the injected script');
  tag.onerror(new booted.window.Event('error'));
  await settle();
  assert.match(booted.document.getElementById('app').textContent, /Could not load this page/);
});
