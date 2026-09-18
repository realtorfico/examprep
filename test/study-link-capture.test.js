// "Email me the free practice link" on the CDL pages -- phase 1 of the CDL email capture (2026-09-18).
// Chosen over extending the buy-page popup to /cdl: 87% of CDL landings are phones, where the only
// trigger a popup can use is a timer, and a timed popup covering the page counts against it in mobile
// search and in Google Ads' landing-page experience. So:
//   - an inline card, no popup, on /cdl and on every /cdl/{state} track page;
//   - on the track pages only, a desktop-only popup when the cursor leaves through the top -- never
//     on /cdl (the Ads landing page), never on a touch device, at most once a session;
//   - a separate consent box for study tips and offers, unticked unless the visitor ticks it. Its
//     wording is stored server-side as the record of consent, so it must match the API's copy.
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle, waitFor, makeFakeTurnstile } = require('../test-support/boot-app');

const OPT_IN_TEXT = 'Also send me occasional study tips and offers. Unsubscribe anytime.';

// desktop: true makes (hover: hover) and (pointer: fine) match, like a mouse-driven browser.
async function boot(url, { desktop = false } = {}) {
  const posts = [];
  const booted = await bootApp({
    url,
    fetchOverrides: [
      ['/study-link', (href, init) => { posts.push(JSON.parse(init.body)); return { ok: true }; }],
    ],
    windowSetup(win) {
      const { stub } = makeFakeTurnstile();
      win.turnstileReady = true;
      win.turnstile = stub;
      win.matchMedia = (q) => ({ matches: desktop && /pointer:\s*fine/.test(q), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    },
  });
  return { ...booted, posts };
}

function submitCard(window, form, email, { tick = false } = {}) {
  form.querySelector('input[type="email"]').value = email;
  if (tick) form.querySelector('input[type="checkbox"]').checked = true;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

function fireMouseLeave(window, clientY) {
  window.document.dispatchEvent(new window.MouseEvent('mouseleave', { clientY }));
}

test('the CDL category page has the card, with the consent box unticked', async (t) => {
  const { dom, document } = await boot('https://passexamhq.com/cdl');
  t.after(() => dom.window.close());
  const card = document.getElementById('study-link-card');
  assert.ok(card, 'card on /cdl');
  const form = card.querySelector('form[data-act="study-link-submit"]');
  assert.equal(form.getAttribute('data-source'), 'category_card');
  const box = form.querySelector('input[type="checkbox"][name="marketingOptIn"]');
  assert.ok(box);
  assert.equal(box.checked, false);
  assert.equal(box.hasAttribute('checked'), false);
  assert.equal(box.closest('label').textContent.trim(), OPT_IN_TEXT);
  assert.equal(document.getElementById('study-link-exit-modal'), null, 'no popup just for loading the page');
});

test('a CDL track page has the card; other kinds do not', async (t) => {
  const cdl = await boot('https://passexamhq.com/cdl/tx');
  t.after(() => cdl.dom.window.close());
  const form = cdl.document.querySelector('#study-link-card form[data-act="study-link-submit"]');
  assert.ok(form, 'card on /cdl/tx');
  assert.equal(form.getAttribute('data-source'), 'track_card');

  for (const url of ['https://passexamhq.com/notary', 'https://passexamhq.com/motorcycle', 'https://passexamhq.com/']) {
    const other = await boot(url);
    assert.equal(other.document.getElementById('study-link-card'), null, url);
    other.dom.window.close();
  }
});

test('submitting the /cdl card sends the page state\'s track, and no consent unless ticked', async (t) => {
  const { dom, window, document, posts } = await boot('https://passexamhq.com/cdl');
  t.after(() => dom.window.close());
  const repTrack = window.categoryPageState.repTrack;
  const form = document.querySelector('#study-link-card form');

  submitCard(window, form, '  me@example.com ');
  await waitFor(() => posts.length === 1);
  assert.equal(posts[0].email, 'me@example.com');
  assert.equal(posts[0].examType, repTrack.examType);
  assert.equal(posts[0].source, 'category_card');
  assert.equal(posts[0].marketingOptIn, false);
  assert.ok(posts[0].turnstileToken, 'sends a Turnstile token');
  await waitFor(() => /Check your inbox/.test(document.getElementById('study-link-card').textContent));
  assert.ok(document.getElementById('study-link-card').textContent.includes(repTrack.shortName || repTrack.title));
});

test('ticking the box on a track page sends consent for that track', async (t) => {
  const { dom, window, document, posts } = await boot('https://passexamhq.com/cdl/tx');
  t.after(() => dom.window.close());
  submitCard(window, document.querySelector('#study-link-card form'), 'me@example.com', { tick: true });
  await waitFor(() => posts.length === 1);
  assert.equal(posts[0].examType, 'tx_cdl');
  assert.equal(posts[0].source, 'track_card');
  assert.equal(posts[0].marketingOptIn, true);
});

test('a server error keeps the form and says so', async (t) => {
  const booted = await bootApp({
    url: 'https://passexamhq.com/cdl/tx',
    fetchOverrides: [['/study-link', { status: 502, body: { error: 'send_failed' } }]],
    windowSetup(win) { const { stub } = makeFakeTurnstile(); win.turnstileReady = true; win.turnstile = stub; },
  });
  t.after(() => booted.dom.window.close());
  const form = booted.document.querySelector('#study-link-card form');
  submitCard(booted.window, form, 'me@example.com');
  const status = booted.document.querySelector('#study-link-card .study-link-status');
  await waitFor(() => !status.hidden);
  assert.match(status.textContent, /try again/i);
  assert.ok(booted.document.querySelector('#study-link-card form'), 'form still there to retry');
});

test('desktop: leaving through the top of a track page opens the popup once, with its own source', async (t) => {
  const { dom, window, document, posts } = await boot('https://passexamhq.com/cdl/tx', { desktop: true });
  t.after(() => dom.window.close());
  window.STUDY_LINK_EXIT_MIN_DWELL_MS = 0;

  fireMouseLeave(window, 400);
  assert.equal(document.getElementById('study-link-exit-modal'), null, 'not when leaving lower down');
  fireMouseLeave(window, 0);
  const modal = document.getElementById('study-link-exit-modal');
  assert.ok(modal, 'popup on a top exit');
  const form = modal.querySelector('form[data-act="study-link-submit"]');
  assert.equal(form.getAttribute('data-source'), 'track_exit');
  assert.equal(form.querySelector('input[type="checkbox"]').checked, false);

  modal.querySelector('[data-act="dismiss-study-link-exit"]').click();
  assert.equal(document.getElementById('study-link-exit-modal'), null, 'dismissable');
  fireMouseLeave(window, 0);
  assert.equal(document.getElementById('study-link-exit-modal'), null, 'once per session');
  assert.equal(posts.length, 0);
});

test('the popup submits with source track_exit', async (t) => {
  const { dom, window, document, posts } = await boot('https://passexamhq.com/cdl/tx', { desktop: true });
  t.after(() => dom.window.close());
  window.STUDY_LINK_EXIT_MIN_DWELL_MS = 0;
  fireMouseLeave(window, 0);
  submitCard(window, document.querySelector('#study-link-exit-modal form'), 'me@example.com');
  await waitFor(() => posts.length === 1);
  assert.equal(posts[0].source, 'track_exit');
  assert.equal(posts[0].examType, 'tx_cdl');
});

test('no popup on /cdl, on a phone, before the visitor has been there a moment, or after they already asked', async (t) => {
  const category = await boot('https://passexamhq.com/cdl', { desktop: true });
  category.window.STUDY_LINK_EXIT_MIN_DWELL_MS = 0;
  fireMouseLeave(category.window, 0);
  assert.equal(category.document.getElementById('study-link-exit-modal'), null, '/cdl is the ad landing page');
  category.dom.window.close();

  const phone = await boot('https://passexamhq.com/cdl/tx', { desktop: false });
  phone.window.STUDY_LINK_EXIT_MIN_DWELL_MS = 0;
  fireMouseLeave(phone.window, 0);
  assert.equal(phone.document.getElementById('study-link-exit-modal'), null, 'touch devices never get it');
  phone.dom.window.close();

  const quick = await boot('https://passexamhq.com/cdl/tx', { desktop: true });
  fireMouseLeave(quick.window, 0);
  assert.equal(quick.document.getElementById('study-link-exit-modal'), null, 'not in the first seconds on the page');
  quick.dom.window.close();

  const asked = await boot('https://passexamhq.com/cdl/tx', { desktop: true });
  t.after(() => asked.dom.window.close());
  asked.window.STUDY_LINK_EXIT_MIN_DWELL_MS = 0;
  submitCard(asked.window, asked.document.querySelector('#study-link-card form'), 'me@example.com');
  await waitFor(() => asked.posts.length === 1);
  await settle();
  fireMouseLeave(asked.window, 0);
  assert.equal(asked.document.getElementById('study-link-exit-modal'), null, 'already asked via the card');
});

test('the privacy page covers the practice-link email and the optional tips and offers', async (t) => {
  const { dom, document } = await bootApp({ url: 'https://passexamhq.com/#/privacy' });
  t.after(() => dom.window.close());
  await waitFor(() => document.querySelector('.narrow-page h1'));
  const text = document.querySelector('.narrow-page').textContent.replace(/\s+/g, ' ');
  assert.match(text, /ask us to email you a link to free practice questions/);
  assert.match(text, /only if you tick the box/);
});
