// Applies a saved theme before the first paint. Blocking by design and kept to a couple of lines:
// the page ships data-theme="light" (the app's own default), so this only has to act when the
// visitor has chosen dark somewhere else on the site. Reads the same localStorage key app.js uses
// ('examprep_theme'), so the choice carries across pages.
//
// Its own file rather than an inline <script> for the usual reason here: _headers pins script-src
// to 'self' with no 'unsafe-inline' (see turnstile.js).
try {
  var t = localStorage.getItem('examprep_theme');
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* private mode: the light default stands */ }
