// The site's Google Ads tag moved to a new Ads account on 2026-09-18: AW-18460635935 replaces
// AW-1046929025 (owner's call; the old account's campaign stops getting purchase and remarketing data).
// Purchases fire the new account's own "Purchase (1)" conversion (GOOGLE_ADS_PURCHASE_SEND_TO in
// app.js, added the same day) -- never the old account's label, which points at a tag the page no
// longer loads.
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp } = require('../test-support/boot-app');

const WWWROOT = path.join(__dirname, '..', 'wwwroot');
const read = (p) => fs.readFileSync(path.join(WWWROOT, p), 'utf8');
const NEW_ID = 'AW-18460635935';
const OLD_ID = '1046929025';

test('index.html loads gtag.js for the new account, once', () => {
  const html = read('index.html');
  const srcs = html.match(/googletagmanager\.com\/gtag\/js\?id=[A-Z0-9-]+/g) || [];
  assert.deepEqual(srcs, ['googletagmanager.com/gtag/js?id=' + NEW_ID]);
});

test('gtag-init.js configures only the new account', () => {
  const src = read('js/gtag-init.js');
  const configs = src.match(/gtag\('config',\s*'[^']+'\)/g) || [];
  assert.deepEqual(configs, ["gtag('config', '" + NEW_ID + "')"]);
});

// Comments may still name it as history; code may not.
test('the old account ID is gone from every line of code the site ships', () => {
  for (const f of ['index.html', 'js/gtag-init.js', 'js/app.js', 'js/app.min.js']) {
    const code = read(f).split(/\r?\n/).filter((line) => !/^\s*\/\//.test(line)).join('\n');
    assert.ok(!code.includes(OLD_ID), f + ' still references ' + OLD_ID);
  }
});

async function bootWithGtag() {
  const calls = [];
  const booted = await bootApp({
    url: 'https://passexamhq.com/',
    windowSetup(win) { win.gtag = function () { calls.push(Array.from(arguments)); }; },
  });
  return { ...booted, calls };
}

// The new account's "Purchase (1)" conversion action, created 2026-09-18.
const PURCHASE_SEND_TO = NEW_ID + '/jF5zCJS-1_wcEJ_m2-JE';

test('a purchase fires the new account\'s Purchase conversion with the real amount and order code', async (t) => {
  const { dom, window, calls } = await bootWithGtag();
  t.after(() => dom.window.close());
  calls.length = 0;
  window.firePurchaseConversion(2959, 'ABCDE-12345'); // e.g. $36.99 less NEWCDL20's 20%
  const conv = calls.filter((c) => c[1] === 'conversion');
  assert.equal(conv.length, 1);
  // JSON round trip: the object was built inside jsdom's realm, so its prototype isn't this one's.
  assert.deepEqual(JSON.parse(JSON.stringify(conv[0][2])), { send_to: PURCHASE_SEND_TO, value: 29.59, currency: 'USD', transaction_id: 'ABCDE-12345' });
});

test('nothing fires without a real captured amount', async (t) => {
  const { dom, window, calls } = await bootWithGtag();
  t.after(() => dom.window.close());
  calls.length = 0;
  window.firePurchaseConversion(0, 'ABCDE-12345');
  window.firePurchaseConversion(undefined, 'ABCDE-12345');
  assert.deepEqual(calls.filter((c) => c[1] === 'conversion'), []);
});
