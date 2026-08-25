// Regression test for the 2026-08-25 "landing page is randomly choosing a state" bug: visiting
// ANY track's own page (a testimonial link, a search-engine landing, the category page's own
// "view full track details" links, plain curiosity) used to call setStateCookie(track.stateCode)
// unconditionally, silently overwriting the visitor's real pxq_state preference -- so simply
// clicking into one state's track page would make every OTHER page's "your state" default flip to
// wherever you'd last clicked, instead of staying on the state you actually picked or that
// geolocation detected. Each step below is its own bootApp() call (a fresh jsdom window/app.js
// instance) with the previous step's resulting cookie carried forward as the next step's initial
// cookie -- that's deliberate: in production these are separate hard page loads (real <a href>
// navigation, not client-side pushState -- see route()'s own comment), not one continuous session.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../test-support/boot-app');

test('visiting a track page does not overwrite an explicitly-picked state preference', async (t) => {
  // Step 1: land on the notary category page and explicitly pick a state via the picker.
  const step1 = await bootApp({ url: 'https://passexamhq.com/notary' });
  t.after(() => step1.dom.window.close());
  const tracks = step1.window.categoryPageState.tracks;
  const picked = tracks[0];
  const other = tracks.find((tr) => tr.stateCode !== picked.stateCode);
  assert.ok(other, 'need at least 2 notary states to run this test');

  const select = step1.document.querySelector('.category-state-select');
  select.value = picked.stateCode;
  select.dispatchEvent(new step1.window.Event('change', { bubbles: true }));
  await settle();
  const cookieAfterPick = step1.window.getStateCookie();
  assert.equal(cookieAfterPick, picked.stateCode);

  // Step 2: a fresh hard page load lands directly on a DIFFERENT state's track page (simulating a
  // testimonial/search-engine/"view full track details" click), carrying step 1's cookie forward.
  const step2 = await bootApp({
    url: 'https://passexamhq.com' + other.route,
    cookie: 'pxq_state=' + cookieAfterPick,
  });
  t.after(() => step2.dom.window.close());
  const cookieAfterTrackVisit = step2.window.getStateCookie();
  assert.equal(
    cookieAfterTrackVisit,
    picked.stateCode,
    'visiting ' + other.route + '\'s track page must not overwrite the previously picked state (' + picked.stateCode + ')'
  );

  // Step 3: a third hard page load, on a different category entirely, carries step 2's (unchanged)
  // cookie forward and should still default to the originally-picked state, not the track visited
  // in step 2.
  const step3 = await bootApp({
    url: 'https://passexamhq.com/driver',
    cookie: 'pxq_state=' + cookieAfterTrackVisit,
  });
  t.after(() => step3.dom.window.close());
  const driverTracks = step3.window.categoryPageState.tracks;
  if (driverTracks.some((tr) => tr.stateCode === picked.stateCode)) {
    assert.equal(step3.document.querySelector('.category-state-select').value, picked.stateCode);
  }
});
