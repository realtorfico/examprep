// Loads Cloudflare Turnstile on demand instead of on every page.
//
// This file replaces js/turnstile-callback.js plus the eager
// <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"> tag that used to sit in
// index.html's head. A 2026-09-17 PageSpeed run on /cdl reported api.js at 27.3 KiB with 23.8 KiB
// unused and listed it in the page's critical request chain -- on a landing page that mounts no
// widget at all. Only four views render #turnstile-container: redeem, buy, contact and refund.
//
// window.onTurnstileLoad is defined here, before anything can inject api.js, so the
// "onload=onTurnstileLoad" contract in the script URL still holds however early the script runs.
// app.js's renderTurnstileWidget() and waitForTurnstileToken() both poll window.turnstileReady,
// and both call loadTurnstile() first -- asserted in test/turnstile-lazy-load.test.js, because
// reaching either one without the script requested means ten seconds of polling and then a
// closed-fail ("Could not load payment options" on the buy page).
(function () {
  var API_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit';

  window.turnstileReady = false;
  window.onTurnstileLoad = function () { window.turnstileReady = true; };

  var requested = false;
  window.loadTurnstile = function () {
    if (requested) return;
    requested = true;
    var s = document.createElement('script');
    s.src = API_SRC;
    s.async = true;
    s.defer = true;
    (document.head || document.documentElement).appendChild(s);
  };

  // Warm it on the visitor's first interaction, so someone who goes on to a form isn't waiting for
  // a cold 27 KiB download at the moment they need the widget -- while a visitor who reads the
  // landing page and leaves never downloads it. Capture phase and { once: true }: these fire
  // before any app.js handler, and loadTurnstile() is idempotent so overlapping events are free.
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (evt) {
    document.addEventListener(evt, window.loadTurnstile, { capture: true, once: true, passive: true });
  });
})();
