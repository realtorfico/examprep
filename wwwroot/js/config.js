// Filled in once the Turnstile widget is created in the Cloudflare dashboard.
// (turnstileReady / onTurnstileLoad live in turnstile-callback.js, loaded earlier in
// <head> so they're defined before Turnstile's async script can possibly run.)
var TURNSTILE_SITE_KEY = '0x4AAAAAAD7hWTbs8D6sVYQJ';

// PayPal's Client ID is a public value (safe to expose client-side) — the Client Secret
// never appears here, it only lives as a Worker secret. Set once the PayPal REST API app exists.
var PAYPAL_CLIENT_ID = 'AeKlF0rU8KItLkZ4I_uJ2o9b1PoG8RMj2UfLtCJv3CXP9XEncIyfoxPufVCIC_UaM64YlcTDQaG5sl8Y'; // Live

// Stripe's Publishable Key is likewise a public value — the Secret Key only lives as a Worker
// secret (STRIPE_SECRET_KEY). Replace once a Stripe account/key exists; renderBuy() shows a
// "not configured yet" message while this placeholder is in place, mirroring PAYPAL_CLIENT_ID.
var STRIPE_PUBLISHABLE_KEY = 'REPLACE_WITH_STRIPE_PUBLISHABLE_KEY';
