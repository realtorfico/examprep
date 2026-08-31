// Regression test for the 2026-08-30 "redeeming a code doesn't land on the code's own track" bug.
//
// #/redeem is a hash-only route, reachable while location.pathname stays whatever it already was
// (often "/", since redeem is deliberately track-agnostic -- see route()'s own comment on this).
// The old code set location.hash = '#/quiz' and called renderTrackApp() directly on the same page,
// but that hash assignment ALSO fires an async hashchange event, which independently re-invokes
// route(). route() resolves the current track from PATHNAME (activeTrackForPath()), not from the
// hash or from state.examType/accountExamType -- so on a still-"/" pathname it silently fell
// through to renderHub(), clobbering the correct render a moment after it happened. Net effect:
// redeeming a code never visibly landed on that code's track.
//
// The fix navigates to the redeemed track's own real path (a full page load) instead of faking a
// same-page transition. These two tests prove the fix at both levels a regression could reappear
// at: (1) the redeem-submit handler computes and assigns the correct destination URL, and (2)
// loading that URL -- simulating the real hard navigation, with the auth token carried forward via
// localStorage the way a real browser (not a fresh JSDOM instance) actually would -- lands on the
// redeemed track's real, logged-in content rather than falling back to the generic sales/landing
// page for that track.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../test-support/boot-app');

// Both tests need a real, currently-active, state-scoped track to redeem "into" -- picked from the
// real catalog rather than hardcoded, so this never drifts stale as tracks are added/retired.
async function pickRealTrack() {
  const discovery = await bootApp({ url: 'https://passexamhq.com/#/redeem' });
  const track = discovery.window.HUB_EXAMS.find((tr) => tr.active && tr.route && tr.route !== '#');
  discovery.dom.window.close();
  return track;
}

function submitRedeemForm(document, window, code) {
  const form = document.querySelector('form[data-act="redeem-submit"]');
  const codeInput = form.querySelector('input[name="code"]');
  codeInput.value = code;
  // jsdom doesn't implement HTMLFormElement's named-control auto-property access (form.code
  // returning the <input name="code"> element) the way every real browser does -- confirmed via
  // jsdom's own form.elements.code working while form.code does not. The redeem-submit handler
  // (correctly, per the HTML spec) reads e.target.code.value, so this shims just that one property
  // on this form instance rather than touching real app.js code to work around a test-tool gap.
  form.code = codeInput;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test('redeemDestinationUrl() resolves to the redeemed track\'s own real path, not a bare hash', async (t) => {
  const track = await pickRealTrack();
  assert.ok(track, 'need at least one active, state-scoped track in the catalog to run this test');

  // Unit-level: this is the exact function the redeem-submit handler calls to decide where to
  // navigate. Tested directly (pure function, no DOM/navigation involved) because jsdom doesn't
  // implement real cross-page navigation -- assigning location.href logs "Not implemented:
  // navigation" and leaves location.href reading back its OLD value, so a test that instead
  // dispatches the form and reads location.href afterward can't actually observe what was assigned.
  // See the next test for proof the full submit-handler wiring reaches this call without erroring.
  const step = await bootApp({ url: 'https://passexamhq.com/#/redeem' });
  t.after(() => step.dom.window.close());
  assert.equal(step.window.redeemDestinationUrl(track.examType), track.route + '#/quiz');
  assert.equal(step.window.redeemDestinationUrl('not_a_real_exam_type'), '#/quiz', 'an unresolvable examType should still fall back to a hash-only URL rather than throwing');
});

test('submitting the redeem form completes without error and stores the returned token', async (t) => {
  const track = await pickRealTrack();
  assert.ok(track, 'need at least one active, state-scoped track in the catalog to run this test');

  const step1 = await bootApp({
    url: 'https://passexamhq.com/#/redeem', // track-agnostic entry point, same as production
    fetchOverrides: [
      ['/redeem', { token: 'test-token-abc', examType: track.examType }],
    ],
  });
  t.after(() => step1.dom.window.close());

  submitRedeemForm(step1.document, step1.window, 'TESTCODE123');
  await settle();

  // Proves the handler ran all the way through setToken() and into the location.href assignment
  // without throwing (an earlier version of this fix, or a regression back to it, would have thrown
  // or silently done nothing well before this point) -- the exact destination itself is covered by
  // the redeemDestinationUrl() unit test above, and that loading it lands correctly is covered by
  // the next test.
  assert.equal(step1.window.getToken(), 'test-token-abc');
  assert.equal(step1.document.querySelector('.error-text'), null, 'redeem should not have shown an error state');
});

test('loading the post-redeem URL lands on the redeemed track\'s real content, not its sales/landing page', async (t) => {
  const track = await pickRealTrack();
  assert.ok(track, 'need at least one active, state-scoped track in the catalog to run this test');

  // Simulates the real hard navigation the fix performs: a fresh page load at the track's own path,
  // with the token already in localStorage (as a real browser's localStorage would carry it
  // forward from the redeem page, unlike a brand-new JSDOM instance without this seed).
  const step2 = await bootApp({
    url: 'https://passexamhq.com' + track.route + '#/quiz',
    localStorageItems: { examprep_token: 'test-token-abc' },
    fetchOverrides: [
      ['/prefs', { examType: track.examType }], // loadAccountExamType() -- this is what makes isLoggedInForCurrentTrack() true
      ['/questions/next', { id: 'q1', question: 'Sample question?', choiceA: 'A', choiceB: 'B', choiceC: 'C', choiceD: 'D' }],
    ],
  });
  t.after(() => step2.dom.window.close());

  // renderTabs() only renders .track-heading, with the real track's shortName, when
  // isLoggedInForCurrentTrack() is true -- i.e. accountExamType (from the /prefs stub above)
  // matches state.examType (resolved from the real pathname via activeTrackForPath()). If the old
  // bug were still present, this URL would instead render renderTrackLanding()'s locked-preview
  // sales page for an anonymous visitor, which has no .track-heading at all.
  const headingEl = step2.document.querySelector('.track-heading');
  assert.ok(headingEl, 'expected the logged-in .track-heading to be rendered on ' + track.route + '#/quiz, but the page fell back to the anonymous landing page');
  assert.equal(headingEl.textContent, track.shortName);

  // Belt-and-suspenders: the landing page's locked-preview widget must NOT be present -- if it
  // were, that confirms we fell back to renderTrackLanding() despite the token being valid.
  assert.equal(step2.document.querySelector('.locked-preview-tabs-wrap'), null);
});
