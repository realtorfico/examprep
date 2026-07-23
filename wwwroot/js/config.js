// Filled in once the Turnstile widget is created in the Cloudflare dashboard.
// (turnstileReady / onTurnstileLoad live in turnstile-callback.js, loaded earlier in
// <head> so they're defined before Turnstile's async script can possibly run.)
var TURNSTILE_SITE_KEY = '0x4AAAAAAD7hWTbs8D6sVYQJ';

// PayPal's Client ID is a public value (safe to expose client-side) — the Client Secret
// never appears here, it only lives as a Worker secret. Set once the PayPal REST API app exists.
var PAYPAL_CLIENT_ID = 'ASZ0zyEhMgS4bRLJMe7tOXNhuLw7Syk6LnePeEX_RsZzxb29OPftFbahSFbDp2cKzfhp89DDFy8Erx4Y'; // Sandbox — swap to Live client-id before real launch
