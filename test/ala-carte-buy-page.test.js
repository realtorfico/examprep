// Regression tests for the à la carte topic-picker UI on the buy page (CA CDL pilot) -- see
// project memory project_ca_cdl_topic_purchase_pilot. Real Turnstile/Stripe behavior is faked
// (same makeFakeTurnstile helper the existing buy-turnstile-token-reuse.test.js uses -- a real
// Cloudflare Turnstile challenge can't be solved by an automated test) so this exercises the real
// wiring: selecting topics actually changes what /stripe/create-intent gets sent, the displayed
// price actually comes from a server-quoted /topic-pricing response (never computed client-side,
// per the user's explicit "server-authoritative only" decision), and a track without any
// track_key_breakdown rows (every track except CA CDL today) renders identically to before this
// feature existed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor, settle, makeFakeTurnstile } = require('../test-support/boot-app');

function makeFakeStripe() {
  return function FakeStripe() {
    return { elements: () => ({ create: () => ({ mount: () => {} }) }) };
  };
}

const CA_CDL_BREAKDOWN = {
  items: [
    { label: 'General Knowledge (CDL Rules, Safe Driving & Cargo)', declared_pct: 48, sort_order: 0 },
    { label: 'Air Brakes, Combination Vehicles & Doubles/Triples', declared_pct: 19, sort_order: 1 },
    { label: 'Passenger, School Bus, Tank & HazMat Endorsements', declared_pct: 27, sort_order: 2 },
    { label: 'Vehicle Inspection Procedures', declared_pct: 6, sort_order: 3 },
  ],
};

function bootBuyPage(extraOverrides) {
  const { stub: turnstileStub } = makeFakeTurnstile();
  return bootApp({
    url: 'https://passexamhq.com/cdl/ca#/buy',
    windowSetup(win) {
      win.turnstileReady = true;
      win.turnstile = turnstileStub;
      win.Stripe = makeFakeStripe();
    },
    // extraOverrides FIRST -- makeFetchStub matches in array order, so a test's own
    // /stripe/create-intent override (every test below supplies one, to track calls) must be
    // checked before this helper's generic default, or the default silently wins every time and
    // the test's own tracking array never gets anything pushed to it.
    fetchOverrides: [
      ...(extraOverrides || []),
      ['/pricing', () => ({ priceCents: 3699, currency: 'usd', minPaypalChargeCents: 50 })],
      ['/stripe/create-intent', () => ({ clientSecret: 'cs_test_1', priceCents: 3699, pointsApplied: 0 })],
    ],
  });
}

test('a track with no track_key_breakdown rows (every track except CA CDL today) shows no topic picker at all', async (t) => {
  const { dom, document } = await bootBuyPage([
    ['/track-key-breakdown', { items: [] }],
  ]);
  t.after(() => dom.window.close());
  await waitFor(() => document.getElementById('stripe-payment-element') !== null);
  assert.equal(document.querySelector('.buy-topic-picker'), null, 'no track_key_breakdown rows means the feature renders nothing, unchanged from before it existed');
});

test('CA CDL shows the topic picker, defaulting to "Full track access" selected', async (t) => {
  const { dom, document } = await bootBuyPage([
    ['/track-key-breakdown', CA_CDL_BREAKDOWN],
  ]);
  t.after(() => dom.window.close());
  await waitFor(() => document.getElementById('stripe-payment-element') !== null);

  const picker = document.querySelector('.buy-topic-picker');
  assert.ok(picker, 'CA CDL has track_key_breakdown rows, so the picker must render');
  const fullRadio = picker.querySelector('input[value="full"]');
  assert.equal(fullRadio.checked, true, 'must default to full track access, never pre-select à la carte');
  assert.ok(picker.querySelector('.buy-topic-checkboxes').hidden, 'topic checkboxes stay hidden until "Choose specific topics" is picked');
});

test('each topic checkbox shows its own real server-quoted price up front, before anything is selected', async (t) => {
  const GK = CA_CDL_BREAKDOWN.items[0].label;
  const VIP = CA_CDL_BREAKDOWN.items[3].label;
  const { dom, document } = await bootBuyPage([
    ['/track-key-breakdown', CA_CDL_BREAKDOWN],
    ['/topic-pricing', (href) => {
      const parsedTopics = JSON.parse(new URL(href, 'https://x').searchParams.get('topics'));
      assert.deepEqual(parsedTopics, CA_CDL_BREAKDOWN.items.map((i) => i.label), 'the up-front quote must cover every topic on the track, not just one');
      return { totalCents: 5697, items: [
        { label: GK, priceCents: 2199 },
        { label: CA_CDL_BREAKDOWN.items[1].label, priceCents: 1499 },
        { label: CA_CDL_BREAKDOWN.items[2].label, priceCents: 1499 },
        { label: VIP, priceCents: 999 },
      ] };
    }],
  ]);
  t.after(() => dom.window.close());
  await waitFor(() => document.getElementById('stripe-payment-element') !== null);

  const options = Array.from(document.querySelectorAll('.buy-topic-option'));
  const gkOption = options.find((o) => o.textContent.indexOf(GK) !== -1);
  const vipOption = options.find((o) => o.textContent.indexOf(VIP) !== -1);
  assert.match(gkOption.querySelector('.buy-topic-price').textContent, /\$21\.99/);
  assert.match(vipOption.querySelector('.buy-topic-price').textContent, /\$9\.99/, 'the price-floor topic must show its real floored price, not a proportional one');
});

test('selecting a topic fetches a real server-quoted price and sends it (not a full-price mount) to /stripe/create-intent', async (t) => {
  const createIntentCalls = [];
  const GK = CA_CDL_BREAKDOWN.items[0].label;
  const { dom, window, document } = await bootBuyPage([
    ['/track-key-breakdown', CA_CDL_BREAKDOWN],
    ['/topic-pricing', (href) => {
      assert.match(href, /topics=/, 'must call the real pricing endpoint, not compute a price client-side');
      return { totalCents: 2199, items: [{ label: GK, priceCents: 2199 }] };
    }],
    ['/stripe/create-intent', (href, options) => {
      const parsed = JSON.parse(options.body);
      createIntentCalls.push(parsed);
      return { clientSecret: 'cs_test_' + createIntentCalls.length, priceCents: 2199, pointsApplied: 0 };
    }],
  ]);
  t.after(() => dom.window.close());
  await waitFor(() => document.getElementById('stripe-payment-element') !== null);
  await waitFor(() => createIntentCalls.length === 1); // initial full-price mount

  const topicsRadio = document.querySelector('.buy-topic-picker input[value="topics"]');
  topicsRadio.checked = true;
  topicsRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();

  const gkCheckbox = Array.from(document.querySelectorAll('.buy-topic-checkbox')).find((c) => c.value === GK);
  gkCheckbox.checked = true;
  gkCheckbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => createIntentCalls.length === 2, { timeout: 3000 });

  assert.deepEqual(createIntentCalls[1].topics, [GK], 'the second create-intent call must carry the selected topic');
  const orderSummary = document.getElementById('buy-order-summary-wrap');
  assert.match(orderSummary.textContent, /\$21\.99/, 'the order summary must reflect the server-quoted à la carte price');
  assert.match(orderSummary.textContent, /1 of 4 Topics/);
});

test('switching to "Choose specific topics" with nothing checked disables Pay and never mounts a payable full-price element', async (t) => {
  const createIntentCalls = [];
  const { dom, window, document } = await bootBuyPage([
    ['/track-key-breakdown', CA_CDL_BREAKDOWN],
    ['/stripe/create-intent', (href, options) => { createIntentCalls.push(JSON.parse(options.body)); return { clientSecret: 'cs_test_x', priceCents: 3699, pointsApplied: 0 }; }],
  ]);
  t.after(() => dom.window.close());
  await waitFor(() => document.getElementById('stripe-payment-element') !== null);
  await waitFor(() => createIntentCalls.length === 1);

  const topicsRadio = document.querySelector('.buy-topic-picker input[value="topics"]');
  topicsRadio.checked = true;
  topicsRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();

  assert.equal(createIntentCalls.length, 1, 'must not fire another create-intent call with nothing selected');
  assert.equal(document.getElementById('stripe-pay-button').disabled, true, 'Pay must be disabled -- nothing to charge for yet');
  assert.match(document.getElementById('stripe-payment-element').textContent, /Select at least one topic/);
});

test('switching to à la carte mode hides and un-checks the gift toggle', async (t) => {
  const { dom, window, document } = await bootBuyPage([
    ['/track-key-breakdown', CA_CDL_BREAKDOWN],
  ]);
  t.after(() => dom.window.close());
  await waitFor(() => document.getElementById('stripe-payment-element') !== null);

  const giftCheckbox = document.getElementById('buy-gift-checkbox');
  giftCheckbox.checked = true;

  const topicsRadio = document.querySelector('.buy-topic-picker input[value="topics"]');
  topicsRadio.checked = true;
  topicsRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();

  assert.equal(giftCheckbox.checked, false, 'gift must be force-unchecked when switching to à la carte');
  assert.equal(document.querySelector('.buy-gift-toggle').hidden, true);
});

test('switching back to "Full track access" reverts to the normal full-price mount', async (t) => {
  const createIntentCalls = [];
  const { dom, window, document } = await bootBuyPage([
    ['/track-key-breakdown', CA_CDL_BREAKDOWN],
    ['/topic-pricing', () => ({ totalCents: 2199, items: [{ label: CA_CDL_BREAKDOWN.items[0].label, priceCents: 2199 }] })],
    ['/stripe/create-intent', (href, options) => { createIntentCalls.push(JSON.parse(options.body)); return { clientSecret: 'cs_test_' + createIntentCalls.length, priceCents: createIntentCalls.length === 1 ? 3699 : 2199, pointsApplied: 0 }; }],
  ]);
  t.after(() => dom.window.close());
  await waitFor(() => document.getElementById('stripe-payment-element') !== null);
  await waitFor(() => createIntentCalls.length === 1);

  const topicsRadio = document.querySelector('.buy-topic-picker input[value="topics"]');
  topicsRadio.checked = true;
  topicsRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  const gkCheckbox = document.querySelector('.buy-topic-checkbox');
  gkCheckbox.checked = true;
  gkCheckbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => createIntentCalls.length === 2);
  assert.equal(createIntentCalls[1].topics.length, 1);

  const fullRadio = document.querySelector('.buy-topic-picker input[value="full"]');
  fullRadio.checked = true;
  fullRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => createIntentCalls.length === 3);

  assert.equal(createIntentCalls[2].topics, undefined, 'reverting to full track access must not send a topics field at all');
  const orderSummary = document.getElementById('buy-order-summary-wrap');
  assert.match(orderSummary.textContent, /Full Access/);
});

// Promo codes only ever discount a FULL-track checkout (the API's à la carte branch returns before any
// promo math). Found 2026-09-17: applying a code while buying specific topics left "Checking…" on screen
// forever -- no discount, no explanation -- and the 9/16 CDL-only promo banner now advertises a code on
// every CDL buy page, right above the topic picker.
async function selectFirstTopic(window, document) {
  const topicsRadio = document.querySelector('.buy-topic-picker input[value="topics"]');
  topicsRadio.checked = true;
  topicsRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const gkCheckbox = document.querySelectorAll('.buy-topic-checkbox')[0];
  gkCheckbox.checked = true;
  gkCheckbox.dispatchEvent(new window.Event('change', { bubbles: true }));
}

async function applyPromo(window, document, code) {
  const input = document.getElementById('buy-promo-input');
  input.value = code;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('[data-act="apply-promo-code"]').click();
}

function topicModeOverrides(createIntentCalls) {
  const GK = CA_CDL_BREAKDOWN.items[0].label;
  return [
    ['/track-key-breakdown', CA_CDL_BREAKDOWN],
    ['/topic-pricing', () => ({ totalCents: 2199, items: [{ label: GK, priceCents: 2199 }] })],
    ['/stripe/create-intent', (href, options) => {
      const parsed = JSON.parse(options.body);
      createIntentCalls.push(parsed);
      // Mirrors the real API: a topic purchase ignores the promo; a full-track one discounts.
      if (parsed.topics) return { clientSecret: 'cs_t_' + createIntentCalls.length, priceCents: 2199, pointsApplied: 0 };
      return parsed.promoCode
        ? { clientSecret: 'cs_f_' + createIntentCalls.length, priceCents: 2959, promoDiscountCents: 740, promoTitle: 'New CDL', pointsApplied: 0 }
        : { clientSecret: 'cs_f_' + createIntentCalls.length, priceCents: 3699, pointsApplied: 0 };
    }],
  ];
}

test('applying a promo code while buying specific topics says promos are full-track only, instead of hanging on "Checking…"', async (t) => {
  const createIntentCalls = [];
  const { dom, window, document } = await bootBuyPage(topicModeOverrides(createIntentCalls));
  t.after(() => dom.window.close());
  await waitFor(() => document.getElementById('stripe-payment-element') !== null);
  await waitFor(() => createIntentCalls.length === 1);
  await selectFirstTopic(window, document);
  await waitFor(() => createIntentCalls.length === 2, { timeout: 3000 });

  await applyPromo(window, document, 'NEWCDL20');
  await waitFor(() => createIntentCalls.length === 3, { timeout: 3000 });
  await settle();

  const result = document.getElementById('buy-promo-result').textContent;
  assert.doesNotMatch(result, /Checking/, 'must not be left spinning');
  assert.match(result, /full-track/i, 'must explain why no discount was applied');
  assert.match(document.getElementById('buy-order-summary-wrap').textContent, /\$21\.99/, 'topic price unchanged -- no promo discount on topics');
});

test('a promo applied to the full track, then switching to specific topics, no longer claims it is applied', async (t) => {
  const createIntentCalls = [];
  const { dom, window, document } = await bootBuyPage(topicModeOverrides(createIntentCalls));
  t.after(() => dom.window.close());
  await waitFor(() => document.getElementById('stripe-payment-element') !== null);
  await waitFor(() => createIntentCalls.length === 1);

  await applyPromo(window, document, 'NEWCDL20');
  await waitFor(() => createIntentCalls.length === 2, { timeout: 3000 });
  await waitFor(() => /applied/.test(document.getElementById('buy-promo-result').textContent));

  await selectFirstTopic(window, document);
  await waitFor(() => createIntentCalls.length === 3, { timeout: 3000 });
  await settle();

  const result = document.getElementById('buy-promo-result').textContent;
  assert.doesNotMatch(result, /applied/, 'the full-track discount must not still read as applied to a topic purchase');
  assert.match(result, /full-track/i);
});

test('guard: switching back to the full track re-applies the promo discount', async (t) => {
  const createIntentCalls = [];
  const { dom, window, document } = await bootBuyPage(topicModeOverrides(createIntentCalls));
  t.after(() => dom.window.close());
  await waitFor(() => document.getElementById('stripe-payment-element') !== null);
  await waitFor(() => createIntentCalls.length === 1);
  await selectFirstTopic(window, document);
  await waitFor(() => createIntentCalls.length === 2, { timeout: 3000 });
  await applyPromo(window, document, 'NEWCDL20');
  await waitFor(() => createIntentCalls.length === 3, { timeout: 3000 });

  const fullRadio = document.querySelector('.buy-topic-picker input[value="full"]');
  fullRadio.checked = true;
  fullRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => createIntentCalls.length === 4, { timeout: 3000 });
  assert.equal(createIntentCalls[3].promoCode, 'NEWCDL20');
  await waitFor(() => /applied/.test(document.getElementById('buy-promo-result').textContent));
});
