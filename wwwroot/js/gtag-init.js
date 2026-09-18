// Google Ads tag init. Kept in its own same-origin file rather than an inline <script> block in
// index.html, so the site's CSP never needs 'unsafe-inline' -- same reasoning as turnstile.js. The
// gtag.js library itself is loaded via a separate <script src="https://www.googletagmanager.com/gtag/js?id=...">
// in index.html, whose id must match the config below.
// AW-18460635935 since 2026-09-18 (a new Google Ads account). It replaced AW-1046929025, the account
// used since 2026-09-08. Purchase conversions: see GOOGLE_ADS_PURCHASE_SEND_TO in app.js.
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', 'AW-18460635935');
