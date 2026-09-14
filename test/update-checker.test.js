// Regression test for the update-available banner's version compare (wwwroot/js/app.js,
// currentAppJsVersion()/checkForUpdate()) matching production's actual script tag.
//
// index.html serves the app bundle as /js/app.min.js?v=N (see scripts/build-minified-js.js), but
// currentAppJsVersion()'s selector and checkForUpdate()'s regex both only matched literal
// "/js/app.js" -- so `document.querySelector('script[src*="/js/app.js"]')` never found the real
// <script src="/js/app.min.js?...">  element (".min.js" isn't a match for a "/js/app.js" substring
// search) and the fetched-index-page regex never matched it either. Both always returned null,
// so checkForUpdate()'s `if (!latest || !current || latest === current) return;` guard always hit
// the `!latest` branch and the banner could never appear, no matter how stale the open tab's JS
// actually was.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../test-support/boot-app');

// boot-app's SHELL_HTML has no <script src> tags (it evals the real JS files directly instead of
// loading them via a real script tag) -- append one here to simulate what index.html actually
// serves, the same way a real page load would give currentAppJsVersion() something to read.
function addAppScriptTag(document, version) {
  var s = document.createElement('script');
  s.src = '/js/app.min.js?v=' + version;
  document.head.appendChild(s);
}

test('currentAppJsVersion() reads the version off the real minified script tag', async (t) => {
  const { dom, window, document } = await bootApp({ url: 'https://passexamhq.com/' });
  t.after(() => dom.window.close());
  addAppScriptTag(document, '5');
  assert.equal(window.currentAppJsVersion(), '5');
});

test('checkForUpdate() shows the banner when the fetched page has a newer app.min.js version', async (t) => {
  const { dom, window, document } = await bootApp({
    url: 'https://passexamhq.com/',
    // A plain '/' string matcher would indexOf-match every fetch call the boot sequence makes
    // (track-registry, prefs, etc. all contain "/"), not just checkForUpdate()'s own fetch('/') --
    // an exact-match regex targets only that one call.
    fetchOverrides: [
      [/^\/$/, '<script defer src="/js/app.min.js?v=6"></script>'],
    ],
  });
  t.after(() => dom.window.close());
  addAppScriptTag(document, '5');

  window.checkForUpdate();
  await settle();

  assert.ok(document.getElementById('update-available-banner'), 'banner should appear once a newer version is detected');
});

test('checkForUpdate() does not show the banner when the fetched page reports the same version', async (t) => {
  const { dom, window, document } = await bootApp({
    url: 'https://passexamhq.com/',
    fetchOverrides: [
      [/^\/$/, '<script defer src="/js/app.min.js?v=5"></script>'],
    ],
  });
  t.after(() => dom.window.close());
  addAppScriptTag(document, '5');

  window.checkForUpdate();
  await settle();

  assert.equal(document.getElementById('update-available-banner'), null, 'banner should not appear when already up to date');
});
