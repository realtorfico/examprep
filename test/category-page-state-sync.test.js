// Regression tests for the 2026-08-25 "category page state picker doesn't propagate everywhere"
// bug reports: picking a state in the category landing page's hero dropdown (or loading the page
// with a state already known via cookie) is supposed to scope EVERY state-dependent piece of the
// page to that state -- the sample-question subhead, the curriculum breakdown, the hero/breakdown
// "view full track details" links, the single track card, AND the site-wide hubScopedState
// variable (which also drives the #/gift page). Each of these was fixed piecemeal as a separate
// report in the same conversation; this test asserts all of them together so a future change
// can't silently regress one while fixing/touching another.
// (The footer's own "Exams" links assertions were dropped 2026-09-02 when that column was removed
// from the footer as redundant with "Categories" -- see renderSiteFooter()'s own comment.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../test-support/boot-app');

function otherTrack(tracks, excludeStateCode) {
  const other = tracks.find((t) => t.stateCode !== excludeStateCode);
  assert.ok(other, 'expected at least 2 states to be active for this category to run this test');
  return other;
}

test('picking a state in the category page picker scopes every dependent section', async (t) => {
  const { dom, window, document } = await bootApp({ url: 'https://passexamhq.com/notary' });
  t.after(() => dom.window.close());

  const select = document.querySelector('.category-state-select');
  const tracks = window.categoryPageState.tracks;
  const target = otherTrack(tracks, select.value);
  const label = window.STATE_LABELS[target.stateCode] || target.stateCode;

  select.value = target.stateCode;
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle(); // pick-category-state kicks off a fresh loadCategorySampleQuestion fetch

  assert.equal(select.value, target.stateCode);

  assert.match(
    document.getElementById('category-sample-subhead').textContent,
    new RegExp(label),
    'sample-question subhead should name the newly picked state'
  );

  // The curriculum breakdown left this page in the 2026-09-17 consolidation (it is the state
  // page's content). The next-step CTA replaced it as the thing that has to follow the picker --
  // and it is now the page's main route to the purchase, so a stale href here is worse than the
  // stale breakdown subhead this used to guard.
  assert.match(
    document.querySelector('.category-next-step').textContent,
    new RegExp(target.shortName || label),
    'next-step section should name the newly picked state\'s track'
  );
  assert.equal(
    document.querySelector('.category-next-step-cta').getAttribute('href'),
    target.route,
    'next-step CTA should link to the newly picked state\'s track'
  );

  assert.equal(
    document.querySelector('#category-hero-track-link-wrap a').getAttribute('href'),
    target.route,
    'hero "view full track details" link should point at the newly picked state\'s track'
  );

  // The single track card was removed from this page on 2026-09-17 -- it was a copy of the state
  // page's own buy card. The next-step CTA above is now the link that has to follow the picker.

  assert.equal(window.hubScopedState, target.stateCode, 'hubScopedState should follow the picked state');
});

// This is the test that should have existed when the spec panel was added on 2026-09-17 and didn't:
// the panel is entirely per-state, the pick handler didn't re-render it, and the live page happily
// showed California's format and question count after the visitor picked another state. The test
// above only covered the sections that existed when IT was written -- so "every dependent section"
// was true of its own list, not of the page.
test('picking a state re-renders the hero spec panel: format, materials and bank size', async (t) => {
  const { dom, window, document } = await bootApp({
    url: 'https://passexamhq.com/notary',
    fetchOverrides: [
      ['/resources/catalog', { counts: { ca_notary: { tables: 9, decks: 9, cards: 99, audio: 9 }, ny_notary: { tables: 4, decks: 2, cards: 20, audio: 1 } } }],
      ['/questions/counts', { counts: [{ exam_type: 'ca_notary', count: 999 }, { exam_type: 'ny_notary', count: 111 }] }],
    ],
  });
  t.after(() => dom.window.close());
  await settle();

  const select = document.querySelector('.category-state-select');
  const before = document.querySelector('.category-spec').textContent;
  // Pick New York specifically, so the expected numbers are known rather than whatever is first.
  const target = window.categoryPageState.tracks.find((tr) => tr.stateCode === 'NY');
  assert.ok(target, 'expected a New York notary track in the fixture');
  select.value = 'NY';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await settle();

  const spec = document.querySelector('.category-spec');
  assert.ok(spec, 'the spec panel should still be there after a pick');
  assert.notEqual(spec.textContent, before, 'it should have re-rendered at all');

  const facts = [...spec.querySelectorAll('.category-spec-fact dd')].map((el) => el.textContent);
  assert.equal(facts[0], target.questions, 'the question format should be the newly picked state\'s');
  assert.equal(facts[1], target.passScore, 'and its pass mark');

  const inv = spec.textContent;
  assert.match(inv, /111/, 'the bank size should be the picked state\'s, not the previous one\'s');
  assert.match(inv, /4/, 'and its quick-fact tables');
  assert.ok(!/999/.test(inv), 'the previous state\'s numbers must be gone: ' + inv.replace(/\s+/g, ' '));
});

test('loading a category page with a state already known via cookie scopes hubScopedState from the first render', async (t) => {
  // Use whichever state real HUB_EXAMS data says offers Driver, other than the very first one --
  // read from the live boot rather than hardcoding a state code, so this doesn't silently stop
  // testing anything if track data changes.
  const probe = await bootApp({ url: 'https://passexamhq.com/driver' });
  const defaultState = probe.document.querySelector('.category-state-select').value;
  const cookieState = otherTrack(probe.window.categoryPageState.tracks, defaultState).stateCode;
  probe.dom.window.close();

  const { dom, window, document } = await bootApp({
    url: 'https://passexamhq.com/driver',
    cookie: 'pxq_state=' + cookieState,
  });
  t.after(() => dom.window.close());

  assert.equal(document.querySelector('.category-state-select').value, cookieState);
  assert.equal(window.hubScopedState, cookieState, 'hubScopedState should be scoped from the cookie on first render, not left null until an explicit pick');
});
