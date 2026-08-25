// Boots the real wwwroot/js/*.js files (config.js, api.js, speech.js, app.js -- same load order
// as index.html) inside a fresh jsdom window, so tests exercise the actual site code -- including
// its DOM-wiring event handlers -- rather than a reimplementation of it. One instance per test:
// app.js keeps its router/page state (hubScopedState, categoryPageState, etc.) in top-level `var`s
// shared across the whole session, so reusing a window across tests would leak state between them
// the same way two tabs never do.
//
// Network calls are stubbed (see makeFetchStub below) -- this machine can't run wrangler/workerd
// locally anyway (see root CLAUDE.md), and these tests are about the client-side render/wiring
// logic, not the API's real responses.

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const JS_DIR = path.join(__dirname, '..', 'wwwroot', 'js');
const SCRIPT_FILES = ['config.js', 'api.js', 'speech.js', 'app.js'];

const SHELL_HTML = `<!doctype html><html><head></head><body>
<div id="site-header"></div>
<div id="app"></div>
<div id="site-footer"></div>
<div id="help-chat-root"></div>
</body></html>`;

// Any apiFetch()/fetch() call not covered by an override gets this -- an empty-but-ok response.
// Every caller in app.js treats a missing/empty field as "nothing to show yet" (best-effort
// patterns throughout), so this is a safe default rather than a rejection that would need every
// incidental fetch (pricing tiles, question counts, etc.) individually stubbed just to avoid noise.
function makeFetchStub(overrides) {
  overrides = overrides || [];
  return async function fetchStub(url) {
    var href = typeof url === 'string' ? url : String(url);
    for (var i = 0; i < overrides.length; i++) {
      var matcher = overrides[i][0];
      var responder = overrides[i][1];
      var matches = typeof matcher === 'string' ? href.indexOf(matcher) !== -1 : matcher.test(href);
      if (matches) {
        var body = typeof responder === 'function' ? responder(href) : responder;
        return { ok: true, status: 200, json: async function () { return body; } };
      }
    }
    return { ok: true, status: 200, json: async function () { return {}; } };
  };
}

// url: full page URL to boot at (e.g. 'https://passexamhq.com/notary').
// cookie: initial document.cookie string (e.g. 'pxq_state=TX'), simulating a cookie carried over
// from an earlier "session" (a separate boot-app() call) the way a real hard navigation would.
// fetchOverrides: array of [matcher, responseBody-or-fn] pairs, checked in order -- see
// makeFetchStub above.
async function bootApp({ url, cookie, fetchOverrides }) {
  const dom = new JSDOM(SHELL_HTML, { url: url, runScripts: 'dangerously', pretendToBeVisual: true });
  const window = dom.window;
  // path=/ must match exactly what setStateCookie() itself always writes -- a cookie set with a
  // different (or default) path is a DIFFERENT cookie to a real browser (and to jsdom, correctly),
  // so an unqualified seed here would coexist alongside one the app writes later instead of being
  // read back as the same key.
  if (cookie) window.document.cookie = cookie + '; path=/';
  window.fetch = makeFetchStub(fetchOverrides);
  window.navigator.sendBeacon = function () { return true; };

  for (const file of SCRIPT_FILES) {
    const src = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
    window.eval(src);
  }

  // boot()'s meaningful work (header/footer/route()) runs inside a .then() chained off
  // Promise.all([loadSiteConfig(), loadAccountExamType()]) -- both resolve on a microtask via the
  // fetch stub above, but renderCategoryPage() itself awaits another fetch on top of that, so wait
  // for a page-specific marker rather than guessing a fixed number of ticks.
  // Several pages (renderCategoryPage, renderTrackApp) synchronously paint a "Loading…" placeholder
  // before their own awaited fetch resolves -- don't treat that placeholder itself as "rendered",
  // or a slow-to-settle stub could let a test read the page mid-loading-state.
  await waitFor(() => {
    var text = window.document.getElementById('app').textContent.trim();
    return text.length > 0 && text !== 'Loading…';
  });
  // The main render is up once the marker above is true, but a couple of fire-and-forget follow-up
  // fetches (e.g. loadCategorySampleQuestion) are still in flight -- let them settle so a test's
  // dom.window.close() cleanup doesn't run out from under one mid-flight (jsdom throws once the
  // window is closed and a pending .then() tries to touch its document).
  await settle();

  return { dom, window, document: window.document };
}

// Flushes a couple of microtask/macrotask turns -- enough for a fetch-stub promise chain
// (resolve -> .then(json) -> .then(handler)) to fully drain.
async function settle() {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, { timeout = 2000, interval = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: condition never became true within ' + timeout + 'ms');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

module.exports = { bootApp, waitFor, settle };
