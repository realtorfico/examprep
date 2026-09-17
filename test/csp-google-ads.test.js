// The site-wide Content-Security-Policy (wwwroot/_headers) must allow everything Google Ads
// conversion tracking and remarketing load, per Google's own list:
// https://developers.google.com/tag-platform/security/guides/csp ("Google Ads conversions &
// remarketing"). A CSP block on a beacon or tag fails silently -- no error a human would notice --
// which is how the account's Purchases conversion sat at "Awaiting conversions" on 2026-09-10, and
// how on 2026-09-17 a live page load was found blocking the remarketing tag
// (googleads.g.doubleclick.net/pagead/viewthroughconversion) and the conversion-measurement ping
// (ad.doubleclick.net/ccm/s/collect).
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HEADERS = fs.readFileSync(path.join(__dirname, '..', 'wwwroot', '_headers'), 'utf8');

// The CSP line inside a given path block of _headers (e.g. '/*'), parsed into { directive: [sources] }.
function cspFor(block) {
  const lines = HEADERS.split(/\r?\n/);
  const start = lines.indexOf(block);
  assert.notEqual(start, -1, `_headers has no ${block} block`);
  for (let i = start + 1; i < lines.length && /^\s/.test(lines[i]); i++) {
    const m = lines[i].match(/^\s*Content-Security-Policy:\s*(.*)$/);
    if (m) {
      const policy = {};
      m[1].split(';').map((d) => d.trim()).filter(Boolean).forEach((d) => {
        const [name, ...sources] = d.split(/\s+/);
        policy[name] = sources;
      });
      return policy;
    }
  }
  assert.fail(`${block} block has no Content-Security-Policy`);
}

// Minimal CSP host-source match: exact scheme+host, or a leading *. wildcard subdomain.
function allows(policy, directive, url) {
  const sources = policy[directive] || policy['default-src'] || [];
  const u = new URL(url);
  return sources.some((s) => {
    if (!/^https:\/\//.test(s)) return false;
    const host = s.replace(/^https:\/\//, '').replace(/\/.*$/, '');
    return host.startsWith('*.') ? u.hostname.endsWith(host.slice(1)) : u.hostname === host;
  });
}

const site = cspFor('/*');

const GOOGLE_ADS_REQUIRED = {
  'script-src': ['https://www.googleadservices.com', 'https://www.google.com', 'https://www.googletagmanager.com',
    'https://pagead2.googlesyndication.com', 'https://googleads.g.doubleclick.net'],
  'img-src': ['https://www.googletagmanager.com', 'https://googleads.g.doubleclick.net', 'https://www.google.com',
    'https://pagead2.googlesyndication.com', 'https://www.googleadservices.com', 'https://google.com'],
  'frame-src': ['https://www.googletagmanager.com'],
  'connect-src': ['https://pagead2.googlesyndication.com', 'https://www.googleadservices.com', 'https://googleads.g.doubleclick.net',
    'https://ad.doubleclick.net', 'https://www.google.com', 'https://google.com'],
};

for (const [directive, origins] of Object.entries(GOOGLE_ADS_REQUIRED)) {
  test(`site CSP ${directive} allows every origin Google documents for Ads conversions & remarketing`, () => {
    const missing = origins.filter((o) => !(site[directive] || []).includes(o));
    assert.deepEqual(missing, [], `${directive} is missing: ${missing.join(' ')}`);
  });
}

test('site CSP allows the exact Google Ads requests a live page load was seen being blocked', () => {
  assert.ok(allows(site, 'script-src', 'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1046929025/'), 'remarketing tag script');
  assert.ok(allows(site, 'connect-src', 'https://ad.doubleclick.net/ccm/s/collect'), 'conversion measurement ping (fetch)');
  assert.ok(allows(site, 'img-src', 'https://ad.doubleclick.net/ccm/s/collect'), 'conversion measurement ping (image fallback)');
});

// ---- Guards: the fix must not loosen or break anything else ----

test('guard: site CSP still never allows inline or eval script', () => {
  for (const d of ['default-src', 'script-src', 'script-src-elem']) {
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'"]) {
      assert.ok(!(site[d] || []).includes(bad), `${d} must not contain ${bad}`);
    }
  }
});

test('guard: site CSP keeps Stripe, Turnstile, Cloudflare analytics and Clarity allowances', () => {
  assert.ok(allows(site, 'script-src', 'https://js.stripe.com/v3/'));
  assert.ok(allows(site, 'frame-src', 'https://js.stripe.com/'));
  assert.ok(allows(site, 'frame-src', 'https://hooks.stripe.com/'));
  assert.ok(allows(site, 'connect-src', 'https://api.stripe.com/v1/payment_intents'));
  assert.ok(allows(site, 'script-src', 'https://challenges.cloudflare.com/turnstile/v0/api.js'));
  assert.ok(allows(site, 'frame-src', 'https://challenges.cloudflare.com/'));
  assert.ok(allows(site, 'script-src', 'https://static.cloudflareinsights.com/beacon.min.js'));
  assert.ok(allows(site, 'script-src', 'https://www.clarity.ms/tag/x'));
  assert.deepEqual(site['frame-ancestors'], ["'self'"]);
  assert.deepEqual(site['object-src'], ["'none'"]);
});

test('guard: the embeddable QOTD widget CSP stays self-only (no ad or tracking origins)', () => {
  const embed = cspFor('/embed/*');
  for (const d of ['script-src', 'img-src', 'connect-src']) {
    assert.deepEqual(embed[d], d === 'img-src' ? ["'self'", 'data:'] : ["'self'"], `/embed/* ${d}`);
  }
});
