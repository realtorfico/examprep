// Regression tests for the 2026-09-08 "ACT track is completely unreachable" incident and the
// state-picker/breadcrumb bugs found alongside it. Root cause: ACT's HUB_EXAMS_CONTENT entry kept
// route:'#' (the inactive-scaffold placeholder) after going active in track_registry -- nothing
// enforces those stay in sync (see scripts/check-track-routes.js for the live cross-check that
// class of bug needs). Once the route was fixed, three more bugs surfaced, all from the same root
// cause: code throughout app.js assumed every track has a real state_code (a STATE_LABELS key),
// which breaks for a single national track (ACT, and MLO if it's ever activated) whose state_code
// is the 'US' placeholder. These tests use ACT as the fixture (the only currently-active national
// track) and assert the fixed behavior together so a future change can't silently regress any one
// piece while touching another.
//
// IMPORTANT: this file will start failing loudly, not silently, if ACT's route ever regresses back
// to '#' -- bootApp's own fixture generator (test-support/boot-app.js) filters OUT any
// HUB_EXAMS_CONTENT entry with route==='#', so a regression would make ACT vanish from HUB_EXAMS
// entirely inside these tests, and the very first assertion (finding the ACT track) would throw --
// which is itself the right failure mode: it means "ACT is unreachable again," not "test broken."

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../test-support/boot-app');

function findActTrack(window) {
  var track = (window.HUB_EXAMS || []).find(function (e) { return e.examType === 'act'; });
  assert.ok(track, 'expected an active ACT track in HUB_EXAMS -- if this fails, ACT\'s route may have regressed to \'#\' (see boot-app.js\'s fixture filter)');
  return track;
}

test('category page for a national (no-state) track hides the state picker and waitlist prompt', async (t) => {
  const { dom, window, document } = await bootApp({ url: 'https://passexamhq.com/act' });
  t.after(() => dom.window.close());

  assert.equal(document.querySelector('.category-state-select'), null,
    'a single-national-track category should not show a "select your state" dropdown');
  assert.equal(document.querySelector('.category-waitlist-prompt'), null,
    'a single-national-track category should not show a "notify me when my state launches" prompt');
});

test('category page for a national track still links to the real track route, not a dead "#"', async (t) => {
  const { dom, window, document } = await bootApp({ url: 'https://passexamhq.com/act' });
  t.after(() => dom.window.close());

  const track = findActTrack(window);
  assert.notEqual(track.route, '#', 'ACT\'s route must be a real path, not the inactive-scaffold placeholder');

  const trackCardLink = document.querySelector('.category-current-track-grid a');
  assert.ok(trackCardLink, 'expected the single-track card to render');
  assert.equal(trackCardLink.getAttribute('href'), track.route);

  const heroLink = document.querySelector('#category-hero-track-link-wrap a');
  assert.ok(heroLink, 'expected the hero "view full track details" link to render');
  assert.equal(heroLink.getAttribute('href'), track.route);
});

test('a state-based category (control case) still shows its state picker -- the fix is scoped correctly', async (t) => {
  const { dom, document } = await bootApp({ url: 'https://passexamhq.com/notary' });
  t.after(() => dom.window.close());

  assert.ok(document.querySelector('.category-state-select'),
    'a real multi-state category should still show its state picker -- this guards against the ACT fix accidentally hiding it everywhere');
});

test('visiting the national track\'s own route actually renders the track page, not the homepage', async (t) => {
  const track = { route: '/act/us' }; // asserted for real below via findActTrack after boot
  const { dom, window, document } = await bootApp({ url: 'https://passexamhq.com' + track.route });
  t.after(() => dom.window.close());

  findActTrack(window); // throws with a clear message if this silently fell back to the homepage
  assert.ok(document.querySelector('.track-landing'),
    'expected the real track landing page to render at its own route, not fall through to renderHub()');
  assert.equal(window.state.examType, 'act', 'route() should have set state.examType for the visited track');
});

test('national track landing page breadcrumb and "not studying for X" hint do not show a raw state code', async (t) => {
  const { dom, window, document } = await bootApp({ url: 'https://passexamhq.com/act/us' });
  t.after(() => dom.window.close());

  const breadcrumbCurrent = document.querySelector('.track-landing-breadcrumb .breadcrumb-current');
  assert.ok(breadcrumbCurrent, 'expected a breadcrumb current-page segment');
  assert.notEqual(breadcrumbCurrent.textContent.trim(), 'US',
    'breadcrumb should fall back to the track\'s real shortName, not the raw \'US\' placeholder code');

  assert.equal(document.querySelector('.track-landing-state-hint'), null,
    'a national track has no other state variant to pick, so the "Not studying for X? Pick your state" hint should not render');
});

test('a real state track (control case) still shows its breadcrumb state name and "pick your state" hint', async (t) => {
  const { dom, window, document } = await bootApp({ url: 'https://passexamhq.com/notary/ca' });
  t.after(() => dom.window.close());

  const breadcrumbCurrent = document.querySelector('.track-landing-breadcrumb .breadcrumb-current');
  assert.equal(breadcrumbCurrent.textContent.trim(), window.STATE_LABELS.CA);
  assert.ok(document.querySelector('.track-landing-state-hint'),
    'a real state track should still show the "pick your state" hint -- guards against the ACT fix over-suppressing it');
});

test('category page breakdown and sample-question subheads do not claim a national track "varies by state"', async (t) => {
  const { dom, document } = await bootApp({ url: 'https://passexamhq.com/act' });
  t.after(() => dom.window.close());

  const breakdownSubhead = document.querySelector('.category-breakdown p.muted');
  assert.ok(breakdownSubhead, 'expected the breakdown section to render (ACT has a real breakdown array)');
  assert.doesNotMatch(breakdownSubhead.textContent, /vary by state/i,
    'a single national track has no per-state variation -- this claim is simply false for it');
  assert.doesNotMatch(breakdownSubhead.textContent, /\bNational\b/,
    'should not fall back to the generic STATE_LABELS.US "National" label for a nationwide breakdown');

  const sampleSubhead = document.getElementById('category-sample-subhead');
  assert.ok(sampleSubhead, 'expected the sample-question widget to render');
  assert.doesNotMatch(sampleSubhead.textContent, /National ACT/,
    'sample subhead should not redundantly prefix the generic "National" label onto the exam name');
});

test('homepage category card for a national track links straight to the track page, not the category page', async (t) => {
  const { dom, window, document } = await bootApp({ url: 'https://passexamhq.com/' });
  t.after(() => dom.window.close());

  const track = findActTrack(window);
  const actCard = [...document.querySelectorAll('.category-nav-card')].find((a) => a.querySelector('h3').textContent === 'ACT');
  assert.ok(actCard, 'expected an ACT card on the homepage category grid');
  assert.equal(actCard.getAttribute('href'), track.route,
    'a single-national-track card should link directly to the track page, skipping the category landing page');
  assert.match(actCard.querySelector('.category-nav-card-statecount').textContent, /Nationwide/,
    'should not show a "1 state" count for a track with no real state division');
});

test('homepage category card for a state-based category (control case) still links to its category landing page', async (t) => {
  const { dom, document } = await bootApp({ url: 'https://passexamhq.com/' });
  t.after(() => dom.window.close());

  const notaryCard = [...document.querySelectorAll('.category-nav-card')].find((a) => a.querySelector('h3').textContent === 'Notary');
  assert.ok(notaryCard, 'expected a Notary card on the homepage category grid');
  assert.equal(notaryCard.getAttribute('href'), '/notary',
    'a real multi-state category should still link to its category landing page -- guards against the ACT fix over-applying');
});

test('buy page for a national track is reachable and does not show a raw state code in its breadcrumb', async (t) => {
  const { dom, window, document } = await bootApp({ url: 'https://passexamhq.com/act/us#/buy' });
  t.after(() => dom.window.close());

  assert.equal(window.state.examType, 'act');
  assert.ok(document.querySelector('.buy-order-summary'), 'expected the buy page to actually render');

  const breadcrumbLink = document.querySelector('.track-landing-breadcrumb a[href="/act/us"]');
  assert.ok(breadcrumbLink, 'expected a breadcrumb link back to the track page');
  assert.notEqual(breadcrumbLink.textContent.trim(), 'US',
    'buy page breadcrumb should fall back to the track title, not the raw \'US\' placeholder code');
});
