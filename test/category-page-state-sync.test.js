// Regression tests for the 2026-08-25 "category page state picker doesn't propagate everywhere"
// bug reports: picking a state in the category landing page's hero dropdown (or loading the page
// with a state already known via cookie) is supposed to scope EVERY state-dependent piece of the
// page to that state -- the sample-question subhead, the curriculum breakdown, the hero/breakdown
// "view full track details" links, the single track card, AND the site footer's "Exams" links
// (via the site-wide hubScopedState variable, which also drives the #/gift page). Each of these
// was fixed piecemeal as a separate report in the same conversation; this test asserts all of them
// together so a future change can't silently regress one while fixing/touching another.

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

  assert.match(
    document.querySelector('.category-breakdown p.muted').textContent,
    new RegExp('Shown for ' + label),
    'curriculum breakdown subhead should name the newly picked state'
  );
  assert.equal(
    document.querySelector('.category-breakdown-cta a').getAttribute('href'),
    target.route,
    'curriculum breakdown CTA should link to the newly picked state\'s track'
  );

  assert.equal(
    document.querySelector('#category-hero-track-link-wrap a').getAttribute('href'),
    target.route,
    'hero "view full track details" link should point at the newly picked state\'s track'
  );

  assert.equal(
    document.querySelector('.category-current-track-grid a').getAttribute('href'),
    target.route,
    'the single track card should be the newly picked state\'s track'
  );

  assert.equal(window.hubScopedState, target.stateCode, 'hubScopedState should follow the picked state');

  const footerHrefs = Array.from(document.querySelectorAll('#footer-exams-links a')).map((a) => a.getAttribute('href'));
  const footerTrackHrefs = footerHrefs.slice(1); // first link is always "All exam tracks"
  assert.ok(footerTrackHrefs.length > 0, 'expected the footer to list at least one scoped track');
  for (const href of footerTrackHrefs) {
    const entry = window.HUB_EXAMS.find((e) => e.route === href);
    assert.ok(entry, 'footer link ' + href + ' should resolve to a real HUB_EXAMS track');
    assert.equal(entry.stateCode, target.stateCode, 'footer track links should all belong to the newly picked state, not fall back to the sitewide default');
  }
});

test('loading a category page with a state already known via cookie scopes the footer from the first render', async (t) => {
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

  const footerHrefs = Array.from(document.querySelectorAll('#footer-exams-links a')).map((a) => a.getAttribute('href')).slice(1);
  for (const href of footerHrefs) {
    const entry = window.HUB_EXAMS.find((e) => e.route === href);
    assert.equal(entry.stateCode, cookieState, 'footer should be scoped to the cookie-derived state on first render');
  }
});
