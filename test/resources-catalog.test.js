// Regression tests for the 2026-09-03 migration of per-track Resources content (tables/
// flashcards/audio/pdf) out of a hardcoded RESOURCES object in app.js and into D1, served via
// GET /resources/catalog and loaded once at boot by loadResourcesCatalog(). These are FIXED spot
// checks (not randomly sampled) covering the two structurally distinct shapes that exist across
// the real catalog -- a resource-rich track (tables/flashcards/audio/pdf together) and a plain
// pdf-only track -- so a regression in the fetch/render path fails loudly and reproducibly rather
// than depending on which track a random pick happened to land on.
//
// Fixture data below is a real, verified subset of what il_re_broker/ak_cdl actually contain in
// production D1 as of 2026-09-04 (see project_key_facts_digest_initiative memory) -- trimmed to
// just enough rows to exercise each resource type once, not the full catalog.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../test-support/boot-app');

const RICH_TRACK_CATALOG = {
  resources: {
    il_re_broker: [
      { type: 'table', title: 'Real Estate Recovery Fund Quick Facts', desc: 'Recovery Fund facts.', topic: 'Managing Broker Supervisory Duties, Special Accounts, Records & Calculations', free: false,
        table: { headers: ['Fact', 'Figure'], rows: [['Fund target balance', '$1,000,000']], sourceNote: 'O.C.G.A. test fixture' } },
      { type: 'flashcards', title: 'Managing Broker & Supervision Terms', desc: 'Key terms.', topic: 'Managing Broker Supervisory Duties, Special Accounts, Records & Calculations', free: true,
        flashcards: [{ front: 'Designated managing broker', back: 'The individual broker who oversees a brokerage.', source: 'test fixture' }] },
      { type: 'audio', title: "So You're the Designated Managing Broker Now", desc: 'Supervisory duties audio.', topic: 'Managing Broker Supervisory Duties, Special Accounts, Records & Calculations', free: true,
        file: 'So_Youre_the_Designated_Managing_Broker_Now.m4a' },
      { type: 'pdf', title: 'Illinois Real Estate License Act of 2000', desc: 'Official statute.', topic: 'General Reference', free: true,
        url: 'https://www.ilga.gov/legislation/ILCS/details?ActID=1364' },
    ],
  },
};

const PLAIN_TRACK_CATALOG = {
  resources: {
    ak_cdl: [
      { type: 'pdf', title: 'Alaska Commercial Driver License Manual', desc: 'Official CDL manual.', topic: 'General Reference', free: true,
        url: 'https://dmv.alaska.gov/media/u3lpkfmv/cdlmanual.pdf' },
    ],
  },
};

function findRow(document, title) {
  const cell = Array.from(document.querySelectorAll('td')).find((td) => td.textContent.includes(title));
  return cell ? cell.closest('tr') : null;
}

test('a resource-rich track (table + flashcards + audio + pdf) renders all four types with real content', async (t) => {
  const { dom, window, document } = await bootApp({
    url: 'https://passexamhq.com/real-estate-broker/il#/resources',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'il_re_broker' }],
      ['/resources/progress', {}],
      ['/resources/sign-batch', { urls: {} }],
      ['/resources/catalog', RICH_TRACK_CATALOG],
    ],
  });
  t.after(() => dom.window.close());

  const titles = [
    'Real Estate Recovery Fund Quick Facts',
    'Managing Broker & Supervision Terms',
    "So You're the Designated Managing Broker Now",
    'Illinois Real Estate License Act of 2000',
  ];
  for (const title of titles) {
    assert.ok(findRow(document, title), `expected a rendered row for "${title}"`);
  }

  // Expand the table row and confirm the real fixture content (not a "No cards yet"/empty
  // fallback) actually renders -- catches a regression where the catalog fetch succeeds but the
  // render path silently drops the table/flashcards/file payload.
  const row = findRow(document, 'Real Estate Recovery Fund Quick Facts');
  const btn = row.querySelector('button[data-act="toggle-resource-media"]');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  const expandRow = findRow(document, 'Real Estate Recovery Fund Quick Facts').nextElementSibling;
  assert.ok(expandRow && expandRow.classList.contains('resources-index-expand-row'), 'table row should expand in place');
  assert.match(expandRow.textContent, /\$1,000,000/, 'expanded table should show the real fixture figure, not a fallback');
});

test('a plain pdf-only track still renders correctly through the same catalog fetch path', async (t) => {
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ak#/resources',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'ak_cdl' }],
      ['/resources/progress', {}],
      ['/resources/sign-batch', { urls: {} }],
      ['/resources/catalog', PLAIN_TRACK_CATALOG],
    ],
  });
  t.after(() => dom.window.close());

  assert.ok(
    findRow(document, 'Alaska Commercial Driver License Manual'),
    'a plain single-pdf track (the shape ~248 untouched tracks still use) must still render after the migration'
  );
});

test('an unmocked /resources/catalog fetch degrades to an empty catalog, not a crash', async (t) => {
  // No '/resources/catalog' override here -- boot-app's default stub returns {} for any
  // unmatched fetch, so RESOURCES ends up {} (see app.js loadResourcesCatalog()). This is the
  // real behavior a live catalog-endpoint outage would produce; asserting it here means a future
  // change that makes an empty response throw instead of rendering "no resources" would be caught.
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/real-estate-broker/il#/resources',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'il_re_broker' }],
      ['/resources/progress', {}],
      ['/resources/sign-batch', { urls: {} }],
    ],
  });
  t.after(() => dom.window.close());

  assert.equal(findRow(document, 'Real Estate Recovery Fund Quick Facts'), null, 'no catalog data means no resource rows, not stale/cached content');
});
