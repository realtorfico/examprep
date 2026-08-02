// Filled in once the Turnstile widget is created in the Cloudflare dashboard.
// (turnstileReady / onTurnstileLoad live in turnstile-callback.js, loaded earlier in
// <head> so they're defined before Turnstile's async script can possibly run.)
var TURNSTILE_SITE_KEY = '0x4AAAAAAD7hWTbs8D6sVYQJ';

// PayPal's Client ID is a public value (safe to expose client-side) — the Client Secret
// never appears here, it only lives as a Worker secret. Set once the PayPal REST API app exists.
var PAYPAL_CLIENT_ID = 'AeKlF0rU8KItLkZ4I_uJ2o9b1PoG8RMj2UfLtCJv3CXP9XEncIyfoxPufVCIC_UaM64YlcTDQaG5sl8Y'; // Live

// Stripe's Publishable Key is likewise a public value — the Secret Key only lives as a Worker
// secret (STRIPE_SECRET_KEY). Currently a TEST-mode key (pk_test_...) -- swap for the live key
// once we've run a real test purchase through, same swap PAYPAL_CLIENT_ID went through earlier.
var STRIPE_PUBLISHABLE_KEY = 'pk_test_51U03ZM45NpA0y4sWKgOUfwTIMUQB6YRVOrEWoZ3lCmLksscNtBOlnWWlw9zOXlBh7WQ7EzcNzpmt2bH4w6dOSccz00vDCkPbIb';
