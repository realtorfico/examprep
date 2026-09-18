// Turnstile is loaded on demand, not on every page. Added 2026-09-17 after a PageSpeed run on
// /cdl: challenges.cloudflare.com/turnstile/v0/api.js was 27.3 KiB of which 23.8 KiB went unused,
// it sat in the page's critical request chain, and /cdl mounts no widget at all -- Turnstile is
// needed only by the four views that render #turnstile-container (redeem, buy, contact, refund).
//
// The load is triggered by whichever comes first: renderTurnstileWidget()/waitForTurnstileToken()
// actually needing it, or the visitor's first interaction with the page (so by the time anyone
// reaches a form, the script is already warm). A visitor who bounces off the landing page never
// downloads it.
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', 'wwwroot');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const LOADER_JS = fs.readFileSync(path.join(ROOT, 'js', 'turnstile.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const API_URL = 'challenges.cloudflare.com/turnstile/v0/api.js';

// A bare document with the loader script eval'd, the way index.html loads it.
function bootLoader() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://passexamhq.com/cdl', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  dom.window.eval(LOADER_JS);
  const injected = () => Array.from(dom.window.document.querySelectorAll('script'))
    .filter((s) => (s.src || '').includes(API_URL));
  return { dom, window: dom.window, injected };
}

test('index.html no longer ships Turnstile on every page load', () => {
  assert.ok(!INDEX_HTML.includes(API_URL), 'the api.js tag should be gone from the document head');
  assert.match(INDEX_HTML, /src="\/js\/turnstile\.js\?v=\d+"/, 'replaced by the on-demand loader');
});

test('the callback exists before anything can inject the script', () => {
  // Turnstile calls window.onTurnstileLoad the moment api.js runs; the old tag was async, which is
  // why the callback had its own non-deferred file. Same guarantee here, for a different reason:
  // nothing can inject api.js until loadTurnstile() runs, and that is defined in this same file.
  const { window } = bootLoader();
  assert.equal(typeof window.onTurnstileLoad, 'function');
  assert.equal(window.turnstileReady, false);
  window.onTurnstileLoad();
  assert.equal(window.turnstileReady, true);
});

test('nothing is requested until something asks for it', () => {
  const { injected } = bootLoader();
  assert.equal(injected().length, 0, 'a visitor who only reads the landing page downloads nothing');
});

test('loadTurnstile() injects api.js once, with the render=explicit contract intact', () => {
  const { window, injected } = bootLoader();
  window.loadTurnstile();
  window.loadTurnstile();
  const tags = injected();
  assert.equal(tags.length, 1, 'idempotent -- four views can each call it');
  assert.match(tags[0].src, /onload=onTurnstileLoad/, 'app.js waits on window.turnstileReady');
  assert.match(tags[0].src, /render=explicit/, 'renderTurnstileWidget() renders the widget itself');
  assert.equal(tags[0].async, true);
});

test('the first interaction warms it, so a form is never waiting on the download', () => {
  const { window, injected } = bootLoader();
  window.document.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(injected().length, 1, 'a tap anywhere starts the download');
});

test('a keyboard visitor warms it too', () => {
  const { window, injected } = bootLoader();
  window.document.dispatchEvent(new window.Event('keydown', { bubbles: true }));
  assert.equal(injected().length, 1);
});

test('both of app.js\'s Turnstile entry points ask for the script first', () => {
  // These are the two functions that block on window.turnstileReady. If either can be reached
  // without the script having been requested, it polls for ten seconds and then fails closed --
  // on the buy page that is "Could not load payment options".
  for (const fn of ['function renderTurnstileWidget', 'function waitForTurnstileToken']) {
    const start = APP_JS.indexOf(fn);
    assert.ok(start > 0, 'missing ' + fn);
    const body = APP_JS.slice(start, start + 900);
    assert.match(body, /loadTurnstile\(\)/, fn + ' must request the script before waiting on it');
  }
});
