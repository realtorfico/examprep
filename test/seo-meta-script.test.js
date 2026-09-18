// scripts/generate-seo-meta.js -- run daily by .github/workflows/regenerate-seo-meta.yml, which failed
// every day from 2026-09-06. Found 2026-09-18 that the script itself was also broken: it read tracks
// from app.js's HUB_EXAMS_CONTENT, emptied by the 2026-09-17 content split (tracks now live in
// wwwroot/js/content/*.js), so a successful run would have deleted ~290 track pages from sitemap.xml
// and SEO_META. The daily failure was the only thing stopping it. These guard:
//   - tracks come from the content files, all of them;
//   - a run that would shrink the sitemap or SEO_META sharply refuses to write;
//   - the national exam landing pages (/act, /clt, /dat, /oat) have category entries, which the
//     original category list predated;
//   - requiring the script has no side effects (no fetch, no write), so it can be tested at all.
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WWWROOT = path.join(__dirname, '..', 'wwwroot');
const workerPath = path.join(WWWROOT, '_worker.js');

// Checked via fetch, not the files: the run fetches synchronously on start and only writes after its
// awaits, so a file comparison right after require() passes even when the run has started.
test('requiring the script starts no run', () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => { calls.push(String(url)); return new Promise(() => {}); };
  try {
    require('../scripts/generate-seo-meta.js');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, []);
});

test('tracks are read from the content files, every routed one', () => {
  const { loadTracks } = require('../scripts/generate-seo-meta.js');
  const tracks = loadTracks();
  const contentDir = path.join(WWWROOT, 'js', 'content');
  const routesOnDisk = fs.readdirSync(contentDir)
    .map((f) => fs.readFileSync(path.join(contentDir, f), 'utf8'))
    .join('\n')
    .match(/route:\s*'\/[^']+'/g) || [];
  assert.ok(routesOnDisk.length >= 265, 'sanity: the catalog has its tracks');
  assert.equal(tracks.length, routesOnDisk.length);
  const byRoute = Object.fromEntries(tracks.map((t) => [t.route, t]));
  for (const r of ['/cdl/tx', '/act/us', '/notary/ca']) assert.ok(byRoute[r], r);
  assert.equal(byRoute['/cdl/tx'].examType, 'tx_cdl');
  assert.ok(byRoute['/cdl/tx'].title.length > 0);
});

test('refuses to write when a run would drop many entries', () => {
  const { assertNoLargeDrop } = require('../scripts/generate-seo-meta.js');
  assert.throws(() => assertNoLargeDrop('sitemap.xml URLs', 925, 638), /sitemap\.xml URLs.*925.*638/);
  assert.throws(() => assertNoLargeDrop('SEO_META entries', 918, 8));
  assert.doesNotThrow(() => assertNoLargeDrop('sitemap.xml URLs', 925, 931));
  assert.doesNotThrow(() => assertNoLargeDrop('sitemap.xml URLs', 925, 900), 'a few retired pages is fine');
  assert.doesNotThrow(() => assertNoLargeDrop('sitemap.xml URLs', 0, 900), 'first run');
});

test('the national exam landing pages have category entries', () => {
  const { CATEGORY_META } = require('../scripts/generate-seo-meta.js');
  for (const slug of ['act', 'clt', 'dat', 'oat']) {
    const m = CATEGORY_META[slug];
    assert.ok(m, slug);
    assert.match(m.title, /\| PassExamHQ$/, slug);
    assert.ok(m.description.length > 40 && m.description.length <= 160, slug + ' description length');
  }
});

test('the workflow runs the script on a current Node and surfaces its error', () => {
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'regenerate-seo-meta.yml'), 'utf8');
  assert.match(wf, /actions\/checkout@v5/);
  assert.match(wf, /actions\/setup-node@v5/);
  assert.match(wf, /node-version: 22/);
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'generate-seo-meta.js'), 'utf8');
  assert.match(script, /::error/, 'prints a GitHub error annotation on failure');
});
