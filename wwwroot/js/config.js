// Filled in once the Turnstile widget is created in the Cloudflare dashboard.
var TURNSTILE_SITE_KEY = '0x4AAAAAAD7hWTbs8D6sVYQJ';

// Turnstile's script tag loads async; it calls this once truly ready (see index.html's
// script src ?onload= param). Kept in an external file, not an inline <script>, since our
// CSP has no 'unsafe-inline' for script-src.
window.turnstileReady = false;
window.onTurnstileLoad = function () { window.turnstileReady = true; };
