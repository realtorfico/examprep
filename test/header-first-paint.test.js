// The server-rendered HEADER has to be styled at first paint, like the hero below it.
//
// Found 2026-09-17 by running Lighthouse locally after a PageSpeed report: CLS 0.242, three runs
// out of three, one shift, and the trace named it -- #app moved from top 337px to top 108px at
// 454ms. That is the header collapsing: hero.css (the blocking sheet) carried the hero's rules and
// nothing else, so #site-header painted UNSTYLED -- nav links stacked, drawer nav visible, logo
// block-level, ~337px tall -- until style.min.css attached and cut it to 108px, shoving the whole
// page up 229px.
//
// It never showed up in the Playwright measurements because those reused the browser's warm cache,
// so style.min.css was always in place before the header existed in the DOM. The window is real on
// a cold cache over a fast connection: HTML parses, the header paints with hero.css only, and the
// deferred sheet lands a few hundred ms later. That is a first-time visitor on good mobile data.
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildHeroCss } = require('../scripts/build-hero-css');

const CSS_DIR = path.join(__dirname, '..', 'wwwroot', 'css');
const STYLE_CSS = fs.readFileSync(path.join(CSS_DIR, 'style.css'), 'utf8');
const HERO_CSS = fs.readFileSync(path.join(CSS_DIR, 'hero.css'), 'utf8');
const WORKER = fs.readFileSync(path.join(__dirname, '..', 'wwwroot', '_worker.js'), 'utf8');

test('hero.css carries the header layout, not just the hero', () => {
  // Enough of it that the header's HEIGHT is settled on the first frame: the bar itself, the two
  // nav clusters that are display:none until 900px, the mobile drawer (display:none by default --
  // unstyled it renders its whole link list), and the logo's flex layout.
  for (const selector of [
    '#site-header', '.site-shell', '.top-controls', '.control-group',
    '.site-nav', '.site-nav-cta', '.site-mobile-drawer', '.header-menu-toggle',
    '.site-logo', '.site-logo-text', '.site-logo-icon',
    '.header-util-cluster', '.font-size-pill',
  ]) {
    assert.ok(HERO_CSS.includes(selector), 'hero.css should carry ' + selector);
  }
});

test('the drawer and the desktop nav are hidden from the first frame', () => {
  // These two are the 229px: unstyled, the drawer prints a second copy of every nav link and the
  // desktop nav prints the first, one per line.
  assert.match(HERO_CSS, /\.site-nav\{[^}]*display:none/, 'the desktop nav starts hidden');
  assert.match(HERO_CSS, /\.site-mobile-drawer\{[^}]*display:none/, 'so does the drawer');
  assert.match(HERO_CSS, /@media\s*\(min-width:\s*900px\)/, 'and the breakpoint that reveals the nav comes with it');
});

test('the promo ribbon is styled at first paint too', () => {
  // It is server-rendered in the same header (see siteHeaderHtml), and its own reserved height
  // (.promo-ribbon min-height) is what keeps the /promotions swap from shifting the page.
  assert.match(WORKER, /id="promo-ribbon-wrap" class="promo-ribbon"/, 'the ribbon is part of the SSR header');
  for (const selector of ['.promo-ribbon', '.promo-banner', '.promo-banner-body', '.promo-banner-dismiss', '.promo-ribbon-fallback']) {
    assert.ok(HERO_CSS.includes(selector), 'hero.css should carry ' + selector);
  }
  assert.match(HERO_CSS, /\.promo-ribbon\{[^}]*min-height/, 'including the height reservation');
});

test('hero.css is still the committed output of the generator', () => {
  // Same freshness guard as test/landing-first-paint.test.js, repeated here because this file's
  // selectors are the reason the generator's allowlist grew.
  assert.equal(HERO_CSS.trim(), buildHeroCss(STYLE_CSS).trim(),
    'run `npm run build` -- wwwroot/css/hero.css is stale');
});
