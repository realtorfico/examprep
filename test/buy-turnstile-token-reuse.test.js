// Regression test for the buy-page Turnstile token-reuse bug (site commits d430685, then a
// same-day follow-up fix) -- see project memory
// project_winback_campaign_and_checkout_intents_bug.md for the full incident history:
//
// 1. Turnstile tokens are single-use server-side, but window.turnstile.getResponse() keeps
//    returning the same cached (now-spent) string after it's been sent once. Every re-mount of the
//    Payment Element after the first (buyer edits email, applies a promo, toggles points) used to
//    resend that spent token, get turnstile_failed, and the catch-all wiped the already-working
//    payment form -- confirmed live via checkout_intents sitting at zero rows in production despite
//    real completed purchases.
// 2. The first fix (turnstile.reset() instead of resending) introduced a NEW bug, caught by a
//    same-day /code-review xhigh run before it could do damage: turnstileTokenConsumed was cleared
//    only by renderTurnstileWidget's initial render() call, never by reset()'s own callback -- so
//    after the very first mount, EVERY later trigger looped forever
//    (reset -> callback -> mountStripePaymentElement -> still "consumed" -> reset -> ...) and the
//    payment element never actually remounted, while leaving the STALE pre-edit element visible and
//    clickable (a silent wrong-price-charge risk, not just an unlogged row).
//
// This test simulates real Turnstile/Stripe behavior with fakes (a real Cloudflare Turnstile
// challenge can't be solved by an automated test -- it's designed to detect exactly that) and
// asserts: (a) a second edit gets a genuinely different token than the first, not a resend,
// (b) the sequence actually settles (regression coverage for the infinite-loop bug) rather than
// hanging, and (c) the pay button is disabled while a fresh token is in flight so a buyer can't
// submit against stale pricing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor } = require('../test-support/boot-app');

function makeFakeTurnstile() {
  let tokenCounter = 0;
  let currentToken = '';
  let widgetCallback = null;
  const resetCalls = [];
  return {
    stub: {
      render(el, opts) {
        widgetCallback = opts.callback;
        currentToken = '';
        setTimeout(() => {
          tokenCounter++;
          currentToken = 'token-' + tokenCounter;
          widgetCallback();
        }, 5);
        return 'widget-1';
      },
      getResponse() { return currentToken; },
      reset(id) {
        resetCalls.push(id);
        currentToken = ''; // the widget's own token is invalidated immediately on reset
        setTimeout(() => {
          tokenCounter++;
          currentToken = 'token-' + tokenCounter;
          widgetCallback();
        }, 5);
      },
    },
    resetCalls,
  };
}

function makeFakeStripe() {
  const elementsCalls = [];
  return function FakeStripe() {
    return {
      elements(opts) {
        elementsCalls.push(opts.clientSecret);
        return { create: () => ({ mount: () => {} }) };
      },
    };
  };
}

test('editing the buy-page email after the initial mount gets a fresh Turnstile token, not a resend, and does not hang', async (t) => {
  const { stub: turnstileStub, resetCalls } = makeFakeTurnstile();
  const createIntentCalls = [];

  const { dom, window, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/pa#/buy',
    windowSetup(win) {
      win.turnstileReady = true;
      win.turnstile = turnstileStub;
      win.Stripe = makeFakeStripe();
    },
    fetchOverrides: [
      ['/pricing', () => ({ priceCents: 1999, currency: 'usd', minPaypalChargeCents: 50 })],
      ['/stripe/create-intent', (href, options) => {
        const parsed = JSON.parse(options.body);
        createIntentCalls.push({ token: parsed.turnstileToken, email: parsed.email });
        return { clientSecret: 'cs_test_' + createIntentCalls.length, priceCents: 1999, pointsApplied: 0 };
      }],
    ],
  });
  t.after(() => dom.window.close());

  // renderBuy()'s own pricing fetch (see app.js) runs after bootApp's generic "not Loading…" check
  // already passed, so wait for the real buy-form markers specifically.
  await waitFor(() => document.getElementById('stripe-payment-element') !== null);

  // Initial mount: exactly one create-intent call, with no email yet (matches real behavior --
  // checkout_intents is only ever written once a typed email reaches this call).
  await waitFor(() => createIntentCalls.length === 1, { timeout: 3000 });
  assert.equal(createIntentCalls[0].email, undefined);
  assert.equal(window.turnstileTokenConsumed, true, 'the first token should be marked spent once sent');

  const payBtn = document.getElementById('stripe-pay-button');
  assert.equal(payBtn.disabled, false, 'pay button should be enabled after a successful initial mount');

  // Simulate typing an email -- this is the exact trigger that used to either resend a spent token
  // (bug #1) or loop forever (bug #2).
  const emailInput = document.getElementById('buy-email');
  emailInput.value = 'buyer@example.com';
  emailInput.dispatchEvent(new window.Event('input', { bubbles: true }));

  // The debounce is 600ms; give it real margin. If the loop bug regresses, this never reaches 2 and
  // waitFor's own timeout below fails the test instead of hanging indefinitely.
  await waitFor(() => createIntentCalls.length === 2, { timeout: 3000 });

  assert.equal(createIntentCalls[1].email, 'buyer@example.com', 'the re-mount should carry the typed email');
  assert.notEqual(
    createIntentCalls[1].token, createIntentCalls[0].token,
    'the second create-intent call must use a genuinely fresh token, not resend the first (already-spent) one'
  );
  assert.ok(resetCalls.length >= 1, 'turnstile.reset() should have been called to obtain the fresh token');

  // Must settle back to a normal, submittable state -- not stuck disabled, not stuck on a stale
  // element from before the edit.
  await waitFor(() => payBtn.disabled === false, { timeout: 1000 });
  assert.equal(window.turnstileTokenConsumed, true);

  // A second consecutive edit must also work (not just the first one) -- guards against a fix that
  // only handles a single reset cycle.
  emailInput.value = 'buyer2@example.com';
  emailInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => createIntentCalls.length === 3, { timeout: 3000 });
  assert.equal(createIntentCalls[2].email, 'buyer2@example.com');
  assert.notEqual(createIntentCalls[2].token, createIntentCalls[1].token);
});
