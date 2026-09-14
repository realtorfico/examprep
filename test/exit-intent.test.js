// Regression tests for the buy-page exit-intent email capture (wwwroot/js/app.js,
// maybeShowExitIntentModal/maybeShowBuyPageNudge/showExitIntentModal/closeExitIntentModal) --
// added because the passive "Not ready today?" card (buy-reminder-card) is opt-in and easy to
// miss, so a visitor who reaches the buy page, never types an email, and just closes the tab
// leaves with nothing captured. Shows an active modal via two independent triggers sharing the
// same gate: the cursor leaving the viewport through the top (desktop's exit-intent signal), and a
// dwell timer (mobile's real gap, since there's no mouse signal to read there -- see
// BUY_PAGE_NUDGE_DWELL_MS's own comment for why a back-button trap and a passive sendBeacon
// capture were both ruled out first). Both reuse the same /buy/reminder endpoint the passive card
// already uses.
//
// Real mouse movement toward the browser chrome can't be simulated in jsdom, so these tests
// dispatch a synthetic 'mouseleave' with clientY set instead -- that's the exact (and only) signal
// the handler reads. Real 20-second waits aren't practical in a test either, so the dwell-timer
// test intercepts window.setTimeout to grab the actual scheduled callback and invoke it directly,
// rather than mocking time globally (which wouldn't reach jsdom's separate window realm anyway).
// Together these cover the real gating logic: only on the buy page, only once per session
// regardless of which trigger fires first, and the modal's own submit/dismiss wiring.

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

test('drawBuyForm schedules a dwell timer that shows the same modal when it fires', async (t) => {
  const scheduled = [];
  const { dom, window, document } = await bootAtBuyPage({
    windowSetup(win) {
      var realSetTimeout = win.setTimeout.bind(win);
      win.setTimeout = function (fn, delay) {
        scheduled.push({ fn: fn, delay: delay });
        return realSetTimeout(fn, delay);
      };
    },
  });
  t.after(() => dom.window.close());

  const dwellTimer = scheduled.find(function (s) { return s.delay === window.BUY_PAGE_NUDGE_DWELL_MS; });
  assert.ok(dwellTimer, 'drawBuyForm should schedule a timer at BUY_PAGE_NUDGE_DWELL_MS');
  assert.equal(document.getElementById('exit-intent-modal'), null, 'should not show before the dwell timer fires');

  dwellTimer.fn(); // simulate the timer firing without waiting the real 20s
  assert.ok(document.getElementById('exit-intent-modal'), 'dwell timer should show the same modal the mouseleave trigger shows');
});

test('the dwell timer respects the same once-per-session gate as the mouseleave trigger', async (t) => {
  const { dom, window, document } = await bootAtBuyPage();
  t.after(() => dom.window.close());

  fireMouseLeave(window, 0); // mouseleave fires first and sets the session flag
  assert.ok(document.getElementById('exit-intent-modal'));

  window.maybeShowBuyPageNudge(); // dwell timer's own target function, called directly
  assert.ok(document.getElementById('exit-intent-modal'), 'should not have closed or duplicated the already-open modal');
  assert.equal(document.querySelectorAll('#exit-intent-modal').length, 1);
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
