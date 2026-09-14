// Regression tests for the client-side pieces of the à la carte topic-purchase pilot (CA CDL) --
// see project memory project_ca_cdl_topic_purchase_pilot. The site learns an account's owned
// topics from GET /prefs' new `ownedTopics` field (null = full access, the default for every
// existing account). These tests cover the "show but lock, never hide" convention applied
// consistently across Resources, the tab bar, the Exam/Weak Spots route gate, and Progress.
//
// The real enforcement for Exam/Weak Spots and the refund guarantee lives server-side (see
// test/ala-carte-restrictions.test.js in the API repo) -- these tests are about the CLIENT
// correctly reading ownedTopics and presenting the right UI, not re-proving the server boundary.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle, waitFor } = require('../test-support/boot-app');

const CA_CDL_TOPICS = {
  gk: 'General Knowledge (CDL Rules, Safe Driving & Cargo)',
  ab: 'Air Brakes, Combination Vehicles & Doubles/Triples',
};

const RESOURCES_CATALOG = {
  resources: {
    ca_cdl: [
      { type: 'pdf', title: 'GK Study Guide', desc: 'General knowledge guide.', topic: CA_CDL_TOPICS.gk, free: false, url: 'https://example.com/gk.pdf' },
      { type: 'pdf', title: 'AB Study Guide', desc: 'Air brakes guide.', topic: CA_CDL_TOPICS.ab, free: false, url: 'https://example.com/ab.pdf' },
    ],
  },
};

function findRow(document, title) {
  const cell = Array.from(document.querySelectorAll('td')).find((td) => td.textContent.includes(title));
  return cell ? cell.closest('tr') : null;
}

// ---- Resources tab --------------------------------------------------------

test('Resources: an owned-topic resource is unlocked, an un-owned one is locked, even though logged in', async (t) => {
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/resources',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'ca_cdl', ownedTopics: [CA_CDL_TOPICS.gk] }],
      ['/resources/progress', {}],
      ['/resources/sign-batch', { urls: {} }],
      ['/resources/catalog', RESOURCES_CATALOG],
    ],
  });
  t.after(() => dom.window.close());

  const gkRow = findRow(document, 'GK Study Guide');
  const abRow = findRow(document, 'AB Study Guide');
  assert.ok(gkRow, 'owned-topic resource must still render');
  assert.ok(abRow, 'un-owned-topic resource must still render (shown, not hidden)');
  assert.doesNotMatch(gkRow.textContent, /Locked/, 'owned topic must not show the locked badge');
  assert.match(abRow.textContent, /Locked/, 'un-owned topic must show the locked badge despite being logged in');
  assert.ok(abRow.querySelector('a[href="#/buy"]'), 'the locked row must offer the same Unlock -> #/buy CTA as the logged-out case');
});

test('Resources: a full-track account (ownedTopics null) sees everything unlocked, unchanged from before this feature', async (t) => {
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/resources',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'ca_cdl', ownedTopics: null }],
      ['/resources/progress', {}],
      ['/resources/sign-batch', { urls: {} }],
      ['/resources/catalog', RESOURCES_CATALOG],
    ],
  });
  t.after(() => dom.window.close());

  const gkRow = findRow(document, 'GK Study Guide');
  const abRow = findRow(document, 'AB Study Guide');
  assert.doesNotMatch(gkRow.textContent, /Locked/);
  assert.doesNotMatch(abRow.textContent, /Locked/);
});

// ---- Tab bar + Exam/Weak Spots route gate ---------------------------------

test('Tab bar: Exam and Weak Spots show the lock icon for a partial owner, Quiz and Progress do not', async (t) => {
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/quiz',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'ca_cdl', ownedTopics: [CA_CDL_TOPICS.gk] }],
      ['/next-question', { id: 'q1', topic: CA_CDL_TOPICS.gk, question: 'Q?', choices: { A: 'a', B: 'b', C: 'c', D: 'd' } }],
    ],
  });
  t.after(() => dom.window.close());

  const tabText = (href) => document.querySelector('nav.tabs a[href="' + href + '"]').textContent;
  assert.match(tabText('#/exam'), /🔒/, 'Exam tab must show the lock icon for a partial owner');
  assert.match(tabText('#/toughest45'), /🔒/, 'Weak Spots tab must show the lock icon for a partial owner');
  assert.doesNotMatch(tabText('#/quiz'), /🔒/, 'Quiz stays unlocked for a partial owner');
  assert.doesNotMatch(tabText('#/progress'), /🔒/, 'Progress stays unlocked for a partial owner');
});

test('Exam route: a partial owner navigating directly to #/exam sees the requires-full-access message, never the real exam or a start-exam network call', async (t) => {
  const examStartCalls = [];
  const { dom, window, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/quiz',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'ca_cdl', ownedTopics: [CA_CDL_TOPICS.gk] }],
      ['/exam/start', () => { examStartCalls.push(true); return { attemptId: 'should-not-happen', questions: [], answers: {}, durationSec: 3600, startedAt: 0 }; }],
    ],
  });
  t.after(() => dom.window.close());

  window.location.hash = '#/exam';
  window.dispatchEvent(new window.Event('hashchange'));
  await settle();

  assert.equal(examStartCalls.length, 0, 'the client must never even call /exam/start for a partial owner -- the gate runs before that');
  assert.match(document.getElementById('app').textContent, /full track access/i);
  assert.ok(document.querySelector('a[href="#/buy"]'), 'the locked message must offer a real path forward');
});

test('Exam route: a full-track owner (ownedTopics null) reaches the real exam intro screen, not the lock message', async (t) => {
  // renderExam shows an intro/config screen first (checking /exam/current for a resumable
  // attempt, then /exam/config) -- /exam/start itself only fires once the user clicks "Start",
  // which this test doesn't do. The real assertion here is "not blocked by the new gate", i.e.
  // the real intro screen renders instead of the requires-full-access message.
  const { dom, window, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/quiz',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'ca_cdl', ownedTopics: null }],
      ['/exam/current', { attempt: null }],
      ['/exam/config', { questionCount: 4, durationSec: 3600, passPercent: 80 }],
    ],
  });
  t.after(() => dom.window.close());

  window.location.hash = '#/exam';
  window.dispatchEvent(new window.Event('hashchange'));
  await settle();

  assert.doesNotMatch(document.getElementById('app').textContent, /full track access/i, 'a full-track owner must reach the real exam intro, not the locked-message view');
  assert.match(document.getElementById('app').textContent, /Timed Practice Exam|Practice Exam/, 'the real exam intro screen must render');
});

// ---- Progress tab: Coverage scoping + locked topic rows --------------------

const PROGRESS_RESPONSE = {
  totalAnswered: 10, totalCorrect: 8, wrongQuestions: [],
  byTopic: [
    { topic: CA_CDL_TOPICS.gk, correct: 8, total: 10, seen: 5, topicTotal: 10 },
    { topic: CA_CDL_TOPICS.ab, correct: 0, total: 0, seen: 0, topicTotal: 20 },
  ],
};

test('Progress: headline Coverage for a partial owner is scoped to owned topics only, not the whole track', async (t) => {
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/progress',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'ca_cdl', ownedTopics: [CA_CDL_TOPICS.gk] }],
      ['/progress', PROGRESS_RESPONSE],
      ['/exam/history?mode=standard', { attempts: [] }],
      ['/exam/history?mode=toughest45', { attempts: [] }],
      ['/leaderboard', { users: [] }],
    ],
  });
  t.after(() => dom.window.close());

  // Owned-only: seen=5, topicTotal=10 -> 50%. Whole-track (the pre-fix behavior) would be
  // seen=5, topicTotal=30 -> 17%, a materially different (and permanently-capped) number.
  const coverageBox = Array.from(document.querySelectorAll('.stat-box')).find((b) => b.textContent.includes('Coverage'));
  assert.match(coverageBox.querySelector('.val').textContent, /50%/, 'Coverage must be computed against owned topics only (5/10=50%), not the whole track (5/30=17%)');
});

test('Progress: full-track owner\'s Coverage is unaffected -- still computed against the whole track', async (t) => {
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/progress',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'ca_cdl', ownedTopics: null }],
      ['/progress', PROGRESS_RESPONSE],
      ['/exam/history?mode=standard', { attempts: [] }],
      ['/exam/history?mode=toughest45', { attempts: [] }],
      ['/leaderboard', { users: [] }],
    ],
  });
  t.after(() => dom.window.close());

  const coverageBox = Array.from(document.querySelectorAll('.stat-box')).find((b) => b.textContent.includes('Coverage'));
  // 5 seen / (10+20) topicTotal = 17%
  assert.match(coverageBox.querySelector('.val').textContent, /17%/);
});

test('Progress: the per-topic table shows a locked row for an un-owned topic, not real (misleading) stats', async (t) => {
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/progress',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: 'ca_cdl', ownedTopics: [CA_CDL_TOPICS.gk] }],
      ['/progress', PROGRESS_RESPONSE],
      ['/exam/history?mode=standard', { attempts: [] }],
      ['/exam/history?mode=toughest45', { attempts: [] }],
      ['/leaderboard', { users: [] }],
    ],
  });
  t.after(() => dom.window.close());

  const abRow = findRow(document, CA_CDL_TOPICS.ab);
  assert.ok(abRow, 'the un-owned topic row must still be shown, not hidden');
  assert.match(abRow.textContent, /full track access/i);
  assert.doesNotMatch(abRow.textContent, /0%/, 'must not show a misleading 0% instead of the lock state');

  const gkRow = findRow(document, CA_CDL_TOPICS.gk);
  assert.doesNotMatch(gkRow.textContent, /full track access/i, 'the owned topic row must show real stats, not a lock state');
});

// ---- Track landing page à la carte note ------------------------------------

test('Track landing page: CA CDL shows a note pointing to à la carte purchase', async (t) => {
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca',
    fetchOverrides: [
      ['/track-key-breakdown', { items: [{ label: CA_CDL_TOPICS.gk, declared_pct: 48, sort_order: 0 }] }],
    ],
  });
  t.after(() => dom.window.close());

  const wrap = document.getElementById('track-landing-ala-carte-note-wrap');
  await waitFor(() => wrap.textContent.trim().length > 0);
  const link = wrap.querySelector('a[href="#/buy"]');
  assert.ok(link, 'the note must link to the buy page, not just mention the feature');
  assert.match(wrap.textContent, /Buy just what you need/i);
});

test('Track landing page: a track with no track_key_breakdown rows shows no à la carte note', async (t) => {
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/driver/ca',
    fetchOverrides: [
      ['/track-key-breakdown', { items: [] }],
    ],
  });
  t.after(() => dom.window.close());
  await settle();

  const wrap = document.getElementById('track-landing-ala-carte-note-wrap');
  assert.equal(wrap.textContent.trim(), '', 'no track_key_breakdown rows means no note, unchanged from before this feature existed');
});
