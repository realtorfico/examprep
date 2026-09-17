// The per-track content catalog is loaded per exam kind, not shipped whole in app.min.js.
//
// Measured 2026-09-17: as one array literal in app.js the catalog was 187KB minified and 24.5KB
// brotli -- 42% of the bundle's parse cost and 30% of its wire size -- while a CDL landing page
// needs 50 of its 290 entries. It now lives in wwwroot/js/content/<kind-slug>.js (those files are
// the source of truth and are edited directly; scripts/build-track-content.js did the one-time
// extraction), and app.js loads the slug the current page needs before its first render, then the
// rest at idle so in-app navigation to another category still has what it needs.
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp, waitFor, settle } = require('../test-support/boot-app');

const WWWROOT = path.join(__dirname, '..', 'wwwroot');
const CONTENT_DIR = path.join(WWWROOT, 'js', 'content');
const APP_JS = fs.readFileSync(path.join(WWWROOT, 'js', 'app.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(WWWROOT, '_worker.js'), 'utf8');

const contentFiles = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.js'));

// Reads a content file the way the browser does: it calls window.registerTrackContent(slug, list).
function loadContentFile(file) {
  const src = fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8');
  let captured = null;
  const win = { registerTrackContent: (slug, list) => { captured = { slug, list }; } };
  new Function('window', src)(win);
  assert.ok(captured, file + ' should call window.registerTrackContent(slug, entries)');
  return captured;
}

// ---- The catalog itself -------------------------------------------------------------------------

test('the bundle no longer carries the whole catalog', () => {
  assert.ok(!/var HUB_EXAMS_CONTENT = \[\s*\{/.test(APP_JS), 'app.js should not hold the catalog as a literal any more -- that was 42% of the bundle\'s parse cost');
  assert.ok(contentFiles.length >= 10, 'expected one content file per exam kind, found ' + contentFiles.length);
});

test('every track appears exactly once across the content files', () => {
  const seen = new Map();
  for (const file of contentFiles) {
    for (const entry of loadContentFile(file).list) {
      assert.ok(entry.examType, file + ' has an entry with no examType');
      assert.ok(!seen.has(entry.examType), entry.examType + ' appears in both ' + seen.get(entry.examType) + ' and ' + file);
      seen.set(entry.examType, file);
    }
  }
  // 290 tracks at the time of the split. A new track raises this; it must never silently fall.
  assert.ok(seen.size >= 290, 'expected at least the 290 tracks the catalog had when it was split, found ' + seen.size);
});

test('each content file holds exactly the kind its filename claims', () => {
  for (const file of contentFiles) {
    const { slug, list } = loadContentFile(file);
    assert.equal(slug, file.replace(/\.js$/, ''), file + ' registers itself under a different slug than its filename');
    if (slug === 'unrouted') {
      // mlo and act carry the '#' route placeholder -- nothing links to them, so they have no kind
      // page to be grouped under. app.js always loads this file.
      for (const e of list) assert.ok(!e.route || e.route.charAt(0) !== '/', 'a routed track is sitting in unrouted.js: ' + e.examType);
      continue;
    }
    for (const e of list) {
      assert.equal(e.route.split('/').filter(Boolean)[0], slug, e.examType + ' is in ' + file + ' but its route is ' + e.route);
    }
  }
});

// ---- Loading behaviour --------------------------------------------------------------------------

test('a category page has its own kind\'s content before it renders', async (t) => {
  const { document, window } = await bootApp({ url: 'https://passexamhq.com/cdl', trackContentSlugs: ['cdl'] });
  t.after(() => window.close());
  await waitFor(() => document.getElementById('category-hero-headline'));
  await settle();

  const cdl = window.HUB_EXAMS.filter((e) => e.examKind === 'Commercial Driver (CDL)');
  assert.ok(cdl.length >= 40, 'CDL tracks should be present with their content, got ' + cdl.length);
  assert.ok(cdl.every((e) => e.title && e.route), 'every CDL track should have the title and route that come from the catalog');
  assert.ok(cdl.some((e) => Array.isArray(e.breakdown) && e.breakdown.length), 'and the topic breakdown the category page renders');
});

test('tracks whose content has not loaded yet still have a usable route and name', async (t) => {
  // Only the CDL catalog is loaded here, but the registry lists every track, and the footer and
  // homepage link to them. buildHubExams() derives the route and falls back to the registry's own
  // shortName so nothing renders as "undefined" or links to nowhere in that window.
  const { document, window } = await bootApp({ url: 'https://passexamhq.com/cdl', trackContentSlugs: ['cdl'] });
  t.after(() => window.close());
  await waitFor(() => document.getElementById('category-hero-headline'));
  await settle();

  const others = window.HUB_EXAMS.filter((e) => e.examKind !== 'Commercial Driver (CDL)' && e.stateCode !== 'US');
  assert.ok(others.length > 0, 'the registry should still list other kinds');
  for (const e of others.slice(0, 40)) {
    assert.ok(e.route && e.route.charAt(0) === '/', e.examType + ' has no usable route: ' + e.route);
    assert.ok(e.title, e.examType + ' has no name to render');
  }
});

test('a derived route always matches the real one in the catalog', () => {
  // The fallback above is only safe if "<kind slug>/<state>" really is every routed track's URL --
  // otherwise a link rendered before that kind's content loads would 404. This checks all 288 of
  // them against what the catalog itself says.
  let checked = 0;
  for (const file of contentFiles) {
    const { slug, list } = loadContentFile(file);
    if (slug === 'unrouted') continue;
    for (const e of list) {
      const state = e.route.split('/').filter(Boolean)[1];
      const derived = state ? '/' + slug + '/' + state.toLowerCase() : '/' + slug;
      assert.equal(derived, e.route, 'derived route disagrees for ' + e.examType);
      checked += 1;
    }
  }
  assert.ok(checked >= 280, 'expected to check every routed track, checked ' + checked);
});

test('a page that is not a category or track page still gates on the whole catalog', async (t) => {
  // The homepage's category grid and the sitewide footer's cross-category links read HUB_EXAMS
  // titles for kinds other than "the current one", so those pages must not render from derived
  // fallbacks and then correct themselves -- that would be exactly the late-content shift the
  // first-paint work just removed. Only category and track pages narrow the gate to one kind.
  // Boots a category page (the harness's supported entry point) and then asks the real function
  // what each pathname would need -- pageTrackContentSlugs() reads location.pathname, so pushState
  // is enough, and this avoids standing up a full homepage render just to read a list.
  const { window } = await bootApp({ url: 'https://passexamhq.com/cdl', trackContentSlugs: ['cdl'] });
  t.after(() => window.close());
  await settle();

  assert.deepEqual(Array.from(window.pageTrackContentSlugs()).sort(), ['cdl', 'unrouted'], 'a category page should ask only for its own kind');

  // Every content file that exists -- not every kind slug: MLO has no file of its own (see the
  // TRACK_CONTENT_SLUGS test above).
  const everyKind = Array.from(window.TRACK_CONTENT_SLUGS).sort();
  for (const pathname of ['/', '/blog', '/guides/cdl-requirements-by-state/']) {
    window.history.pushState({}, '', pathname);
    assert.deepEqual(Array.from(window.pageTrackContentSlugs()).sort(), everyKind, pathname + ' should ask for every kind up front');
  }
});

test('app.js\'s list of content files matches the files that exist', () => {
  // Asking for a file that isn't there leaves the first render waiting on a 404 -- the homepage did
  // exactly that on 'mlo', whose single entry lives in unrouted.js because its route is the '#'
  // placeholder. A new kind's content file has to be added to this list.
  const declared = (APP_JS.match(/var TRACK_CONTENT_SLUGS = \[([^\]]*)\]/) || [])[1];
  assert.ok(declared, 'app.js should declare TRACK_CONTENT_SLUGS');
  const listed = declared.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
  assert.deepEqual(listed, contentFiles.map((f) => f.replace(/\.js$/, '')).sort());
});

test('the rest of the catalog loads after the first render, not before it', () => {
  assert.match(APP_JS, /requestIdleCallback|setTimeout/, 'app.js should defer loading the remaining kinds');
  const loader = APP_JS.slice(APP_JS.indexOf('function loadTrackContentFile'), APP_JS.indexOf('function loadTrackContentFile') + 1200);
  assert.match(loader, /document\.createElement\('script'\)/, 'the loader should inject a script tag (CSP forbids eval)');
  assert.match(loader, /TRACK_CONTENT_VERSION/, 'content URLs must be versioned -- /js/* is served immutable');
});

test('the worker preloads the content file the page is about to need', () => {
  assert.match(WORKER, /js\/content\//, '_worker.js should preload the page\'s content file so app.js\'s loader hits cache instead of a fresh round trip');
  const appVersion = (APP_JS.match(/var TRACK_CONTENT_VERSION = (\d+)/) || [])[1];
  const workerVersion = (WORKER.match(/const TRACK_CONTENT_VERSION = (\d+)/) || [])[1];
  assert.ok(appVersion, 'app.js should declare TRACK_CONTENT_VERSION');
  assert.equal(workerVersion, appVersion, 'the worker\'s preload version must match app.js\'s, or the preload is wasted and the file is fetched twice');
});
