// SECURITY (client side of the 2026-09-16 paid-content fix): the public /resources/catalog no longer
// carries paid table/flashcard content (see security-resources-content.test.js in the API repo) --
// a logged-in buyer's Resources tab must fetch it from the authenticated GET /resources/content and
// match it to catalog rows by resource `id`. A logged-out visitor must never request it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle, waitFor } = require('../test-support/boot-app');

const TOPIC = 'Air Brakes, Combination Vehicles & Doubles/Triples';
const OTHER_TOPIC = 'Passenger, School Bus, Tank & HazMat Endorsements';

// What the fixed API's public catalog returns: metadata for every row, content only for free ones.
const PUBLIC_CATALOG = {
  resources: {
    ca_cdl: [
      { id: 'ca_cdl:paid-table', type: 'table', title: 'Air Brake Pressures', desc: 'Specs.', topic: TOPIC, free: false },
      { id: 'ca_cdl:paid-deck', type: 'flashcards', title: 'Air Brake Deck', desc: 'Cards.', topic: TOPIC, free: false },
      { id: 'ca_cdl:paid-pdf', type: 'pdf', title: 'Paid Handbook PDF', desc: 'Link.', topic: TOPIC, free: false },
      { id: 'ca_cdl:other-table', type: 'table', title: 'Other Topic Table', desc: 'Specs.', topic: OTHER_TOPIC, free: false },
      { id: 'ca_cdl:general-table', type: 'table', title: 'General Reference Table', desc: 'Orientation.', topic: 'General Reference', free: false },
      { id: 'ca_cdl:free-table', type: 'table', title: 'Free Table', desc: 'Free.', topic: TOPIC, free: true,
        table: { headers: ['Fact', 'Value'], rows: [['Free fact', 'FREE-ROW-VALUE']] } },
    ],
  },
};
const CONTENT_RESPONSE = {
  items: {
    'ca_cdl:paid-table': { table: { headers: ['Spec', 'Value'], rows: [['Governor cut-out', 'PAID-ROW-VALUE-125-PSI']] } },
    'ca_cdl:paid-deck': { flashcards: [{ front: 'PAID-CARD-FRONT', back: 'PAID-CARD-BACK', source: 'fixture' }] },
    'ca_cdl:paid-pdf': { url: 'https://example.com/paid-handbook.pdf' },
    'ca_cdl:other-table': { table: { headers: ['Spec', 'Value'], rows: [['Other', 'OTHER-TOPIC-ROW-VALUE']] } },
    'ca_cdl:general-table': { table: { headers: ['Fact', 'Value'], rows: [['Class system', 'GENERAL-REFERENCE-ROW-VALUE']] } },
    'ca_cdl:free-table': { table: { headers: ['Fact', 'Value'], rows: [['Free fact', 'FREE-ROW-VALUE']] } },
  },
};

function rowFor(document, title) {
  const cell = Array.from(document.querySelectorAll('td')).find((td) => td.textContent.includes(title));
  return cell ? cell.closest('tr') : null;
}

async function openRow(window, document, title) {
  const row = rowFor(document, title);
  assert.ok(row, `row "${title}" must render`);
  const btn = row.querySelector('[data-act="toggle-resource-media"]');
  assert.ok(btn, `row "${title}" must be openable (unlocked)`);
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
}

test('logged-in buyer: paid table and flashcard content comes from /resources/content and renders when opened', async (t) => {
  const contentCalls = [];
  const { dom, window, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/resources',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'ca_cdl', ownedTopics: null }],
      ['/resources/progress', { items: [] }],
      ['/resources/sign-batch', { urls: {} }],
      ['/resources/content', (href) => { contentCalls.push(href); return CONTENT_RESPONSE; }],
      ['/resources/catalog', PUBLIC_CATALOG],
    ],
  });
  t.after(() => dom.window.close());
  await waitFor(() => rowFor(document, 'Air Brake Pressures') !== null);

  assert.ok(contentCalls.length >= 1, 'a logged-in Resources tab must request /resources/content');

  await openRow(window, document, 'Air Brake Pressures');
  await waitFor(() => document.body.textContent.includes('PAID-ROW-VALUE-125-PSI'), { timeout: 1000 })
    .catch(() => assert.fail('opened paid table must show its rows, fetched from /resources/content'));

  await openRow(window, document, 'Air Brake Deck');
  await waitFor(() => document.body.textContent.includes('PAID-CARD-FRONT'), { timeout: 1000 })
    .catch(() => assert.fail('opened paid deck must show its cards, fetched from /resources/content'));
});

test('logged-out visitor: never requests /resources/content, paid rows stay locked, free table still opens', async (t) => {
  const contentCalls = [];
  const { dom, window, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/resources',
    fetchOverrides: [
      ['/resources/free', { urls: {} }],
      ['/resources/content', (href) => { contentCalls.push(href); return CONTENT_RESPONSE; }],
      ['/resources/catalog', PUBLIC_CATALOG],
    ],
  });
  t.after(() => dom.window.close());
  await waitFor(() => rowFor(document, 'Air Brake Pressures') !== null);
  await settle();

  assert.equal(contentCalls.length, 0, 'a logged-out visitor must never call /resources/content');
  assert.match(rowFor(document, 'Air Brake Pressures').textContent, /Locked/);
  await openRow(window, document, 'Free Table');
  assert.ok(document.body.textContent.includes('FREE-ROW-VALUE'), 'free table content from the public catalog still renders');
});

test('logged-in buyer: a paid link resource (pdf) gets its url from /resources/content', async (t) => {
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/resources',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'ca_cdl', ownedTopics: null }],
      ['/resources/progress', { items: [] }],
      ['/resources/sign-batch', { urls: {} }],
      ['/resources/content', CONTENT_RESPONSE],
      ['/resources/catalog', PUBLIC_CATALOG],
    ],
  });
  t.after(() => dom.window.close());
  await waitFor(() => rowFor(document, 'Paid Handbook PDF') !== null);
  await settle();
  const link = rowFor(document, 'Paid Handbook PDF').querySelector('a[href="https://example.com/paid-handbook.pdf"]');
  assert.ok(link, 'paid pdf row must open the url delivered by /resources/content');
});

test('à la carte buyer: an un-owned topic row stays locked and never renders its content, even if the content is on the page', async (t) => {
  // Defense in depth -- the server shouldn't send un-owned content at all, but the page must not
  // unlock a row just because content for it happens to be present.
  const { dom, window, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/resources',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'ca_cdl', ownedTopics: [TOPIC] }],
      ['/resources/progress', { items: [] }],
      ['/resources/sign-batch', { urls: {} }],
      ['/resources/content', CONTENT_RESPONSE],
      ['/resources/catalog', PUBLIC_CATALOG],
    ],
  });
  t.after(() => dom.window.close());
  await waitFor(() => rowFor(document, 'Other Topic Table') !== null);
  await settle();
  const row = rowFor(document, 'Other Topic Table');
  assert.match(row.textContent, /Locked/);
  assert.equal(row.querySelector('[data-act="toggle-resource-media"]'), null, 'no open button on a locked row');
  assert.ok(!document.body.textContent.includes('OTHER-TOPIC-ROW-VALUE'));
});

test('à la carte buyer: a paid General Reference resource is unlocked (not tied to any purchasable topic) and opens', async (t) => {
  const { dom, window, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/resources',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'ca_cdl', ownedTopics: [TOPIC] }],
      ['/resources/progress', { items: [] }],
      ['/resources/sign-batch', { urls: {} }],
      ['/resources/content', CONTENT_RESPONSE],
      ['/resources/catalog', PUBLIC_CATALOG],
    ],
  });
  t.after(() => dom.window.close());
  await waitFor(() => rowFor(document, 'General Reference Table') !== null);
  await settle();
  assert.doesNotMatch(rowFor(document, 'General Reference Table').textContent, /Locked/, 'General Reference must not be locked for a topic buyer');
  await openRow(window, document, 'General Reference Table');
  assert.ok(document.body.textContent.includes('GENERAL-REFERENCE-ROW-VALUE'));
});
