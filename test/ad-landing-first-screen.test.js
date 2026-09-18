// What a phone visitor sees on the first screen of an ad landing page (/cdl). Added 2026-09-17: Google Ads
// rated "Landing page experience" Below average on 9 of the CDL campaign's 10 scored keywords, 56% of ad
// visitors left within 10 seconds without a tap, and a mobile screenshot of /cdl showed why -- a sitewide
// "500+ new California Notary questions" announcement above the CDL headline, no practice button anywhere
// on the first screen, and the 💡/🐞 floating buttons sitting on top of the hero text. Three fixes:
// 1. Site announcements (SITE_NEWS) carry a kind and show only on that kind's category + track pages.
// 2. Category pages get a "Start Free Practice Test" button right under the subheadline on mobile
//    (the existing "Try Free Sample" button further down is hidden there so it isn't shown twice).
// 3. On mobile, the 💡 suggestion and 🐞 issue-report buttons stay hidden on the visitor's first screen,
//    until they scroll past half a screen or navigate in-app (the 💬 help chat stays put).
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp, waitFor, settle } = require('../test-support/boot-app');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'wwwroot', 'css', 'style.css'), 'utf8');
const NOTARY_NEWS_TEXT = /500\+ new California Notary practice questions/;

async function boot(t, url, extra) {
  const booted = await bootApp(Object.assign({ url }, extra || {}));
  t.after(() => booted.dom.window.close());
  await settle();
  return booted;
}
// [data-news-id] = the SITE_NEWS announcement specifically; the homepage bookmark nudge shares .news-flash-banner.
const newsBanner = (document) => document.querySelector('.news-flash-banner[data-news-id]');

// Concatenated contents of every @media (max-width: 600px) block in style.css.
function mobileCss() {
  let out = '';
  const re = /@media \(max-width: 600px\)\s*\{/g;
  let m;
  while ((m = re.exec(CSS))) {
    let depth = 1, i = re.lastIndex;
    for (; i < CSS.length && depth; i++) { if (CSS[i] === '{') depth++; else if (CSS[i] === '}') depth--; }
    out += CSS.slice(re.lastIndex, i - 1) + '\n';
  }
  return out;
}
// Top-level CSS only (media blocks stripped), to check a rule's default outside any breakpoint.
function topLevelCss() {
  return CSS.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
}

// ---- 1. Announcements only on their own category ----------------------------------------------

test('the Notary announcement does not show on the /cdl category page', async (t) => {
  const { document } = await boot(t, 'https://passexamhq.com/cdl');
  await waitFor(() => document.getElementById('category-hero-headline'));
  assert.equal(newsBanner(document), null);
});

test('the Notary announcement does not show on a CDL track page', async (t) => {
  const { document } = await boot(t, 'https://passexamhq.com/cdl/ca#/info');
  await waitFor(() => document.querySelector('nav.tabs'));
  assert.equal(newsBanner(document), null);
});

test('the Notary announcement does not show on the homepage (not a Notary page)', async (t) => {
  const { document } = await boot(t, 'https://passexamhq.com/');
  await waitFor(() => document.querySelector('.hub-hero'));
  assert.equal(newsBanner(document), null);
});

test('guard: the Notary announcement still shows on the /notary category page', async (t) => {
  const { document } = await boot(t, 'https://passexamhq.com/notary');
  await waitFor(() => document.getElementById('category-hero-headline'));
  assert.ok(newsBanner(document));
  assert.match(newsBanner(document).textContent, NOTARY_NEWS_TEXT);
});

test('guard: the Notary announcement still shows on a Notary track page', async (t) => {
  const { document } = await boot(t, 'https://passexamhq.com/notary/ca#/info');
  await waitFor(() => document.querySelector('nav.tabs'));
  assert.ok(newsBanner(document));
});

test('guard: a dismissed announcement stays dismissed on its own category page', async (t) => {
  const { window } = await boot(t, 'https://passexamhq.com/notary');
  const newsId = window.SITE_NEWS.id;
  const { document } = await boot(t, 'https://passexamhq.com/notary', { localStorageItems: { examprep_news_dismissed: newsId } });
  await waitFor(() => document.getElementById('category-hero-headline'));
  assert.equal(newsBanner(document), null);
});

// ---- 2. Practice button on the first screen ----------------------------------------------------

test('/cdl hero has a "Start Free Practice Test" button right under the subheadline, ahead of the state picker', async (t) => {
  const { document } = await boot(t, 'https://passexamhq.com/cdl');
  await waitFor(() => document.getElementById('category-hero-subhead'));
  const early = document.getElementById('category-hero-subhead').nextElementSibling;
  assert.ok(early && early.classList.contains('hub-hero-cta-early'), 'the element right after the subheadline is the early CTA');
  const btn = early.querySelector('button[data-act="scroll-to-category-sample"]');
  assert.ok(btn, 'wired to the same free-sample scroll as the existing button');
  assert.equal(btn.textContent.trim(), 'Start Free Practice Test');
  // The trust badges left the hero on 2026-09-17 (the seal and the guarantee card already made
  // those claims, and the hero read as crowded). The state picker is what the CTA now has to
  // precede: the point of this test is that the practice button is reachable without scrolling
  // past the page's form controls.
  const picker = document.querySelector('.hub-hero .category-state-select-label');
  assert.ok(picker, 'expected the state picker in the hero');
  assert.ok(early.compareDocumentPosition(picker) & 4, 'early CTA comes before the state picker');
  assert.equal(document.querySelector('.hub-hero .hub-trust-badges'), null, 'and the badges are gone from the hero');
});

test('clicking the early practice button scrolls to the free sample question', async (t) => {
  const { document } = await boot(t, 'https://passexamhq.com/cdl');
  await waitFor(() => document.getElementById('category-sample'));
  let scrolled = false;
  document.getElementById('category-sample').scrollIntoView = () => { scrolled = true; };
  document.querySelector('.hub-hero-cta-early button').click();
  await settle();
  assert.equal(scrolled, true);
});

test('the later "Try Free Sample" button is marked so mobile can hide the duplicate', async (t) => {
  const { document } = await boot(t, 'https://passexamhq.com/cdl');
  await waitFor(() => document.querySelector('.hub-hero-cta:not(.hub-hero-cta-early) button[data-act="scroll-to-category-sample"]'));
  const late = document.querySelector('.hub-hero-cta:not(.hub-hero-cta-early) button[data-act="scroll-to-category-sample"]');
  assert.ok(late.classList.contains('hub-hero-btn-late'));
});

test('CSS: early CTA hidden by default (desktop unchanged), shown on mobile, where the later duplicate is hidden', () => {
  assert.match(topLevelCss(), /\.hub-hero-cta-early\s*\{[^}]*display:\s*none/);
  const mobile = mobileCss();
  assert.match(mobile, /\.hub-hero-cta-early\s*\{[^}]*display:\s*flex/);
  assert.match(mobile, /\.hub-hero-btn-late\s*\{[^}]*display:\s*none/);
});

// ---- 3. Floating 💡/🐞 buttons off the first screen on mobile ----------------------------------

test('on load the page is not marked past-first-screen', async (t) => {
  const { document } = await boot(t, 'https://passexamhq.com/cdl');
  assert.equal(document.documentElement.classList.contains('past-first-screen'), false);
});

test('scrolling past half a screen marks the page past-first-screen (and it stays marked)', async (t) => {
  const { window, document } = await boot(t, 'https://passexamhq.com/cdl');
  Object.defineProperty(window, 'scrollY', { value: 100, configurable: true });
  window.dispatchEvent(new window.Event('scroll'));
  assert.equal(document.documentElement.classList.contains('past-first-screen'), false, 'a small scroll is still the first screen');
  Object.defineProperty(window, 'scrollY', { value: Math.ceil(window.innerHeight / 2) + 1, configurable: true });
  window.dispatchEvent(new window.Event('scroll'));
  assert.equal(document.documentElement.classList.contains('past-first-screen'), true);
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  window.dispatchEvent(new window.Event('scroll'));
  assert.equal(document.documentElement.classList.contains('past-first-screen'), true, 'scrolling back up does not hide them again');
});

test('an in-app navigation marks the page past-first-screen (short pages that never scroll still get the buttons)', async (t) => {
  const { window, document } = await boot(t, 'https://passexamhq.com/cdl/ca#/info');
  window.location.hash = '#/resources';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await settle();
  assert.equal(document.documentElement.classList.contains('past-first-screen'), true);
});

test('arriving from the feedback email (?feedback=1) marks the page past-first-screen', async (t) => {
  const { document } = await boot(t, 'https://passexamhq.com/?feedback=1');
  assert.equal(document.documentElement.classList.contains('past-first-screen'), true);
});

test('CSS: on mobile, 💡 and 🐞 toggles are hidden until past-first-screen; the 💬 help chat is untouched', () => {
  const mobile = mobileCss();
  const rule = mobile.match(/([^{}]*)\{\s*display:\s*none;?\s*\}/g) || [];
  const hiding = rule.filter((r) => /past-first-screen/.test(r)).join(' ');
  assert.match(hiding, /html:not\(\.past-first-screen\)\s+\.report-issue-toggle/);
  assert.match(hiding, /html:not\(\.past-first-screen\)\s+\.suggestion-toggle/);
  assert.doesNotMatch(hiding, /help-chat/);
  assert.doesNotMatch(hiding, /panel/, 'an opened panel is never hidden, only the toggle buttons');
});
