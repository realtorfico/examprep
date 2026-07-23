// Must load and execute BEFORE the Turnstile <script> tag (see index.html) — Turnstile's
// script has async, so it can run before any of our other scripts. This file is a plain,
// non-async, non-deferred tag placed earlier in <head>, guaranteeing the callback exists
// by the time Turnstile's script checks for it, however early that happens.
window.turnstileReady = false;
window.onTurnstileLoad = function () { window.turnstileReady = true; };
