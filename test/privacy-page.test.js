// The privacy page (#/privacy) must describe what the site actually collects and who it shares data with.
// Rewritten 2026-09-17: the old one-paragraph page said "We store the minimum needed", "We never sell or share
// this data", and never mentioned Google Ads (conversion tracking + remarketing, which Google requires sites
// to disclose), Microsoft Clarity session recordings, or the visitor analytics in site_visits. Wording approved
// by the site owner (drafts/misc/privacy_page_draft_2026-09-17.md).
//
// The drift guards at the bottom fail when a new third-party script origin (CSP script-src) or a new cookie is
// added without the privacy page naming it.
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp, waitFor } = require('../test-support/boot-app');

const WWWROOT = path.join(__dirname, '..', 'wwwroot');

async function privacyPage(t) {
  const { dom, document } = await bootApp({ url: 'https://passexamhq.com/#/privacy' });
  t.after(() => dom.window.close());
  await waitFor(() => document.querySelector('.narrow-page h1') && /Privacy/.test(document.querySelector('.narrow-page h1').textContent));
  return document.querySelector('.narrow-page');
}
const text = (el) => el.textContent.replace(/\s+/g, ' ');

test('privacy page has a last-updated date and all six sections', async (t) => {
  const page = await privacyPage(t);
  assert.match(text(page), /Last updated: September 18, 2026/);
  const headings = Array.from(page.querySelectorAll('h2')).map((h) => h.textContent.trim());
  assert.deepEqual(headings, ['What we collect', 'Cookies and browser storage', 'Services we use', 'How we use it', "What we don't do", 'Your choices']);
});

test('privacy page describes the visit analytics the site records', async (t) => {
  const t_ = text(await privacyPage(t));
  for (const phrase of ['random visitor ID', 'pages you view', 'how many times you click', "Google's click ID",
    'IP address', 'approximate location', 'device and browser type', 'blocked attempts']) {
    assert.ok(t_.includes(phrase), `mentions "${phrase}"`);
  }
});

test('privacy page says a typed checkout email can get a reminder without a purchase', async (t) => {
  assert.match(text(await privacyPage(t)), /enter your email at checkout, even if you don't finish buying \(we may send you a reminder\)/);
});

test('privacy page names every service we use, including remarketing', async (t) => {
  const t_ = text(await privacyPage(t));
  for (const name of ['Stripe', 'Cloudflare', 'Turnstile', 'Resend', 'Google Ads', 'remarketing', 'Microsoft Clarity']) {
    assert.ok(t_.includes(name), `names ${name}`);
  }
});

test('privacy page links Google and Microsoft opt-out/policy pages in a new tab', async (t) => {
  const page = await privacyPage(t);
  for (const href of ['https://myadcenter.google.com/', 'https://policies.google.com/technologies/partner-sites', 'https://privacy.microsoft.com/privacystatement']) {
    const a = page.querySelector(`a[href="${href}"]`);
    assert.ok(a, `links ${href}`);
    assert.equal(a.getAttribute('target'), '_blank');
    assert.match(a.getAttribute('rel') || '', /noopener/);
  }
  assert.ok(page.querySelector('a[href="#/contact"]'), 'contact link for access/deletion/email requests');
});

test('privacy page no longer makes the old inaccurate claims', async (t) => {
  const t_ = text(await privacyPage(t));
  assert.doesNotMatch(t_, /We store the minimum needed/);
  assert.doesNotMatch(t_, /We never sell or share this data/);
  assert.doesNotMatch(t_, /Contact whoever issued your code/);
  assert.match(t_, /We don't sell your personal information\./);
});

test('guard: privacy page keeps its Back button', async (t) => {
  assert.ok((await privacyPage(t)).querySelector('button[data-act="go-back"]'));
});

// ---- Drift guards ----------------------------------------------------------------------------------

// Every third-party host the site may load scripts from, and the service the privacy page must name for it.
// A new host in CSP script-src without an entry here fails the test -- add the service to the privacy page
// (and here) before shipping it.
const SCRIPT_HOST_SERVICE = {
  'challenges.cloudflare.com': 'Cloudflare',
  'static.cloudflareinsights.com': 'Cloudflare',
  'js.stripe.com': 'Stripe',
  '*.js.stripe.com': 'Stripe',
  'www.googletagmanager.com': 'Google Ads',
  'www.googleadservices.com': 'Google Ads',
  'www.google.com': 'Google Ads',
  'pagead2.googlesyndication.com': 'Google Ads',
  'googleads.g.doubleclick.net': 'Google Ads',
  '*.clarity.ms': 'Microsoft Clarity',
  'c.bing.com': 'Microsoft Clarity',
};

test('drift guard: every third-party script host in the site CSP maps to a service the privacy page names', async (t) => {
  const headers = fs.readFileSync(path.join(WWWROOT, '_headers'), 'utf8');
  const csp = headers.split(/\r?\n/).find((l) => /^\s*Content-Security-Policy:.*googletagmanager/.test(l));
  const scriptSrc = csp.match(/script-src ([^;]*)/)[1].split(/\s+/).filter((s) => /^https:\/\//.test(s)).map((s) => s.replace('https://', ''));
  const unmapped = scriptSrc.filter((h) => !SCRIPT_HOST_SERVICE[h]);
  assert.deepEqual(unmapped, [], 'new script host(s) need a privacy page entry');
  const t_ = text(await privacyPage(t));
  for (const h of scriptSrc) assert.ok(t_.includes(SCRIPT_HOST_SERVICE[h]), `${h} -> privacy page names ${SCRIPT_HOST_SERVICE[h]}`);
});

test('drift guard: every cookie the site sets is named on the privacy page', async (t) => {
  const appJs = fs.readFileSync(path.join(WWWROOT, 'js', 'app.js'), 'utf8');
  const worker = fs.readFileSync(path.join(WWWROOT, '_worker.js'), 'utf8');
  const names = new Set();
  for (const m of appJs.matchAll(/document\.cookie\s*=\s*'([A-Za-z0-9_]+)=/g)) names.add(m[1]);
  for (const m of worker.matchAll(/'Set-Cookie',\s*'([A-Za-z0-9_]+)=/g)) names.add(m[1]);
  assert.ok(names.size > 0, 'found the cookie writes');
  const t_ = text(await privacyPage(t));
  for (const n of names) assert.ok(t_.includes(n), `cookie ${n} is named`);
});
