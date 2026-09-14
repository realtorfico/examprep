// Regression tests for the buy-page exit-intent email capture (wwwroot/js/app.js,
// maybeShowExitIntentModal/showExitIntentModal/closeExitIntentModal) -- added because the passive
// "Not ready today?" card (buy-reminder-card) is opt-in and easy to miss, so a visitor who reaches
// the buy page, never types an email, and just closes the tab leaves with nothing captured. This
// shows an active modal the moment the cursor leaves the viewport through the top (the standard
// exit-intent signal), reusing the same /buy/reminder endpoint the passive card already uses.
//
// Real mouse movement toward the browser chrome can't be simulated in jsdom, so these tests
// dispatch a synthetic 'mouseleave' with clientY set instead -- that's the exact (and only) signal
// the handler reads, so this covers the real gating logic: only on the buy page, only once per
// session, and the modal's own submit/dismiss wiring.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../test-support/boot-app');

function fireMouseLeave(window, clientY) {
  window.document.dispatchEvent(new window.MouseEvent('mouseleave', { clientY: clientY }));
}

async function bootAtBuyPage(overrides) {
  return bootApp(Object.assign({
    url: 'https://passexamhq.com/cdl/pa#/buy',
    fetchOverrides: [
      ['/pricing', () => ({ priceCents: 1999, currency: 'usd', minPaypalChargeCents: 50 })],
    ],
  }, overrides || {}));
}

test('leaving via the top of the viewport on the buy page shows the exit-intent modal', async (t) => {
  const { dom, window, document } = await bootAtBuyPage();
  t.after(() => dom.window.close());

  fireMouseLeave(window, 0);
  assert.ok(document.getElementById('exit-intent-modal'), 'modal should appear on a clientY<=0 mouseleave');
});

test('does not show when the cursor leaves lower down the page (not heading for the browser chrome)', async (t) => {
  const { dom, window, document } = await bootAtBuyPage();
  t.after(() => dom.window.close());

  fireMouseLeave(window, 400);
  assert.equal(document.getElementById('exit-intent-modal'), null);
});

test('does not show on a page other than /buy', async (t) => {
  const { dom, window, document } = await bootApp({ url: 'https://passexamhq.com/cdl/pa' });
  t.after(() => dom.window.close());

  fireMouseLeave(window, 0);
  assert.equal(document.getElementById('exit-intent-modal'), null, 'buy-reminder-card only exists on the buy page');
});

test('only shows once per session even across repeated exit-intent signals', async (t) => {
  const { dom, window, document } = await bootAtBuyPage();
  t.after(() => dom.window.close());

  fireMouseLeave(window, 0);
  assert.ok(document.getElementById('exit-intent-modal'));
  window.closeExitIntentModal();
  assert.equal(document.getElementById('exit-intent-modal'), null);

  fireMouseLeave(window, 0);
  assert.equal(document.getElementById('exit-intent-modal'), null, 'sessionStorage should suppress a second show this session');
});

test('prefills the modal email from the buy page\'s own email field, if already typed', async (t) => {
  const { dom, window, document } = await bootAtBuyPage();
  t.after(() => dom.window.close());

  const buyEmailEl = document.getElementById('buy-email');
  buyEmailEl.value = 'visitor@example.com';

  fireMouseLeave(window, 0);
  const modalEmailEl = document.querySelector('#exit-intent-modal input[name="email"]');
  assert.equal(modalEmailEl.value, 'visitor@example.com');
});

test('submitting the exit-intent form posts to /buy/reminder and closes the modal on success', async (t) => {
  const reminderCalls = [];
  const { dom, window, document } = await bootAtBuyPage({
    fetchOverrides: [
      ['/pricing', () => ({ priceCents: 1999, currency: 'usd', minPaypalChargeCents: 50 })],
      ['/buy/reminder', (href, options) => { reminderCalls.push(JSON.parse(options.body)); return { ok: true }; }],
    ],
  });
  t.after(() => dom.window.close());

  fireMouseLeave(window, 0);
  const form = document.querySelector('#exit-intent-modal form[data-act="exit-intent-submit"]');
  // jsdom doesn't implement HTMLFormElement's named-control auto-property access (form.email
  // returning the <input name="email"> element) the way every real browser does -- see the same
  // shim in redeem-track-navigation.test.js's submitRedeemForm.
  const emailInput = form.querySelector('input[name="email"]');
  form.email = emailInput;
  emailInput.value = 'notready@example.com';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();

  assert.equal(reminderCalls.length, 1);
  assert.equal(reminderCalls[0].email, 'notready@example.com');
  assert.equal(document.getElementById('exit-intent-modal'), null, 'modal should close itself on a successful submit');
});

test('the dismiss button closes the modal without calling /buy/reminder', async (t) => {
  const reminderCalls = [];
  const { dom, window, document } = await bootAtBuyPage({
    fetchOverrides: [
      ['/pricing', () => ({ priceCents: 1999, currency: 'usd', minPaypalChargeCents: 50 })],
      ['/buy/reminder', (href, options) => { reminderCalls.push(JSON.parse(options.body)); return { ok: true }; }],
    ],
  });
  t.after(() => dom.window.close());

  fireMouseLeave(window, 0);
  const dismissBtn = document.querySelector('#exit-intent-modal [data-act="dismiss-exit-intent"]');
  dismissBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(document.getElementById('exit-intent-modal'), null);
  assert.equal(reminderCalls.length, 0);
});

test('a click on the dimmed backdrop closes the modal, but a click inside the card does not', async (t) => {
  const { dom, window, document } = await bootAtBuyPage();
  t.after(() => dom.window.close());

  fireMouseLeave(window, 0);
  const card = document.querySelector('.exit-intent-card');
  card.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(document.getElementById('exit-intent-modal'), 'clicking inside the card must not close it');

  const overlay = document.getElementById('exit-intent-modal');
  overlay.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(document.getElementById('exit-intent-modal'), null, 'clicking the backdrop itself should close it');
});
