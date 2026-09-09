// Google Ads conversion tracking init (AW-1046929025, added 2026-09-08). Kept in its own
// same-origin file rather than an inline <script> block in index.html, so the site's CSP never
// needs 'unsafe-inline' -- same reasoning as turnstile-callback.js. The gtag.js library itself is
// loaded via a separate <script src="https://www.googletagmanager.com/gtag/js?id=...">.
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', 'AW-1046929025');
