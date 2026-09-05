// Vanilla JS, no framework/bundler. Hash-routed within a track's path (e.g. /notary); pathname-routed
// at the top level, matched against HUB_EXAMS's active tracks (see activeTrackForPath).
var appEl = document.getElementById('app');
// examType starts empty, NOT a real track -- it's only ever set once the visitor actually lands on
// a specific track's page (route()'s activeTrackForPath branch) or logs in/redeems (accountExamType
// takes over at that point). A hardcoded default here (this used to be 'ca_notary') meant every
// logged-out visitor who'd only ever seen the hub/state-scoped pages silently "had" California
// Notary as their current track -- currentTrackOrNull() falls back to this when logged out, so the
// footer's Refer/Sample links and the header nav's Refer link all hard-linked to CA Notary
// regardless of which state's hub the visitor was actually browsing.
var state = { question: null, answered: null, examType: '', quizDifficulty: localStorage.getItem('examprep_quiz_difficulty') || '' };
// Which track the current token actually grants access to -- distinct from state.examType, which
// tracks whatever route is currently being VIEWED. Without this, an account bound to one track
// (e.g. ca_notary) navigating to a different track's route (e.g. /ca_driver) would pass the naive
// "is there any token" check and render that other track's authenticated quiz/exam/progress UI --
// the server would correctly still only ever serve the account's own real questions (auth is
// token-scoped server-side), but the page chrome (track name, tab state) would show the WRONG
// track, confusingly. null = not yet loaded, or not logged in.
var accountExamType = null;
function loadAccountExamType() {
  if (!getToken()) { accountExamType = null; return Promise.resolve(null); }
  return apiFetch('/prefs').then(function (p) { accountExamType = p.examType; return accountExamType; })
    .catch(function () { return accountExamType; }); // best-effort -- a failed fetch shouldn't block boot
}
// True only when logged in AND that login is for the track currently being viewed.
function isLoggedInForCurrentTrack() { return !!getToken() && accountExamType === state.examType; }
var QUIZ_DIFFICULTIES = [['', 'All'], ['easy', 'Easy'], ['moderate', 'Moderate'], ['hard', 'Hard'], ['extremely_hard', 'Extremely Hard']];
// Off by default -- matches pre-existing behavior unless the user opts in. Persisted like the
// difficulty filter. quizRenderToken invalidates any pending auto-advance timer as soon as a new
// question loads through ANY path (manual Next click, tab re-entry, difficulty change, ...), so
// a stale timer can never yank the user forward into a question they didn't mean to skip to.
var quizAutoAdvance = localStorage.getItem('examprep_quiz_autoadvance') === '1';
var quizAutoRead = localStorage.getItem('examprep_quiz_autoread') === '1';
var quizRenderToken = 0;
var QUIZ_AUTO_ADVANCE_DELAY_MS = 700; // long enough to register "Correct!" before moving on
// Exam mode never reveals correct/incorrect, so this one's simpler: advance regardless of the
// answer, right after the /exam/answer save completes -- no artificial delay needed, the
// network round-trip already gives a brief natural pause before the screen changes.
var examAutoAdvance = localStorage.getItem('examprep_exam_autoadvance') === '1';
var examAutoRead = localStorage.getItem('examprep_exam_autoread') === '1';
var examUnseenOnly = localStorage.getItem('examprep_exam_unseenonly') === '1'; // regular exam only -- biases question selection toward questions never seen in quiz or exam before
// ca_driver only -- per-sitting override of the account's stored age-category default (real DMV
// format differs by age; see getExamConfig). '' means "use my account default". Deliberately not
// persisted to localStorage like the toggles above -- a one-off choice for this sitting, not a
// standing preference.
var examAgeCategoryOverride = '';
var examNavExpanded = false; // collapsed by default -- 45 nav boxes eat too much vertical space on mobile
var examSubmitConfirmPending = false; // in-page (non-native) "N unanswered, submit anyway?" confirmation
var examDiscardConfirmPending = false; // in-page confirmation for "discard this attempt and start over?"
var sampleState = { questions: null, index: 0, selected: null, answered: null, examType: null };
var recognition = null;
var isRecording = false;

// Donut/ring progress indicator (ported from v0Design's RadialProgress). Dasharray/offset and
// width/height go on as real SVG attributes, not inline style -- CSP (style-src 'self') blocks
// style="" and style.setProperty(), but plain SVG presentation attributes are unaffected.
function radialProgressSvg(value, opts) {
  opts = opts || {};
  var size = opts.size || 132;
  var strokeWidth = opts.strokeWidth || 12;
  var color = opts.color || 'var(--accent)';
  var v = Math.min(100, Math.max(0, value || 0));
  var radius = (size - strokeWidth) / 2;
  var circumference = 2 * Math.PI * radius;
  var offset = circumference - (v / 100) * circumference;
  var c = size / 2;
  return '<div class="radial-progress-wrap">' +
    '<svg width="' + size + '" height="' + size + '" class="radial-progress-svg">' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + radius + '" fill="none" stroke="var(--border)" stroke-width="' + strokeWidth + '"></circle>' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + radius + '" fill="none" stroke="' + color + '" stroke-width="' + strokeWidth + '" stroke-linecap="round" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + offset + '"></circle>' +
    '</svg>' +
    '<div class="radial-progress-label">' +
    '<span class="radial-progress-value">' + Math.round(v) + '%</span>' +
    (opts.label ? '<span class="radial-progress-caption">' + escapeHtml(opts.label) + '</span>' : '') +
    (opts.sublabel ? '<span class="radial-progress-sublabel">' + escapeHtml(opts.sublabel) + '</span>' : '') +
    '</div></div>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Called after a new question is loaded (quiz's Next/auto-advance, exam's prev/next/jump/auto-
// advance) so the question text lands at the top of the viewport instead of leaving the user
// wherever they'd scrolled to on the previous question (e.g. partway down a long explanation).
function scrollToQuestion() {
  var el = document.querySelector('.question-text');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Shared markup for every A/B/C/D choice button (quiz, sample, exam sitting, exam review) --
// a letter badge on the left plus the choice text, so all four call sites stay visually
// consistent instead of each hand-rolling "A) text".
function optionButtonHtml(letter, text, cls, attrs) {
  // Correct/wrong get an explicit check/X icon too -- color alone (the border/badge tint)
  // shouldn't be the only signal of state.
  var icon = / correct(\s|$)/.test(' ' + cls + ' ') ? '<span class="option-state-icon">✓</span>'
    : / wrong(\s|$)/.test(' ' + cls + ' ') ? '<span class="option-state-icon">✕</span>' : '';
  return '<button class="' + cls + '" ' + (attrs || '') + '>' +
    '<span class="option-letter">' + letter + '</span><span class="option-text">' + text + '</span>' + icon + '</button>';
}

// CSP (style-src 'self', no unsafe-inline) blocks inline styles set via JS too, not just
// style="..." attributes -- so --font-scale can't be set with style.setProperty(). fontScale is
// bounded [0.85, 1.4] in 0.05 steps (12 values, see font-up/down below), so a small fixed set of
// font-scale-NN classes (see style.css) covers it instead.
// Site's actual resolved light/dark, accounting for the explicit toggle (data-theme) falling
// back to the OS preference when the user's on "system". Used to tell Turnstile which chrome to
// render -- it defaults to 'auto' (OS preference only), which can mismatch the site's own theme
// and render as a stark white/black box against the opposite-themed card (doc audit's Cloudflare
// widget complaint).
function resolvedColorScheme() {
  var attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}

function applyTheme(theme, fontScale) {
  var root = document.documentElement;
  if (theme && theme !== 'system') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  if (fontScale) {
    root.className = root.className.replace(/\bfont-scale-\d+\b/g, '').trim();
    root.classList.add('font-scale-' + Math.round(fontScale * 100));
  }
}

function loadLocalPrefs() {
  return {
    theme: localStorage.getItem('examprep_theme') || 'light',
    fontScale: parseFloat(localStorage.getItem('examprep_font') || '1'),
  };
}

// Shared referral-link attribution: a visitor arriving via someone's ?ref=<accountId> share link
// (see the refer page's Share button) gets that id remembered so it can ride along on a LATER
// purchase, even if they browse several pages first -- see detectAndCreditConversion() on the API
// side for how it's actually used (a fallback credit path, only fires if no email-invite referral
// already matches, and only ever on a real completed purchase).
function captureRefCodeFromUrl() {
  try {
    var params = new URLSearchParams(location.search);
    var ref = params.get('ref');
    if (ref) localStorage.setItem('examprep_ref_code', ref);
  } catch (e) { /* localStorage unavailable (private mode etc) -- just skip attribution */ }
}
function getStoredRefCode() {
  try { return localStorage.getItem('examprep_ref_code') || undefined; } catch (e) { return undefined; }
}
captureRefCodeFromUrl();

// Business affiliate-partner attribution (?aff=<partnerId>, e.g. a pre-licensing course
// provider's link) -- a SEPARATE code namespace from ?ref= above (see examprep-api's
// creditAffiliateConversion/affiliate_partners schema comment for why), same capture-on-arrival,
// ride-along-until-purchase pattern.
function captureAffCodeFromUrl() {
  try {
    var params = new URLSearchParams(location.search);
    var aff = params.get('aff');
    if (aff) localStorage.setItem('examprep_aff_code', aff);
  } catch (e) { /* localStorage unavailable (private mode etc) -- just skip attribution */ }
}
function getStoredAffCode() {
  try { return localStorage.getItem('examprep_aff_code') || undefined; } catch (e) { return undefined; }
}
captureAffCodeFromUrl();
function saveLocalPrefs(theme, fontScale) {
  localStorage.setItem('examprep_theme', theme);
  localStorage.setItem('examprep_font', String(fontScale));
}

// ---- Site-wide chrome: header + footer, rendered once — NOT part of any page's
// content, so theme/font controls and page navigation live above the content card
// and stay put across every route change. ----------------------------------

// Navy square + gold checkmark -- the mark itself carries the brand pairing, so it
// needs no CSS background/color, just sizing on its wrapper (see .site-logo-icon).
var LOGO_SVG = '<svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden="true">' +
  '<rect width="32" height="32" rx="7" fill="var(--accent)"></rect>' +
  '<path d="M9 16.8 13.4 21 23 11" stroke="var(--highlight)" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"></path>' +
  '</svg>';

function renderSiteHeader() {
  var loggedIn = !!getToken();
  var logo = '<span class="site-logo">' +
    '<span class="site-logo-icon">' + LOGO_SVG + '</span>' +
    // Always the true site root, not a context-aware "current category" href -- a logo is a
    // universal "go home" convention, unlike tracksHomeHref() (used for "browse tracks"-style
    // CTAs elsewhere), which staying category-aware is genuinely useful for.
    '<span class="site-logo-text"><a href="/" class="site-logo-word">PassExam<span class="site-logo-accent">HQ</span></a>' +
    '<span class="site-logo-tagline">Pass Exam - Or Your Money Back</span></span>' +
    '</span>';

  // Marketing nav + CTAs (ported from v0's site-header.tsx) -- inline on desktop, folded into a
  // mobile drawer below the row on narrow screens. Kept separate from the existing font/theme/
  // profile controls (unchanged, still always visible) rather than merged into one cluster, so
  // adding these doesn't touch anything already working.
  // Refer is track-specific (points/pricing depend on which course you're unlocking) -- deep-links
  // into the account's real track or whichever track's page is currently being viewed (see
  // referTrackOrNull()'s own comment on why not the sticky currentTrackOrNull()), otherwise sends
  // to the tracks picker rather than guessing. Redeem needs no track at all (global route, see
  // route()) -- the code you submit determines the track server-side, so this link never has to
  // pick one.
  var pageTrack = activeTrackForPath(window.location.pathname);
  var referTrack = referTrackOrNull(pageTrack);
  var referHref = referTrack ? (referTrack.route + '#/refer') : tracksHomeHref();
  // "Exam tracks" (nav) and "Guarantee" (nav) dropped as redundant: "Browse exams" (CTA below)
  // already covers the tracks link, and the guarantee page is still reachable via the promo
  // ribbon's "Pass or X% of Your Money Back" link -- no need for three links to the same place.
  // "Guides & Tips" (added 2026-09-02) isn't redundant with anything else here -- unlike those two,
  // it was previously reachable ONLY via the footer -- so it's additive, not a replacement. Folds
  // into the same mobile drawer as the other two below the breakpoint, same as they already do.
  var navLinksHtml =
    '<a href="' + referHref + '">Refer &amp; earn</a>' +
    '<a href="#/gift">Gift a track 🎁</a>' +
    '<a href="/blog">Guides &amp; Tips</a>';
  // "Browse exams" is a global "see the whole catalog" CTA, so it always targets the homepage's
  // category grid -- unlike referHref above (deliberately track-scoped), it must NOT use
  // tracksHomeHref(), which resolves to the CURRENT category's own page whenever a track is
  // active (true on every track/quiz/exam/buy page), making this button just re-link back to
  // wherever the visitor already was instead of the actual catalog.
  var navCtaHtml = '<a class="btn-secondary btn-sm" href="#/redeem">Redeem code</a>' +
    '<a class="btn-primary btn-sm" href="/#tracks">Browse exams</a>';
  // Prominent, always-visible "which track am I logged into" indicator -- accountExamType
  // specifically (the account's real track), NOT pageTrack above (whichever track's PAGE is
  // being viewed, which could differ, e.g. a driver-track account browsing the notary track's
  // sales page to compare). Was the missing piece behind the "why does this say California Notary"
  // confusion earlier -- surfacing it in the header means a logged-in visitor never has to guess.
  var accountTrack = loggedIn ? trackByExamType(accountExamType) : null;
  var accountTrackBadge = accountTrack
    ? '<a class="header-track-badge" href="' + accountTrack.route + '" title="Your active track">' +
      '<span class="header-track-badge-icon">🎓</span><span class="header-track-badge-label">' + escapeHtml(accountTrack.shortName || accountTrack.title) + '</span></a>'
    : '';

  // State picker lives inside .site-nav (folds into the ☰ drawer below the breakpoint, same as the
  // nav links/CTAs) rather than the always-visible util cluster -- it was the single widest element
  // in that cluster and the main cause of the header wrapping badly on phones and on a narrowed
  // desktop window (see user report 2026-08-19). The util cluster now only ever holds font/theme,
  // small enough to never wrap on its own.
  document.getElementById('site-header').innerHTML =
    '<div class="site-shell top-controls">' +
    logo +
    '<nav class="site-nav" aria-label="Primary">' + navLinksHtml + '</nav>' +
    '<div class="control-group">' +
    // Utility controls (font/theme) merged into one segmented pill cluster -- doc audit's "Unified
    // Controls" ask -- rather than two separately-bordered pills sitting loose in the row. Branded
    // CTAs/track badge/profile stay outside it, unchanged, since those aren't the "adjuster"
    // controls the audit meant.
    '<div class="header-util-cluster">' +
    '<div class="font-size-pill" role="group" aria-label="Font size">' +
    '<button data-act="font-down">A-</button>' +
    '<button data-act="font-up">A+</button>' +
    '</div>' +
    '<button class="btn-secondary btn-sm" id="theme-toggle-btn" data-act="toggle-theme"></button>' +
    '</div>' +
    '<div class="site-nav-cta">' + navCtaHtml + '</div>' +
    accountTrackBadge +
    '<button class="header-menu-toggle" type="button" data-act="toggle-header-menu" aria-label="Open menu" aria-expanded="false">☰</button>' +
    (loggedIn ? renderProfileMenu() : '') +
    '</div>' +
    '<div class="site-mobile-drawer" id="site-mobile-drawer">' +
    '<nav aria-label="Mobile">' + navLinksHtml + '</nav>' +
    '<div class="site-mobile-drawer-cta">' + navCtaHtml + '</div>' +
    '</div>' +
    '</div>' +
    '<div id="promo-ribbon-wrap" class="promo-ribbon"></div>';
  updateThemeButton();
  fillPromoRibbon();
}

// "Browse tracks"-style CTAs land on the current track's CATEGORY page (not a per-state hub --
// that no longer exists under category-first routing) when there is a current track
// (currentTrackOrNull() -- the logged-in account's track, the page just viewed, or the last one
// viewed this browser), else on the site root. Every "browse tracks" link should route through
// this instead of a literal "/#tracks", so a visitor browsing one category doesn't get bounced to
// the unscoped all-categories page just by clicking it. NOT used for the site logo, which is
// always a plain "/" -- see renderSiteHeader().
function tracksHomeHref() {
  var t = currentTrackOrNull();
  return t ? '/' + kindSlug(t.examKind) + '#tracks' : '/#tracks';
}

// The track "Refer & earn" should point into: the logged-in account's real track (referring for
// what you actually have makes sense), else whichever track's page is CURRENTLY being viewed
// (pageTrack, from activeTrackForPath(location.pathname) -- each caller computes this from its own
// current pathname). Deliberately does NOT fall through to currentTrackOrNull()'s third case --
// "last viewed this browser," possibly in a past session (lastViewedTrackExamType()) -- the same
// staleness trap tracksHomeHref() has for its own callers (see the header's "Browse exams"/footer's
// "All exam tracks" comments): referring shouldn't silently lock onto a track from a past session
// just because it was glanced at once. Falls back to null (caller sends to tracksHomeHref() instead,
// i.e. "go pick a track first") when neither a real account track nor a current page track exists.
function referTrackOrNull(pageTrack) {
  if (getToken() && accountExamType) return trackByExamType(accountExamType);
  return pageTrack || null;
}

function closeHeaderMenuIfOpen() {
  var drawerEl = document.getElementById('site-mobile-drawer');
  if (drawerEl) drawerEl.classList.remove('open');
  var toggleBtn = document.querySelector('.header-menu-toggle');
  if (toggleBtn) { toggleBtn.setAttribute('aria-expanded', 'false'); toggleBtn.textContent = '☰'; }
}

// Site-wide, site-header-hosted promo ribbon (Round 2 design decision) -- fills in async since it
// needs a /promotions fetch, same progressive-enhancement pattern as the hub's own promo wrap.
// renderSiteHeader() only runs a handful of times per session (boot, login/logout, theme toggle),
// not per route change, so this fetch is cheap.
function fillPromoRibbon() {
  var wrap = document.getElementById('promo-ribbon-wrap');
  if (!wrap) return;
  Promise.all([apiFetch('/promotions?placement=home'), loadSiteConfig()]).then(function (results) {
    var r = results[0];
    var dismissedIds = getDismissedPromoIds();
    var active = (r.promotions || []).filter(function (p) { return dismissedIds.indexOf(p.id) === -1; });
    wrap.innerHTML = active.length
      ? promoBannersHtml([active[0]], true, false)
      : promoRibbonFallbackHtml();
  }).catch(function () {
    // Fails open to the static tagline (using whatever refundFailurePercent default is already in
    // memory) rather than leaving the ribbon blank -- a /promotions hiccup shouldn't cost the
    // header its one always-available message.
    wrap.innerHTML = promoRibbonFallbackHtml();
  });
}
function promoRibbonFallbackHtml() {
  return '<a class="promo-ribbon-fallback" href="#/guarantee">🎯 <strong>Pass or ' + refundFailurePercent +
    '% of Your Money Back</strong> — see our guarantee →</a>';
}

function updateThemeButton() {
  var local = loadLocalPrefs();
  var nextTheme = local.theme === 'light' ? 'dark' : 'light';
  var btn = document.getElementById('theme-toggle-btn');
  if (!btn) return;
  // Label shows what clicking WILL switch to (the destination), not the current theme. The word
  // itself is hidden on narrow screens via CSS to save header space -- the icon alone still works.
  var icon = nextTheme === 'dark' ? '🌙' : '☀️';
  var label = nextTheme === 'dark' ? 'Dark' : 'Light';
  btn.innerHTML = icon + ' <span class="theme-toggle-label">' + label + '</span>';
  btn.setAttribute('data-next', nextTheme);
  btn.setAttribute('aria-label', 'Switch to ' + label + ' mode');
}

var SITE_YEAR = 2026; // static — Date.now() isn't reliably available in this build pipeline

// Admin-configurable (examprep-admin's Settings tab, key: refund_failure_percent) -- 50 is just
// the pre-fetch default shown until /config resolves, same "progressive enhancement" pattern as
// the promo banners below (comment near renderNewsBanner). Cached as a single shared promise so
// every render spot that needs it (footer, buy, refund pages) triggers only one network request.
// Also seeds progressAccuracyPassPct/progressCoveragePassPct (declared further down, alongside
// the Progress tab) so logged-out pages like Buy can quote them too -- the Progress tab's own
// /progress fetch still re-syncs them for a logged-in user, this is just the pre-login source.
var refundFailurePercent = 50;
var siteConfigPromise = null;
function loadSiteConfig() {
  if (!siteConfigPromise) {
    siteConfigPromise = apiFetch('/config').then(function (c) {
      if (c && Number.isFinite(c.refundFailurePercent)) refundFailurePercent = c.refundFailurePercent;
      if (c && Number.isFinite(c.accuracyPassPct)) progressAccuracyPassPct = c.accuracyPassPct;
      if (c && Number.isFinite(c.coveragePassPct)) progressCoveragePassPct = c.coveragePassPct;
      return c;
    }).catch(function () { /* keep defaults */ });
  }
  return siteConfigPromise;
}

// Shared cached fetch -- the hub's readiness card and outcomes strip both need /stats/public on
// the same page load; this avoids firing it twice. Not persisted across page loads (a fresh
// renderHub() gets a fresh var), just within one.
var publicStatsPromise = null;
function loadPublicStats() {
  if (!publicStatsPromise) publicStatsPromise = apiFetch('/stats/public');
  return publicStatsPromise;
}

// On a specific track's page, the footer's affiliation disclaimer names that track's real
// agency/requirement (accurate and precise). On the hub itself (no track in the URL path) there's
// no single track to name -- falling back to trackCompliance's default (ca_notary) would wrongly
// imply the site's only affiliation-relevant agencies are California's, when 14 tracks across 4
// states now exist. Use a deliberately agency-name-free disclaimer there instead, broad enough to
// cover every current and future track without needing an update each time one's added.
var HUB_FOOTER_ORG_LINE = 'any state department of motor vehicles, state licensing agency, official examination vendor,';
var HUB_FOOTER_REQUIREMENT = 'do not fulfill any state-mandated licensing, driver education, or training requirement';

// Four-column footer (ported from v0's site-footer.tsx, regrouped 2026-09-02 by user intent --
// browse / manage my purchase / get help / company info -- rather than the old grab-bag "Product"/
// "Legal" columns that mixed unrelated link types under mislabeled headers). The Refer link uses
// referTrackOrNull() (account's real track, or whichever track's page is currently being viewed --
// deliberately NOT the sticky "last viewed this browser" case, see its own comment), falling back
// to the tracks picker (never a specific, possibly-stale track) when there isn't one.
function renderSiteFooter() {
  var pageTrack = activeTrackForPath(window.location.pathname);
  // The footer is on every page, so it must never BLOCK on this track's disclaimer copy. It renders
  // with the generic (accurate, agency-name-free) hub wording until the track's own arrives, then
  // re-renders once -- which is the same thing it already did during boot, where it paints before
  // HUB_EXAMS/accountExamType resolve and is re-rendered after.
  if (pageTrack && !TRACK_CONTENT[pageTrack.examType]) {
    loadTrackContent(pageTrack.examType).then(function (content) {
      if (content) renderSiteFooter();
    });
  }
  var orgLine = pageTrack ? trackCompliance(pageTrack.examType).orgLine : HUB_FOOTER_ORG_LINE;
  var requirement = pageTrack ? trackCompliance(pageTrack.examType).footerRequirement : HUB_FOOTER_REQUIREMENT;
  var referTrack = referTrackOrNull(pageTrack);
  var referHref = referTrack ? (referTrack.route + '#/refer') : tracksHomeHref();
  var activeTracks = HUB_EXAMS.filter(function (e) { return e.active; });

  // Every distinct active kind (Notary, Driver, Real Estate Broker, ...), each linking to its own
  // category landing page -- same slug logic renderHub()'s category cards and route()'s own
  // /{category-slug} matching already use (kindSlug()/HUB_KIND_SLUGS), so these links are guaranteed
  // to resolve to a real page rather than needing a second, easily-drifting list of category slugs.
  // This column alone covers the "browse the catalog" job -- the old separate "Exams" column (a
  // few sample state tracks + a link duplicating the header's own "Browse exams" CTA) was dropped
  // as redundant with it.
  var activeKinds = [];
  activeTracks.forEach(function (t) { if (activeKinds.indexOf(t.examKind) === -1) activeKinds.push(t.examKind); });
  activeKinds.sort(function (a, b) { return a.localeCompare(b); });
  var categoriesCol = '<div><h3>Categories</h3><ul class="footer-link-list">' +
    activeKinds.map(function (k) { return '<li><a href="/' + kindSlug(k) + '">' + escapeHtml(k) + '</a></li>'; }).join('') +
    '</ul></div>';
  var accountCol = '<div><h3>Account</h3><ul class="footer-link-list">' +
    '<li><a href="#/redeem">Redeem access code</a></li>' +
    '<li><a href="#/gift">Gift a track</a></li>' +
    '<li><a href="' + referHref + '">Refer &amp; earn</a></li>' +
    '</ul></div>';
  var supportCol = '<div><h3>Support</h3><ul class="footer-link-list">' +
    '<li><a href="#/faq">FAQ</a></li>' +
    '<li><a href="#/guarantee">Guarantee &amp; refunds</a></li>' +
    '<li><a href="#/pass-rates">Pass rate transparency</a></li>' +
    '<li><a href="#/changelog">Exam mechanics changelog</a></li>' +
    '<li><a href="#/refund">Refund request</a></li>' +
    '<li><a href="#/contact">Contact us</a></li>' +
    '</ul></div>';
  var companyCol = '<div><h3>Company &amp; Legal</h3><ul class="footer-link-list">' +
    '<li><a href="#/about">About us</a></li>' +
    '<li><a href="/blog">Guides &amp; Tips</a></li>' +
    '<li><a href="#/embed">Embed a question widget</a></li>' +
    '<li><a href="#/feedback">Share your experience</a></li>' +
    '<li><a href="#/terms">Terms of service</a></li>' +
    '<li><a href="#/privacy">Privacy policy</a></li>' +
    '</ul></div>';

  document.getElementById('site-footer').innerHTML =
    '<div class="site-shell footer-shell">' +
    '<div class="footer-grid">' +
    '<div class="footer-brand-col">' +
    '<span class="site-logo"><span class="site-logo-icon">' + LOGO_SVG + '</span>' +
    '<span class="site-logo-word">PassExam<span class="site-logo-accent">HQ</span></span></span>' +
    '<p class="muted footer-brand-blurb">Independent, one-time-purchase prep for real licensing exams. Question banks built on the current official handbooks — no subscriptions, ever.</p>' +
    '</div>' +
    categoriesCol + accountCol + supportCol + companyCol +
    '</div>' +
    '<div class="footer-legal-strip muted">' + window.location.hostname + ' is an independent study tool, not affiliated with, authorized by, sponsored by, or endorsed by ' + orgLine + ' or any other government agency. Practice questions only, and ' + requirement + ' — passing the real exam isn\'t guaranteed, though we back that risk with our <a href="#/guarantee">' + refundFailurePercent + '% refund guarantee</a>. © ' + SITE_YEAR + ' PassExamHQ. All rights reserved.</div>' +
    '</div>';
}

// ---- Help chat widget (v1: canned FAQ answers, no LLM/API key) ------------
// Rendered once at boot into #help-chat-root (sibling of #site-header/#app/#site-footer, NOT
// inside appEl) so it survives every route() re-render and keeps its conversation across
// navigation, same reasoning as the header/footer living outside appEl. Matching is pure
// client-side keyword scoring -- no network call, no cost, no server to build. Designed so a
// later real-LLM upgrade only has to replace answerHelpChatQuestion()'s body (swap the local
// match for a fetch to a new /chat endpoint) -- the message-thread UI itself doesn't change.
var HELP_CHAT_FAQ = [
  {
    keywords: ['redeem', 'access code', 'enter code', 'enter my code', 'activate code', 'activate my code'],
    question: 'How do I redeem my access code?',
    answer: function () {
      return 'Go to <a href="#/redeem">Redeem code</a> and enter the code exactly as it was emailed to you — that code is your entire login, no password needed.';
    },
  },
  {
    keywords: ['buy', 'purchase', 'price', 'cost', 'how much', 'pricing'],
    question: 'How much does a track cost?',
    answer: function () {
      return 'Each track is a single one-time payment, not a subscription — pay once and keep access. Prices vary by track; ' +
        '<a href="' + tracksHomeHref() + '">browse tracks</a> to see the current price for the one you need.';
    },
  },
  {
    keywords: ['refund', 'guarantee', 'money back', "don't pass", "doesn't pass", "didn't pass", 'do not pass', 'did not pass', 'fail the exam', 'failed the exam', "if i fail"],
    question: 'What if I don\'t pass the real exam?',
    answer: function () {
      return 'We back every track with a pass-or-money-back guarantee — if you take the real exam and don\'t pass, we refund ' +
        refundFailurePercent + '% of your purchase. See the <a href="#/guarantee">full guarantee terms</a> or ' +
        'start a <a href="#/refund">refund request</a>.';
    },
  },
  {
    keywords: ['gift', 'buy for someone', 'buy for a friend', 'present'],
    question: 'Can I gift a track to someone else?',
    answer: function () {
      return 'Yes — <a href="#/gift">gift a track</a> and we\'ll send the recipient their own access code, or hand you a ' +
        'shareable code if you\'d rather deliver it yourself.';
    },
  },
  {
    keywords: ['refer', 'referral', 'points', 'invite a friend', 'invite friends', 'earn free', 'free access'],
    question: 'How does referring friends work?',
    answer: function () {
      return 'Refer friends and earn points toward free access — see <a href="' + tracksHomeHref() + '#tracks">a track\'s page</a> ' +
        'and use its "Refer & earn" link, or check your points from the buy page\'s "Check my points" button.';
    },
  },
  {
    keywords: ['sample', 'try free', 'free questions', 'demo', 'before i buy', 'before buying', 'try it first', 'try before'],
    question: 'Can I try questions before buying?',
    answer: function () {
      return 'Yes — every track has free sample questions with no account needed. ' +
        '<a href="' + tracksHomeHref() + '">Browse tracks</a> and open any one to try a sample.';
    },
  },
  {
    keywords: ['discount', 'promo code', 'coupon', 'student discount', 'promotion'],
    question: 'Do you offer discounts?',
    answer: function () {
      return 'When a discount is active it\'ll show right on the buy page, and there\'s a promo code field there too if you have one — enter it and click Apply before paying.';
    },
  },
  {
    keywords: ['voice', 'read aloud', 'read out loud', 'audio', 'listen to questions'],
    question: 'What does voice-enabled practice mean?',
    answer: function () {
      return 'Questions can be read aloud to you, and you can answer by voice too — it\'s built into the practice quiz once you\'re unlocked into a track.';
    },
  },
  {
    keywords: ['mock exam', 'timed test', 'practice test', 'how many questions', 'exam format'],
    question: 'How is the mock exam formatted?',
    answer: function () {
      return 'Each track\'s mock exam mirrors that state/track\'s real question count, time limit, and passing score — open the specific ' +
        'track\'s page for its exact numbers, since they vary a lot by track.';
    },
  },
  {
    keywords: ['progress', 'accuracy', 'coverage', 'track my progress', 'how am i doing'],
    question: 'How do I track my progress?',
    answer: function () {
      return 'Once you\'re logged in with your code, the Progress tab shows your Accuracy and Coverage per topic, so you know exactly what to restudy before test day.';
    },
  },
  {
    keywords: ['login', 'log in', 'account', 'sign in', 'password', 'my code'],
    question: 'How do I log in?',
    answer: function () {
      return 'There\'s no password to manage — your access code is your login. ' +
        '<a href="#/redeem">Enter it here</a> if you haven\'t already.';
    },
  },
  {
    keywords: ['states', 'which exams', 'what tracks', 'available tracks', 'what do you offer'],
    question: 'Which states/tracks are available?',
    answer: function () {
      return '<a href="' + tracksHomeHref() + '">Browse all tracks</a> to see what\'s currently live for your state.';
    },
  },
  {
    keywords: ['about', 'who are you', 'what is this site', 'what is passexamhq'],
    question: 'What is PassExamHQ?',
    answer: function () { return 'Short version on <a href="#/about">our About page</a> — independent practice question banks built from official state handbooks, one-time purchase, no subscription.'; },
  },
  {
    keywords: ['privacy', 'my data', 'my information'],
    question: 'What data do you store about me?',
    answer: function () { return 'See our <a href="#/privacy">privacy page</a> for exactly what we store and why.'; },
  },
  {
    keywords: ['terms', 'legal', 'terms of service'],
    question: 'Where are your terms of service?',
    answer: function () { return 'Here: <a href="#/terms">Terms of service</a>.'; },
  },
  {
    keywords: ['contact', 'support', 'talk to someone', 'human', 'help me', 'real person'],
    question: 'How do I reach a real person?',
    answer: function () { return 'Send us a note on the <a href="#/contact">Contact us</a> page and we\'ll reply to your email.'; },
  },
];
var HELP_CHAT_FALLBACK_HTML = 'I\'m not able to answer that one yet — this is a simple FAQ helper, not a full support agent. ' +
  'Try rephrasing, check the full <a href="#/faq">FAQ page</a>, or <a href="#/contact">contact us</a> directly and a real person will help.';
var HELP_CHAT_SUGGESTIONS = ['How do I redeem my code?', 'What if I don\'t pass?', 'Can I try before buying?'];

var helpChatMessages = []; // { role: 'user'|'bot', html: string }
var helpChatOpen = false;

function scoreHelpChatEntry(entry, queryLower) {
  var score = 0;
  entry.keywords.forEach(function (k) { if (queryLower.indexOf(k) !== -1) score++; });
  return score;
}
function answerHelpChatQuestion(query) {
  var queryLower = query.toLowerCase();
  var best = null, bestScore = 0;
  HELP_CHAT_FAQ.forEach(function (entry) {
    var s = scoreHelpChatEntry(entry, queryLower);
    if (s > bestScore) { bestScore = s; best = entry; }
  });
  return best ? best.answer() : HELP_CHAT_FALLBACK_HTML;
}

function helpChatSuggestionsHtml() {
  return '<div class="help-chat-suggestions">' + HELP_CHAT_SUGGESTIONS.map(function (q) {
    return '<button type="button" class="help-chat-suggestion" data-act="help-chat-suggestion" data-question="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>';
  }).join('') + '</div>';
}

function renderHelpChatWidget() {
  var root = document.getElementById('help-chat-root');
  if (!root) return;
  root.innerHTML =
    '<button class="help-chat-toggle" type="button" data-act="toggle-help-chat" aria-label="Open help chat">💬</button>' +
    '<div class="help-chat-panel" id="help-chat-panel" hidden>' +
    '<div class="help-chat-panel-header"><span>PassExamHQ Help</span>' +
    '<button class="help-chat-close" type="button" data-act="toggle-help-chat" aria-label="Close help chat">✕</button></div>' +
    '<div class="help-chat-messages" id="help-chat-messages"></div>' +
    '<form class="help-chat-input-row" data-act="help-chat-send">' +
    '<input type="text" id="help-chat-input" placeholder="Ask a question…" autocomplete="off">' +
    '<button class="btn-primary btn-sm" type="submit">Send</button>' +
    '</form>' +
    '</div>';
}

function appendHelpChatMessage(role, html) {
  helpChatMessages.push({ role: role, html: html });
  var listEl = document.getElementById('help-chat-messages');
  if (!listEl) return;
  listEl.insertAdjacentHTML('beforeend', '<div class="help-chat-msg help-chat-msg-' + role + '">' + html + '</div>');
  listEl.scrollTop = listEl.scrollHeight;
}

function openHelpChatIfNeeded() {
  if (helpChatMessages.length) return;
  appendHelpChatMessage('bot', 'Hi! I can answer quick questions about buying, redeeming a code, the guarantee, and more. What do you need?');
  appendHelpChatMessage('bot', helpChatSuggestionsHtml());
}

function closeHelpChat() {
  helpChatOpen = false;
  var helpChatPanelEl = document.getElementById('help-chat-panel');
  if (helpChatPanelEl) helpChatPanelEl.hidden = true;
}

function sendHelpChatQuestion(question) {
  question = question.trim();
  if (!question) return;
  appendHelpChatMessage('user', escapeHtml(question));
  var inputEl = document.getElementById('help-chat-input');
  if (inputEl) inputEl.value = '';
  // Tiny delay so a reply that's actually instant still reads as "answering", not "static lookup".
  setTimeout(function () { appendHelpChatMessage('bot', answerHelpChatQuestion(question)); }, 350);
}

// ---- Site news banner ------------------------------------------------------
// Dismissible via localStorage keyed by id, so a future announcement (new id) reappears
// for everyone even if they dismissed an older one. Rendered on the hub (home page) and
// inside the notary app's tab bar (renderTabs) so both new visitors and existing users see it.
var SITE_NEWS = {
  id: 'notary-500-2026-08',
  text: '🎉 Big update: 500+ new California Notary practice questions just added — the bank has nearly tripled to 750+ questions!',
};
function renderNewsBanner() {
  if (localStorage.getItem('examprep_news_dismissed') === SITE_NEWS.id) return '';
  return '<div class="news-flash-banner" data-news-id="' + SITE_NEWS.id + '">' +
    '<span class="news-flash-badge">New</span>' +
    '<span class="news-flash-text">' + SITE_NEWS.text + '</span>' +
    '<button class="news-flash-dismiss" type="button" data-act="dismiss-news" aria-label="Dismiss">✕</button>' +
    '</div>';
}

// ---- Promotions (admin-managed, examprep-admin's Promotions tab) ----------
// Home-page banners are individually dismissible (unlike the single news banner, there can be
// several at once, so this tracks a set of dismissed ids rather than one value). Checkout-page
// banners are not dismissible -- it's a one-time visit, dismissing there would just hide a promo
// code from someone who might want to come back and use it.
function getDismissedPromoIds() {
  try { return JSON.parse(localStorage.getItem('examprep_promos_dismissed') || '[]'); } catch (e) { return []; }
}
function dismissPromoId(id) {
  var ids = getDismissedPromoIds();
  if (ids.indexOf(id) === -1) { ids.push(id); localStorage.setItem('examprep_promos_dismissed', JSON.stringify(ids)); }
}

// Lets a promotion's title/body reference the live Settings-tab guarantee numbers instead of
// baking them in as typed digits -- e.g. "Pass or {{refundPct}}% of Your Money Back ... {{coveragePct}}%
// coverage" stays correct automatically when an admin later tweaks refund_failure_percent /
// progress_accuracy_pass_pct / progress_coverage_pass_pct, instead of silently drifting the way a
// hardcoded number would. Callers of promoBannersHtml must have awaited loadSiteConfig() first so
// these globals hold the current values, not the pre-fetch defaults.
function applyPromoPlaceholders(text) {
  return text
    .replace(/\{\{refundPct\}\}/g, refundFailurePercent)
    .replace(/\{\{accuracyPct\}\}/g, progressAccuracyPassPct)
    .replace(/\{\{coveragePct\}\}/g, progressCoveragePassPct);
}

function promoBannersHtml(promotions, dismissible, showBody) {
  if (showBody === undefined) showBody = true; // default on; home page passes false for a condensed, heading-only card
  var dismissedIds = dismissible ? getDismissedPromoIds() : [];
  return promotions.filter(function (p) { return dismissedIds.indexOf(p.id) === -1; }).map(function (p) {
    var codeChip = p.promoCode
      ? '<span class="badge promo-banner-code">Code: ' + escapeHtml(p.promoCode) +
        (p.requiredEmailDomain ? ' (requires ' + escapeHtml(p.requiredEmailDomain) + ' email)' : '') + '</span>'
      : (p.requiredEmailDomain
        ? '<span class="badge promo-banner-code">No code needed — just enter a ' + escapeHtml(p.requiredEmailDomain) + ' email at checkout</span>'
        : '');
    var cta = (p.ctaLabel && p.ctaUrl) ? '<a class="btn-primary btn-sm promo-banner-cta" href="' + escapeHtml(p.ctaUrl) + '">' + escapeHtml(p.ctaLabel) + '</a>' : '';
    var dismissBtn = dismissible
      ? '<button class="promo-banner-dismiss" type="button" data-act="dismiss-promo" data-promo-id="' + p.id + '" aria-label="Dismiss">✕</button>'
      : '';
    var bodyText = showBody ? '<span class="promo-banner-text">' + escapeHtml(applyPromoPlaceholders(p.body)) + '</span> ' : '';
    return '<div class="promo-banner">' +
      '<div class="promo-banner-body"><strong>' + escapeHtml(applyPromoPlaceholders(p.title)) + '</strong> ' +
      bodyText + codeChip + '</div>' +
      cta + dismissBtn + '</div>';
  }).join('');
}

// Account menu: a real dropdown (not a bare button) so there's somewhere to add more
// account-level actions later without another header redesign.
function renderProfileMenu() {
  return '<div class="profile-menu">' +
    '<button class="profile-menu-btn" type="button" data-act="toggle-profile-menu" aria-label="Account menu" aria-haspopup="true">👤</button>' +
    '<div class="profile-menu-dropdown">' +
    '<a class="profile-menu-item" href="#/profile">My Profile</a>' +
    '<button class="profile-menu-item" type="button" data-act="log-out">Log out</button>' +
    '</div></div>';
}

// Genericized version of an .termsParagraph2 entry, used when Terms is viewed from the hub (no
// specific track in the URL path) -- same reasoning as HUB_FOOTER_ORG_LINE/HUB_FOOTER_REQUIREMENT.
var HUB_TERMS_PARAGRAPH2 = '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy any state-mandated ' +
  'licensing, driver education, or training requirement, and does not issue any official course-completion certificate — our ' +
  'content is a supplementary study aid only. Completing practice exams here also does not register you for, or schedule, any ' +
  'official state or federal knowledge test, skills test, or road test; official testing and any required training must be ' +
  'scheduled directly through the relevant state or federal agency. While we strive to align our content with the current ' +
  'official handbook or manual for each track, it is provided "as-is" for self-study and does not constitute legal or ' +
  'professional advice or a guaranteed exam outcome.</p>';

async function renderTerms() {
  var pageTrack = activeTrackForPath(window.location.pathname);
  if (pageTrack) await loadTrackContent(pageTrack.examType);
  var compliance = pageTrack ? trackCompliance(pageTrack.examType) : { orgLine: HUB_FOOTER_ORG_LINE, termsParagraph2: HUB_TERMS_PARAGRAPH2 };
  appEl.innerHTML = '<div class="narrow-page"><h1>Terms of Use</h1>' +
    '<p class="muted">PassExamHQ provides original, independently-authored practice questions for exam preparation purposes only. ' +
    'It is not affiliated with, authorized by, sponsored by, or endorsed by ' + compliance.orgLine + ' ' +
    'or any other government agency. All official state trademarks, examination names, and statutory references are used purely ' +
    'for identification and descriptive purposes. ' +
    'Access codes are non-transferable and grant access to one exam track as specified at purchase. ' +
    'We make no guarantee of passing any official exam.</p>' +
    compliance.termsParagraph2 +
    '<p class="muted">Referral points have no cash value and cannot be redeemed, exchanged, or refunded for cash ' +
    'or any other payment method — they may only be applied toward a course through this site. Points may expire ' +
    'or be adjusted, and the referral program itself may be modified, suspended, or discontinued, at any time. ' +
    'We reserve the right to revoke points or access obtained through fraud, abuse, or violation of these terms.</p>' +
    '<p class="muted">Only one promotional discount or code may be applied per purchase — discounts cannot be ' +
    'combined or stacked with each other, though referral points may still be applied on top of a single active ' +
    'discount. Some promotions are restricted to first-time buyers and will be rejected at checkout for an email ' +
    'already associated with a prior purchase.</p>' +
    '<button class="btn-secondary btn-sm" data-act="go-back">← Back</button></div>';
}

function renderPrivacy() {
  appEl.innerHTML = '<div class="narrow-page"><h1>Privacy</h1>' +
    '<p class="muted">We store the minimum needed to run your account: your access code\'s redemption status, ' +
    'your quiz progress, and your theme/font preferences. We only collect an email address if you choose to ' +
    'provide one — for an optional backup copy of your access code at purchase, or to take part in the referral ' +
    'program. If you refer a friend, we use their name/email only to send a one-time confirmation email on your ' +
    'behalf; if you\'re referred by a friend, the same applies to you. We never sell or share this data. ' +
    'Payments are processed by Stripe directly; we don\'t see or store your payment details. Contact whoever ' +
    'issued your code with any privacy questions.</p>' +
    '<button class="btn-secondary btn-sm" data-act="go-back">← Back</button></div>';
}

function renderAbout() {
  appEl.innerHTML = '<div class="narrow-page"><h1>About PassExamHQ</h1>' +
    '<p class="muted">PassExamHQ builds independent practice question banks for state and national licensing ' +
    'exams — driver\'s license and CDL knowledge tests, motorcycle endorsements, notary public exams, real ' +
    'estate licensing, boating safety, and more — each one built directly from the current official handbook ' +
    'or manual for that specific state and track, not a generic national bank reused everywhere.</p>' +
    '<p class="muted">Every track is a single one-time purchase, not a subscription: pay once, keep access. ' +
    'That access includes the full question bank for unlimited practice, timed mock exams that mirror the ' +
    'real format, voice-enabled answering and read-aloud, and per-topic progress tracking so you know what to ' +
    'actually restudy before test day — not just an overall score.</p>' +
    '<p class="muted">We back every track with a pass-or-money-back guarantee (see the full ' +
    '<a href="#/guarantee">guarantee terms</a>), and our results page shows real, unedited numbers pulled ' +
    'straight from our own database, not invented marketing figures.</p>' +
    '<p class="muted">PassExamHQ is an independent study tool. We are not affiliated with, authorized by, ' +
    'sponsored by, or endorsed by any state department of motor vehicles, state licensing agency, or official ' +
    'examination vendor, and completing our practice questions or mock exams does not register you for, or ' +
    'substitute for, any official state or federal exam.</p>' +
    '<button class="btn-secondary btn-sm" data-act="go-back">← Back</button></div>';
}

// Grouped Q&A, one <details> per item (native disclosure -- no JS needed for expand/collapse,
// accessible by default). Deliberately more thorough than the help-chat widget's 16-entry FAQ
// (HELP_CHAT_FAQ, near the top of this file) -- this is the "read the whole thing" version,
// that one's the "quick lookup while you're mid-task" version. Keep both, don't try to unify
// them into one dataset -- the chat widget's entries are terse on purpose (chat bubble width),
// this page's are meant to be read start to finish.
var FAQ_CATEGORIES = [
  {
    category: 'Getting Started',
    items: [
      { q: 'What is PassExamHQ?', a: function () {
        return 'Independent practice question banks for state and national licensing exams, built directly from official ' +
          'handbooks for each specific state and track. See the full <a href="#/about">About page</a>.';
      } },
      { q: 'Which states and exams do you cover?', a: function () {
        return '<a href="' + tracksHomeHref() + '">Browse all tracks</a> to see what\'s currently live for your state.';
      } },
      { q: 'Can I try questions before buying?', a: function () {
        return 'Yes — every track has free sample questions, no account needed. Open any track from the ' +
          '<a href="' + tracksHomeHref() + '">tracks page</a> to try one.';
      } },
      { q: 'Do I need to create an account?', a: function () {
        return 'No separate signup. Your access code (emailed after purchase or redemption) is your entire login — see ' +
          '"How do I redeem my code?" below.';
      } },
    ],
  },
  {
    category: 'Buying & Pricing',
    items: [
      { q: 'How much does a track cost, and is it a subscription?', a: function () {
        return 'Each track is a single one-time payment, not a subscription — pay once and keep access for good. ' +
          'Prices vary by track; <a href="' + tracksHomeHref() + '">browse tracks</a> to see the current price for yours.';
      } },
      { q: 'What payment methods do you accept?', a: function () {
        return 'Card, Apple Pay, or Google Pay — checkout runs through Stripe, and whichever wallet your device supports shows up automatically.';
      } },
      { q: 'Do you offer discounts or promo codes?', a: function () {
        return 'When a discount is active it shows right on the buy page. Some discounts need a code (enter it in the ' +
          'promo field and click Apply); others auto-apply for a qualifying email domain (e.g. a student discount for a .edu address) with no code needed.';
      } },
      { q: 'Can I buy a track as a gift?', a: function () {
        return 'Yes — <a href="#/gift">gift a track</a>. You can enter the recipient\'s email and we\'ll send their code directly, ' +
          'or leave it blank and get a shareable code to send yourself.';
      } },
    ],
  },
  {
    category: 'Your Access Code',
    items: [
      { q: 'How do I redeem my code?', a: function () {
        return 'Go to <a href="#/redeem">Redeem code</a> and enter it exactly as emailed. That logs you in on this device — ' +
          'no password to create or remember.';
      } },
      { q: 'Do I need a password?', a: function () {
        return 'No. Your code is the entire login mechanism, by design — one thing to keep track of, not a code and a password.';
      } },
      { q: 'Can I use my code on more than one device?', a: function () {
        return 'Yes — re-enter the same code on another device\'s <a href="#/redeem">Redeem code</a> page and it logs that device into the same account.';
      } },
      { q: "I lost my code, or never received the email — what now?", a: function () {
        return '<a href="#/contact">Contact us</a> with the email you purchased or were gifted with, and we\'ll help track it down.';
      } },
    ],
  },
  {
    category: 'Studying & Practice',
    items: [
      { q: "What's included once I unlock a track?", a: function () {
        return 'The full question bank for unlimited practice, a timed mock exam plus a "Weak Spots" drill of the hardest ' +
          'questions, voice-enabled answering and read-aloud, a study resource library, and per-topic progress tracking.';
      } },
      { q: 'Can questions be read aloud to me?', a: function () {
        return 'Yes — voice-enabled practice can read each question aloud, and you can answer by voice too, right from the practice quiz.';
      } },
      { q: 'Can I practice by difficulty level?', a: function () {
        return 'Yes — the practice quiz has an Easy / Moderate / Hard / Extremely Hard filter, plus "All," so you can drill weak spots specifically.';
      } },
      { q: 'How many questions are on my exam, and how long is it?', a: function () {
        return 'This varies a lot by track — open your specific track\'s page (from the <a href="' + tracksHomeHref() + '">tracks list</a>) ' +
          'for its exact question count, time limit, and passing score.';
      } },
    ],
  },
  {
    category: 'Progress Tracking',
    items: [
      { q: 'How do I know if I\'m ready for the real exam?', a: function () {
        return 'Once you\'re logged in, the Progress tab shows Accuracy (how often you\'re getting questions right) and Coverage ' +
          '(how much of the bank you\'ve actually practiced) broken down per topic — so you know exactly what to restudy, not just an overall score.';
      } },
    ],
  },
  {
    category: 'Guarantee & Refunds',
    items: [
      { q: "What if I take the real exam and don't pass?", a: function () {
        return 'We refund <span class="js-refund-pct">' + refundFailurePercent + '</span>% of your purchase, as long as you maintained at least ' +
          '<span class="js-accuracy-pct">' + progressAccuracyPassPct + '</span>% Accuracy and <span class="js-coverage-pct">' + progressCoveragePassPct +
          '</span>% Coverage on the Progress tab. Full details on the <a href="#/guarantee">guarantee page</a>.';
      } },
      { q: 'Can I get a refund if I just change my mind?', a: function () {
        return 'Yes — a 7-day, no-questions-asked refund covers that separately from the pass-guarantee above.';
      } },
      { q: 'How do I request a refund?', a: function () { return 'Start a <a href="#/refund">refund request</a> here.'; } },
    ],
  },
  {
    category: 'Referrals, Points & Gifts',
    items: [
      { q: 'How does referring friends work?', a: function () {
        return 'Refer friends and earn points toward free access — find your track\'s "Refer & earn" link from its ' +
          '<a href="' + tracksHomeHref() + '">track page</a>.';
      } },
      { q: 'How do I check my referral points?', a: function () {
        return 'On the buy page, click "Check my points" — you can apply them toward that purchase\'s total right there.';
      } },
    ],
  },
  {
    category: 'Account & Legal',
    items: [
      { q: 'What data do you store about me?', a: function () { return 'See exactly what and why on our <a href="#/privacy">privacy page</a>.'; } },
      { q: 'Where are your terms of service?', a: function () { return '<a href="#/terms">Terms of service</a>.'; } },
      { q: "My question isn't answered here", a: function () { return '<a href="#/contact">Contact us</a> and we\'ll reply to your email.'; } },
    ],
  },
];

function refreshFaqDynamicSpans() {
  loadSiteConfig().then(function () {
    document.querySelectorAll('.js-refund-pct').forEach(function (el) { el.textContent = refundFailurePercent; });
    document.querySelectorAll('.js-accuracy-pct').forEach(function (el) { el.textContent = progressAccuracyPassPct; });
    document.querySelectorAll('.js-coverage-pct').forEach(function (el) { el.textContent = progressCoveragePassPct; });
  });
}

// Injects/updates a <script type="application/ld+json"> in <head> -- shared helper for any
// JSON-LD structured data added to the (client-rendered) SPA. `id` lets a later call replace a
// prior injection instead of stacking duplicates as the user navigates between routes.
function injectJsonLd(id, data) {
  var existing = document.getElementById(id);
  if (existing) existing.remove();
  var script = document.createElement('script');
  script.type = 'application/ld+json';
  script.id = id;
  script.textContent = JSON.stringify(data);
  document.head.appendChild(script);
}
function stripHtml(html) { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

// Schema.org Question node for one real sample question -- shared by the standalone #/sample page
// (wrapped in a Quiz, see quizJsonLd below) and the single-question widgets on category/track
// landing pages (used bare, same shape as renderFaq()'s FAQPage Question entries). Wrong choices
// go in suggestedAnswer (schema.org's own field for this) rather than being omitted, since a
// multiple-choice question genuinely has 3 incorrect options, not just 1 accepted answer.
function questionJsonLd(q) {
  var wrongAnswers = ['A', 'B', 'C', 'D'].filter(function (k) { return k !== q.correctChoice && q.choices[k]; })
    .map(function (k) { return { '@type': 'Answer', text: q.choices[k] }; });
  return {
    '@type': 'Question',
    name: q.question,
    acceptedAnswer: { '@type': 'Answer', text: q.choices[q.correctChoice] },
    suggestedAnswer: wrongAnswers,
  };
}
// Wraps a set of real sample questions for one track as a schema.org Quiz -- used on the
// standalone #/sample page, which is the one surface showing more than a single question at once.
function quizJsonLd(trackLabel, questions) {
  return {
    '@context': 'https://schema.org', '@type': 'Quiz',
    about: { '@type': 'Thing', name: trackLabel },
    hasPart: questions.map(questionJsonLd),
  };
}

function renderFaq() {
  appEl.innerHTML = '<div class="narrow-page"><h1>Frequently Asked Questions</h1>' +
    '<p class="muted">Quick answers on buying, your access code, studying, and the guarantee. Still stuck? ' +
    '<a href="#/contact">Contact us</a> or use the chat bubble in the corner.</p>' +
    FAQ_CATEGORIES.map(function (cat) {
      return '<section class="faq-category"><h2>' + escapeHtml(cat.category) + '</h2>' +
        cat.items.map(function (item) {
          return '<details class="faq-item"><summary>' + escapeHtml(item.q) + '</summary>' +
            '<div class="faq-answer muted">' + item.a() + '</div></details>';
        }).join('') + '</section>';
    }).join('') +
    '<button class="btn-secondary btn-sm" data-act="go-back">← Back</button></div>';
  refreshFaqDynamicSpans();
  // FAQPage JSON-LD -- real content, the exact same Q&A already on the page, just structured for
  // Google's rich-snippet eligibility. Answer text is stripped to plain text (schema.org's own
  // recommendation) since item.a() can return HTML (links, etc).
  var faqEntities = [];
  FAQ_CATEGORIES.forEach(function (cat) {
    cat.items.forEach(function (item) {
      faqEntities.push({
        '@type': 'Question', name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: stripHtml(item.a()) },
      });
    });
  });
  injectJsonLd('faq-jsonld', { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqEntities });
}

// Educational blog/guide content (/blog, /blog/{slug} -- real pathname routes, not hash routes,
// so _worker.js can inject per-post SEO meta and sitemap.xml can list them; see route()'s own
// comment on why). Admin-authored via the DB-backed blog_posts table (see the API's schema.sql
// comment), not hardcoded here, so publishing needs no code deploy. kind is a category slug
// (matches HUB_KIND_SLUGS values / category_content.slug) so each post can link back to its
// category page via kindFromSlug().
// blogPostHref/blogListHref carry the active category filter across a real page navigation (this
// site uses real <a href> page loads for /blog, not client-side pushState routing -- see the route()
// comment below) via a ?from=<kind> query param on the post URL, so clicking "← Blog" from a post
// can return to the same filtered list instead of always resetting to "All".
function blogListHref(kind) { return '/blog' + (kind ? '?kind=' + encodeURIComponent(kind) : ''); }
function blogPostHref(slug, kind) { return '/blog/' + encodeURIComponent(slug) + (kind ? '?from=' + encodeURIComponent(kind) : ''); }

function blogListItemsHtml(posts, activeKind) {
  return posts.length
    ? '<div class="blog-list">' + posts.map(function (p) {
        var kindLabel = kindFromSlug(p.kind) || p.kind;
        var href = blogPostHref(p.slug, activeKind);
        return '<article class="blog-list-item card">' +
          '<span class="badge blog-list-item-badge">' + escapeHtml(kindLabel) + '</span>' +
          '<h2><a href="' + href + '">' + escapeHtml(p.title) + '</a></h2>' +
          '<p class="muted blog-list-meta">' + (p.stateCode ? escapeHtml(p.stateCode) + ' · ' : '') +
          (p.published_at ? new Date(p.published_at * 1000).toLocaleDateString() : '') + '</p>' +
          '<p class="blog-list-excerpt">' + escapeHtml(p.excerpt) + '</p>' +
          '<a class="blog-read-more" href="' + href + '">Read more →</a>' +
          '</article>';
      }).join('') + '</div>'
    : '<p class="muted">No articles in this category yet — check back soon.</p>';
}

// Category slugs actually present in the fetched posts, in HUB_KIND_SLUGS' declared order (not
// alphabetical/appearance order) so the tab bar always reads in the same category order the rest
// of the site uses -- only categories with at least one published post get a tab, so an empty
// category never shows a dead-end filter. Real <a href="/blog?kind=..."> links, not JS-only
// buttons, since a full page load is how this site navigates -- the ?kind= param is read back out
// by renderBlogList() below so a reload/bookmark/back-button lands on the same filtered view.
function blogCategoryTabsHtml(posts, activeKind) {
  var counts = {};
  posts.forEach(function (p) { counts[p.kind] = (counts[p.kind] || 0) + 1; });
  var slugs = [];
  for (var label in HUB_KIND_SLUGS) { if (counts[HUB_KIND_SLUGS[label]]) slugs.push(HUB_KIND_SLUGS[label]); }
  if (slugs.length < 2) return ''; // nothing to filter if every post is the same (or only) category
  return '<div class="blog-category-tabs" role="tablist">' +
    '<a class="' + (activeKind ? '' : 'active') + '" href="' + blogListHref('') + '">All (' + posts.length + ')</a>' +
    slugs.map(function (slug) {
      return '<a class="' + (slug === activeKind ? 'active' : '') + '" href="' + blogListHref(slug) + '">' + escapeHtml(kindFromSlug(slug) || slug) + ' (' + counts[slug] + ')</a>';
    }).join('') +
    '</div>';
}

// Renders in batches instead of the whole filtered list at once -- with 30+ posts in "All", a
// single-column list of full cards became an extremely long scroll. blogListState holds the
// already-fetched data (one /blog call covers every category) plus how many of the current
// filter's posts are currently shown; "Load more" (see the delegated click handler) just bumps
// visibleCount and redraws from the cached arrays, no new fetch needed.
var BLOG_PAGE_SIZE = 12;
var blogListState = null;

function drawBlogList() {
  var posts = blogListState.posts, shown = blogListState.shown, activeKind = blogListState.activeKind;
  var visibleCount = blogListState.visibleCount;
  var remaining = shown.length - visibleCount;
  appEl.innerHTML = '<div class="blog-page"><h1>Guides &amp; Tips</h1>' +
    '<p class="muted">Guides and tips for passing your licensing exam.</p>' +
    blogCategoryTabsHtml(posts, activeKind) +
    blogListItemsHtml(shown.slice(0, visibleCount), activeKind) +
    (remaining > 0
      ? '<div class="blog-load-more-wrap"><button class="btn-secondary" data-act="blog-load-more">Load more (' + remaining + ' remaining)</button></div>'
      : '') +
    '<button class="btn-secondary btn-sm blog-back-btn" data-act="go-back">← Back</button></div>';
}

function renderBlogList() {
  var activeKind = new URLSearchParams(location.search).get('kind') || '';
  appEl.innerHTML = '<div class="blog-page"><h1>Guides &amp; Tips</h1><p class="muted">Loading…</p></div>';
  apiFetch('/blog').then(function (res) {
    var posts = (res && res.posts) || [];
    var shown = activeKind ? posts.filter(function (p) { return p.kind === activeKind; }) : posts;
    blogListState = { posts: posts, shown: shown, activeKind: activeKind, visibleCount: Math.min(BLOG_PAGE_SIZE, shown.length) };
    drawBlogList();
  }).catch(function () {
    appEl.innerHTML = '<div class="blog-page"><h1>Guides &amp; Tips</h1><p class="muted">Couldn\'t load articles right now.</p></div>';
  });
}

function renderBlogPost(slug) {
  var fromKind = new URLSearchParams(location.search).get('from') || '';
  appEl.innerHTML = '<div class="narrow-page"><p class="muted">Loading…</p></div>';
  Promise.all([apiFetch('/blog/' + encodeURIComponent(slug)), apiFetch('/blog').catch(function () { return { posts: [] }; })]).then(function (results) {
    var post = results[0] && results[0].post;
    if (!post) { appEl.innerHTML = '<div class="narrow-page"><h1>Not found</h1><p class="muted">This article doesn\'t exist or isn\'t published.</p><a href="' + blogListHref(fromKind) + '">← Back to Guides &amp; Tips</a></div>'; return; }
    var kindLabel = kindFromSlug(post.kind) || post.kind;
    var categoryHref = '/' + post.kind;
    // Prev/next -- the list is already published_at DESC (newest first), so "next" (older) is the
    // following array entry and "previous" (newer) is the preceding one. Falls back to nothing if
    // this is the only post, or the oldest/newest of the set.
    var allPosts = results[1].posts || [];
    var myIndex = allPosts.findIndex(function (p) { return p.slug === slug; });
    var prevPost = myIndex > 0 ? allPosts[myIndex - 1] : null;
    var nextPost = myIndex !== -1 && myIndex < allPosts.length - 1 ? allPosts[myIndex + 1] : null;
    var prevNextHtml = (prevPost || nextPost)
      ? '<div class="blog-post-prevnext">' +
        (prevPost
          ? '<a class="blog-post-prevnext-link" href="' + blogPostHref(prevPost.slug, fromKind) + '"><span class="muted blog-post-prevnext-label">← Previous</span><span class="blog-post-prevnext-title">' + escapeHtml(prevPost.title) + '</span></a>'
          : '<span></span>') +
        (nextPost
          ? '<a class="blog-post-prevnext-link blog-post-prevnext-next" href="' + blogPostHref(nextPost.slug, fromKind) + '"><span class="muted blog-post-prevnext-label">Next →</span><span class="blog-post-prevnext-title">' + escapeHtml(nextPost.title) + '</span></a>'
          : '<span></span>') +
        '</div>'
      : '';
    // ~200 wpm is the commonly-cited average adult silent reading speed -- a rough estimate label,
    // not a precise claim, same spirit as this project's other honestly-hedged display numbers.
    var readMins = Math.max(1, Math.round(stripHtml(post.body_html).split(/\s+/).length / 200));
    appEl.innerHTML = '<div class="narrow-page blog-post">' +
      '<p class="muted blog-post-back"><a href="' + blogListHref(fromKind) + '">← Guides &amp; Tips</a></p>' +
      '<span class="badge blog-post-badge">' + escapeHtml(kindLabel) + '</span>' +
      '<h1>' + escapeHtml(post.title) + '</h1>' +
      '<p class="muted blog-post-meta">' + (post.state_code ? escapeHtml(post.state_code) + ' · ' : '') +
      (post.published_at ? new Date(post.published_at * 1000).toLocaleDateString() + ' · ' : '') + readMins + ' min read</p>' +
      '<div class="blog-post-body">' + post.body_html + '</div>' +
      '<div class="blog-post-cta-box">' +
      '<p>Ready to put this into practice?</p>' +
      '<a class="btn-primary" href="' + categoryHref + '">Practice ' + escapeHtml(kindLabel) + ' questions →</a>' +
      '</div>' +
      prevNextHtml +
      '</div>';
    injectJsonLd('blog-post-jsonld', {
      '@context': 'https://schema.org', '@type': 'Article',
      headline: post.title, description: post.seo_description || post.excerpt,
      datePublished: post.published_at ? new Date(post.published_at * 1000).toISOString() : undefined,
    });
  }).catch(function () {
    appEl.innerHTML = '<div class="narrow-page"><h1>Not found</h1><p class="muted">This article doesn\'t exist or isn\'t published.</p><a href="/blog">← Back to Guides &amp; Tips</a></div>';
  });
}

function renderContact() {
  appEl.innerHTML =
    '<div class="narrow-page">' +
    '<h1>Contact Us</h1>' +
    '<p class="muted">Questions about your account, a purchase, or anything else — send us a note and we\'ll reply to your email.</p>' +
    '<form data-act="contact-submit" class="card">' +
    '<label class="muted buy-email-label">Your name (optional)</label>' +
    '<input type="text" name="name" placeholder="Jane Doe">' +
    '<label class="muted buy-email-label refund-field-spacing">Your email</label>' +
    '<input type="email" name="email" placeholder="you@example.com" required>' +
    '<label class="muted buy-email-label refund-field-spacing">Message</label>' +
    '<textarea name="message" rows="5" placeholder="How can we help?" required></textarea>' +
    '<div id="turnstile-container"></div>' +
    '<button class="btn-primary" type="submit">Send message</button>' +
    '</form>' +
    '</div>';
  renderTurnstileWidget();
}

// Real-student testimonial submission form (#/feedback) -- goes into a moderation queue
// (testimonial_submissions), not published automatically; see the API's own comment on that
// table for why. Prefers the visitor's own current track (state.examType) as the preselected
// option if it's active, since arriving via a specific track's "leave feedback" link is the
// expected common path, but lets them pick any active track.
function testimonialTrackOptionsHtml() {
  var active = HUB_EXAMS.filter(function (e) { return e.active; })
    .slice().sort(function (a, b) { return (a.shortName || a.title).localeCompare(b.shortName || b.title); });
  return active.map(function (t) {
    return '<option value="' + t.examType + '"' + (t.examType === state.examType ? ' selected' : '') + '>' + escapeHtml(t.shortName || t.title) + '</option>';
  }).join('');
}
function renderTestimonialForm() {
  appEl.innerHTML =
    '<div class="narrow-page">' +
    '<h1>Share Your Experience</h1>' +
    '<p class="muted">Passed your exam, or just found the practice questions helpful? A quick note from you may show up as a testimonial on the site (we\'ll only publish it with your name as you enter it, and only after reviewing it).</p>' +
    '<form data-act="testimonial-submit" class="card">' +
    '<label class="muted buy-email-label">Your name (as you\'d like it shown)</label>' +
    '<input type="text" name="author" placeholder="Jane D." required maxlength="100">' +
    '<label class="muted buy-email-label refund-field-spacing">Your email (optional, private — only so we can follow up if needed)</label>' +
    '<input type="email" name="email" placeholder="you@example.com">' +
    '<label class="muted buy-email-label refund-field-spacing">Which track?</label>' +
    '<select name="examType" required>' + testimonialTrackOptionsHtml() + '</select>' +
    '<label class="muted buy-email-label refund-field-spacing">Your testimonial</label>' +
    '<textarea name="quote" rows="4" placeholder="What was your experience like?" required maxlength="1000"></textarea>' +
    '<div id="turnstile-container"></div>' +
    '<button class="btn-primary" type="submit">Submit</button>' +
    '</form>' +
    '</div>';
  renderTurnstileWidget();
}

// Rebuilt as a full landing page (ported from v0's guarantee/page.tsx: hero+stat card, eligibility
// steps, FAQ) rather than the single compact card this used to be. v0's copy has specific numbers
// (a fabricated "94% pass their first attempt" stat, an "85% on two timed exams" eligibility bar,
// 60-day/14-day deadlines) that don't match this site's real policy -- ported the STRUCTURE only;
// every number here is real (refundFailurePercent, accuracy/coverage thresholds, and the real
// /stats/public pass rate, correctly framed as practice-exam performance, not a claim about real
// official exam outcomes we have no way to measure).
function renderGuarantee() {
  appEl.innerHTML = '<div class="narrow-page"><h1>Our Guarantee</h1><p class="muted">Loading…</p></div>';
  Promise.all([loadSiteConfig(), apiFetch('/stats/public').catch(function () { return null; })]).then(function (results) {
    var stats = results[1];
    var passRateNote = (stats && stats.passRate != null)
      ? '<div class="guarantee-stat-divider"></div><p class="guarantee-stat-label">Backed by real practice data</p>' +
        '<p class="muted guarantee-stat-note">' + stats.passRate + '% of practice mock exams taken on PassExamHQ end in a passing score. ' +
        '<a href="#/pass-rates">See the real numbers, by category →</a></p>'
      : '';

    appEl.innerHTML =
      '<div class="guarantee-page">' +
      '<section class="guarantee-hero">' +
      '<div class="guarantee-hero-copy">' +
      '<span class="badge guarantee-hero-badge">🛡️ Two guarantees, in plain language</span>' +
      '<h1>Pass, or get ' + refundFailurePercent + '% back.</h1>' +
      '<p class="page-intro-text">We only sell prep we\'d stake our reputation on. Practice to the threshold, sit your ' +
      'official exam, and if you still don\'t pass, you get ' + refundFailurePercent + '% of your purchase back. Changed ' +
      'your mind early instead? A 7-day, no-questions-asked refund covers that too.</p>' +
      '<div class="guarantee-hero-cta">' +
      '<a class="btn-primary hub-hero-btn" href="/#tracks">Browse guaranteed tracks</a>' +
      '<a class="btn-secondary hub-hero-btn" href="#/refund">I need to file a claim</a>' +
      '</div>' +
      '</div>' +
      // Two stat cards, not one -- this page's whole job is explaining "the guarantee(s)," but its
      // own hero used to badge itself singular ("Pass Guarantee") and fold the 7-day refund into
      // one sentence, undersold relative to how guaranteeCtaBandHtml() frames both guarantees with
      // equal weight everywhere else on the site. Give the 7-day guarantee its own card here too.
      '<div class="guarantee-hero-stats">' +
      '<div class="guarantee-stat-card">' +
      '<div class="guarantee-stat-icon">🛡️</div>' +
      '<div class="guarantee-stat-value">' + refundFailurePercent + '%</div>' +
      '<p class="muted">money back if you meet the practice requirement and still don\'t pass</p>' +
      passRateNote +
      '</div>' +
      '<div class="guarantee-stat-card">' +
      '<div class="guarantee-stat-icon">📅</div>' +
      '<div class="guarantee-stat-value">7 Days</div>' +
      '<p class="muted">no-questions-asked refund if you change your mind early — no conditions to meet</p>' +
      '</div>' +
      '</div>' +
      '</section>' +
      '<section class="guarantee-eligibility">' +
      '<h2>How to qualify</h2>' +
      '<p class="muted page-intro-text">Three simple conditions — they exist so the guarantee protects people who actually did the work.</p>' +
      '<div class="guarantee-steps">' +
      guaranteeStepHtml(1, '📊', 'Practice to the threshold',
        'Maintain at least ' + progressAccuracyPassPct + '% Accuracy and ' + progressCoveragePassPct +
        '% Coverage in your practice here — a good-faith-effort requirement, not a formality.') +
      guaranteeStepHtml(2, '🎓', 'Take your official exam',
        'Sit the real exam through the official testing authority for your track.') +
      guaranteeStepHtml(3, '📝', 'Submit your claim',
        'File a refund request with your result — real-money purchases only, since a free or points-redeemed course has no purchase to refund.') +
      '</div>' +
      '</section>' +
      '<section class="guarantee-faq">' +
      '<h2>Refund questions</h2>' +
      '<dl class="guarantee-faq-list">' +
      guaranteeFaqHtml('What exactly do I get back?',
        refundFailurePercent + '% of what you paid for the track (or a full refund under the separate 7-day guarantee). ' +
        'Free or points-redeemed courses aren\'t eligible, since no cash was paid.') +
      guaranteeFaqHtml('How is a refund paid out?',
        'Once your claim is reviewed and approved, it\'s issued back to your original payment method through Stripe.') +
      guaranteeFaqHtml('What if I used a promo code or points?',
        'Any points or promo discount applied at checkout only reduces what you paid — the guarantee still covers whatever cash amount you actually paid.') +
      guaranteeFaqHtml('Which tracks are covered?',
        'Every active track — the same ' + refundFailurePercent + '% pass-or-refund guarantee and 7-day return window apply sitewide, not just select tracks.') +
      '</dl>' +
      '</section>' +
      '</div>';
  });
}
function guaranteeStepHtml(num, icon, title, body) {
  return '<div class="guarantee-step-card">' +
    '<span class="guarantee-step-num">' + num + '</span>' +
    '<div class="guarantee-step-icon">' + icon + '</div>' +
    '<h3>' + title + '</h3>' +
    '<p class="muted">' + body + '</p>' +
    '</div>';
}
function guaranteeFaqHtml(q, a) {
  return '<div class="guarantee-faq-item"><dt>' + q + '</dt><dd class="muted">' + a + '</dd></div>';
}

// Embeddable "Question of the Day" widget generator (#/embed) -- built 2026-09-02 as a real
// backlink/distribution lever: state subreddits, forums, and agent blogs can iframe-embed
// wwwroot/embed/qotd/index.html (a separate, self-contained static page, NOT part of this SPA --
// see that file for why) on their own site, with attribution back to the real track page. This
// page is just the "pick your track, get your <iframe> snippet" generator; the widget itself is
// served standalone and fetches GET /api/qotd?examType=... (passexamhq-api), which deterministically
// rotates through a track's real question pool once per UTC calendar day.
var embedPickedKind = '';
var embedPickedState = '';

function embedActiveKinds() {
  var kinds = [];
  HUB_EXAMS.forEach(function (e) { if (e.active && kinds.indexOf(e.examKind) === -1) kinds.push(e.examKind); });
  return kinds.sort(function (a, b) { return a.localeCompare(b); });
}

function embedPickerHtml() {
  var kindOptions = ['<option value="">Choose a category…</option>'].concat(
    embedActiveKinds().map(function (k) {
      return '<option value="' + escapeHtml(k) + '"' + (k === embedPickedKind ? ' selected' : '') + '>' + escapeHtml(k) + '</option>';
    })
  );
  var stateTracks = embedPickedKind ? categoryActiveTracks(embedPickedKind) : [];
  var stateOptions = ['<option value="">Choose a state…</option>'].concat(
    stateTracks.slice().sort(function (a, b) { return (STATE_LABELS[a.stateCode] || a.stateCode).localeCompare(STATE_LABELS[b.stateCode] || b.stateCode); })
      .map(function (t) {
        return '<option value="' + t.stateCode + '"' + (t.stateCode === embedPickedState ? ' selected' : '') + '>' +
          escapeHtml(STATE_LABELS[t.stateCode] || t.stateCode) + '</option>';
      })
  );
  return '<div class="card embed-picker">' +
    '<label class="gift-picker-field">Category' +
    '<select data-act="pick-embed-kind">' + kindOptions.join('') + '</select>' +
    '</label>' +
    '<label class="gift-picker-field">State' +
    '<select data-act="pick-embed-state"' + (embedPickedKind ? '' : ' disabled') + '>' + stateOptions.join('') + '</select>' +
    '</label>' +
    '</div>';
}

function embedResultHtml() {
  if (!embedPickedKind || !embedPickedState) return '';
  var track = categoryActiveTracks(embedPickedKind).filter(function (t) { return t.stateCode === embedPickedState; })[0];
  if (!track) return '';
  var src = location.origin + '/embed/qotd?examType=' + encodeURIComponent(track.examType);
  var snippet = '<iframe src="' + src + '" width="380" height="420" style="border:1px solid #ddd;border-radius:12px;max-width:100%;" loading="lazy" title="PassExamHQ Question of the Day"></iframe>';
  return '<div class="embed-result">' +
    '<h3>Your embed code</h3>' +
    '<textarea class="embed-snippet-box" readonly rows="3">' + escapeHtml(snippet) + '</textarea>' +
    '<button class="btn-secondary btn-sm" type="button" data-act="copy-embed-snippet" data-snippet="' + escapeHtml(snippet) + '">Copy snippet</button>' +
    '<h3>Live preview</h3>' +
    '<div class="embed-preview-frame">' + snippet + '</div>' +
    '</div>';
}

function renderEmbedGenerator() {
  embedPickedKind = '';
  embedPickedState = '';
  appEl.innerHTML = '<div class="narrow-page embed-generator-page"><h1>Embed a Question of the Day</h1>' +
    '<p class="muted page-intro-text">Add a real, rotating practice question to your site — a state subreddit, ' +
    'a forum, an agent blog — with a link back to the full question bank. A new question from the real pool ' +
    'shows automatically every day; no upkeep on your end.</p>' +
    '<div id="embed-picker-wrap">' + embedPickerHtml() + '</div>' +
    '<div id="embed-result-wrap">' + embedResultHtml() + '</div>' +
    '</div>';
}

// Public pass-rate transparency page (#/pass-rates) -- built 2026-09-02 as a marketing-ideas
// follow-on to renderGuarantee()'s own passRateNote, which only ever showed one sitewide number.
// Every figure here comes straight from /stats/public and /stats/pass-rates-by-category (real
// completed exam_attempts rows, scored against each attempt's own snapshotted pass_percent), same
// as the guarantee page -- nothing here is invented or hardcoded, per this site's standing
// no-fabricated-numbers rule. The one deliberate design choice: a category with fewer than
// minSampleSize completed attempts shows "Not enough data yet" instead of a percentage -- a
// sample-size gate only, never a value gate, so a real (if unflattering) rate is never hidden once
// there's enough data to trust it.
function renderPassRates() {
  appEl.innerHTML = '<div class="narrow-page"><h1>Pass Rate Transparency</h1><p class="muted">Loading…</p></div>';
  Promise.all([
    apiFetch('/stats/public').catch(function () { return null; }),
    apiFetch('/stats/pass-rates-by-category').catch(function () { return null; }),
  ]).then(function (results) {
    var overall = results[0];
    var byCategory = results[1];
    var minSample = (byCategory && byCategory.minSampleSize) || 20;

    var overallHtml = (overall && overall.passRate != null)
      ? '<div class="pass-rates-overall-card">' +
        '<div class="pass-rates-overall-value">' + overall.passRate + '%</div>' +
        '<p class="muted">of the ' + overall.examsCompleted.toLocaleString() + ' completed practice exams taken on PassExamHQ ended in a passing score (' + overall.examsPassed.toLocaleString() + ' of ' + overall.examsCompleted.toLocaleString() + ').</p>' +
        '</div>'
      : '<p class="muted">Not enough completed practice exams yet to show a sitewide number.</p>';

    var rows = ((byCategory && byCategory.categories) || []).map(function (cat) {
      var guideHref = cat.categorySlug ? '/guides/' + cat.categorySlug + '-requirements-by-state' : null;
      var rateCell = cat.passRate != null
        ? '<strong>' + cat.passRate + '%</strong>'
        : '<span class="guide-na">Not enough data yet</span>';
      return '<tr>' +
        '<td>' + escapeHtml(cat.kind) + '</td>' +
        '<td>' + cat.attemptCount.toLocaleString() + '</td>' +
        '<td>' + rateCell + '</td>' +
        '<td class="guide-table-cta">' +
        (cat.categorySlug ? '<a href="/' + cat.categorySlug + '">Practice ' + escapeHtml(cat.kind) + ' →</a>' : '') +
        '</td>' +
        '</tr>';
    }).join('');

    appEl.innerHTML =
      '<div class="pass-rates-page">' +
      '<span class="section-eyebrow">Real numbers, not marketing copy</span>' +
      '<h1>Pass Rate Transparency</h1>' +
      '<p class="page-intro-text">Every pass-rate figure on PassExamHQ — here and everywhere else on the site — reflects practice ' +
      'mock exams completed <em>on PassExamHQ itself</em>, computed live from our own database. It is not, and cannot be, a claim ' +
      'about real official exam outcomes: no testing vendor or state licensing board shares that data with prep providers, so any ' +
      'site claiming an official pass rate is estimating or making it up. What you see below is the one number we can actually ' +
      'measure honestly, shown with the real sample sizes behind it.</p>' +
      overallHtml +
      '<h2 class="comparison-heading">By Category</h2>' +
      '<p class="muted">Categories with fewer than ' + minSample + ' completed exams show "Not enough data yet" instead of a ' +
      'percentage — a rate computed from a handful of attempts is too noisy to mean anything, regardless of which way it points. ' +
      'We never hide a real rate just because it looks bad once there\'s enough data behind it.</p>' +
      '<div class="guide-table-wrap">' +
      '<table class="guide-table">' +
      '<thead><tr><th>Category</th><th>Completed Exams</th><th>Pass Rate</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '</div>' +
      '<p class="guide-source-note">Only fully completed (submitted) practice exams count. Each attempt is scored against the ' +
      'passing threshold that applied to it at the time it was taken. See our <a href="#/guarantee">pass-or-refund guarantee</a> ' +
      'for what this backs, or browse per-state exam mechanics on our <a href="/guides/notary-requirements-by-state">requirements-by-state guides</a>.</p>' +
      '</div>';
  });
}

// Public exam-mechanics changelog (#/changelog) -- marketing round 3, item #1. Real, dated
// corrections only (see examprep-api's track_registry_changelog schema comment for why this can
// never contain a fabricated/backfilled history): a row only exists here because an admin actually
// changed a track's real mechanics via the console, with a mandatory reason. A visitor with no
// entries yet sees an honest empty state, not padded content.
var CHANGELOG_FIELD_LABELS = {
  exam_question_count: 'Question count', exam_duration_sec: 'Exam duration',
  pass_percent: 'Passing score', min_correct: 'Minimum correct',
};
function changelogValueLabel(field, value) {
  if (value == null) return '—';
  if (field === 'exam_duration_sec') return Math.round(Number(value) / 60) + ' min';
  if (field === 'pass_percent') return value + '%';
  return value;
}
function renderChangelog() {
  appEl.innerHTML = '<div class="narrow-page"><h1>Exam Mechanics Changelog</h1><p class="muted">Loading…</p></div>';
  apiFetch('/changelog').then(function (res) {
    var items = (res && res.items) || [];
    var rows = items.map(function (it) {
      var trackHref = (it.kind && HUB_KIND_SLUGS[it.kind] && it.stateCode)
        ? '/' + kindSlug(it.kind) + '/' + it.stateCode.toLowerCase() : null;
      var trackLabelHtml = trackHref ? '<a href="' + trackHref + '">' + escapeHtml(it.trackLabel) + '</a>' : escapeHtml(it.trackLabel);
      var fieldLabel = CHANGELOG_FIELD_LABELS[it.field] || it.field;
      return '<div class="card changelog-entry">' +
        '<div class="changelog-entry-top"><strong>' + trackLabelHtml + '</strong>' +
        '<span class="muted">' + new Date(it.changedAt * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) + '</span></div>' +
        '<p class="changelog-entry-change">' + escapeHtml(fieldLabel) + ': ' + escapeHtml(changelogValueLabel(it.field, it.oldValue)) +
        ' → <strong>' + escapeHtml(changelogValueLabel(it.field, it.newValue)) + '</strong></p>' +
        '<p class="muted changelog-entry-reason">' + escapeHtml(it.reason) + '</p>' +
        '</div>';
    }).join('');

    appEl.innerHTML =
      '<div class="narrow-page changelog-page">' +
      '<span class="section-eyebrow">Real, dated corrections</span>' +
      '<h1>Exam Mechanics Changelog</h1>' +
      '<p class="page-intro-text">Every question count, time limit, and passing score on PassExamHQ is sourced from the current ' +
      'official handbook or statute for that state. When we catch a real correction — a source we misread, a bulletin the state ' +
      'updated — it\'s logged here, with the reason, rather than silently edited. ' +
      (items.length ? 'This log currently covers ' + items.length + ' correction' + (items.length === 1 ? '' : 's') + '.' :
        'Nothing has needed correcting yet — this page will show real entries as they happen.') + '</p>' +
      (rows || '<p class="muted">No corrections logged yet.</p>') +
      '</div>';
  });
}

// A code redeemed with no email ever provided (buyer_email null) has no way to look up referral
// points -- accounts is a separate, email-keyed table with no FK to users -- so this renders that
// gracefully as a nudge toward the referral flow rather than an error or a blank section.
function renderProfile() {
  if (!getToken()) {
    appEl.innerHTML = '<div class="narrow-page"><h1>My Profile</h1>' +
      '<p class="muted">You\'re not logged in on this device. <a href="/">Enter your access code</a> to see your profile.</p>' +
      '<button class="btn-secondary btn-sm" type="button" data-act="go-back">← Back</button></div>';
    return;
  }
  appEl.innerHTML = '<div class="narrow-page"><h1>My Profile</h1><p class="muted">Loading…</p></div>';
  apiFetch('/profile').then(function (p) {
    var track = trackByExamType(p.examType);
    var trackTitle = (track && track.title) || p.examType;
    var trackRoute = (track && track.route) || '/';
    var memberSince = p.createdAt ? new Date(p.createdAt * 1000).toLocaleDateString() : '—';
    var purchaseLine = p.paidCents ? '$' + (p.paidCents / 100).toFixed(2) + ' (one-time)' : 'Free / points / admin-issued';
    var emailSection = p.buyerEmail
      ? '<div class="profile-row"><span class="muted">Email on file</span><span>' + escapeHtml(p.buyerEmail) + '</span></div>' +
        '<div class="profile-row"><span class="muted">Referral points</span><span>' + (p.points || 0) + ' — <a href="' + trackRoute + '#/refer">Refer a friend →</a></span></div>'
      : '<p class="muted">No email on file, so we can\'t show referral points here — that needs an email to look up. ' +
        '<a href="' + trackRoute + '#/refer">Add one via the referral page</a> to start earning points.</p>';
    appEl.innerHTML = '<div class="narrow-page"><h1>My Profile</h1>' +
      '<div class="card profile-card">' +
      '<div class="profile-row"><span class="muted">Track</span><strong>' + escapeHtml(trackTitle) + '</strong></div>' +
      '<div class="profile-row"><span class="muted">Access code</span><span>' +
      (p.code ? '<code>' + escapeHtml(p.code) + '</code> <button class="btn-secondary btn-sm" type="button" data-act="copy-code" data-code="' + escapeHtml(p.code) + '">Copy code</button>' : '—') +
      '</span></div>' +
      '<div class="profile-row"><span class="muted">Member since</span><span>' + memberSince + '</span></div>' +
      '<div class="profile-row"><span class="muted">Purchase</span><span>' + purchaseLine + '</span></div>' +
      '</div>' +
      '<div class="card profile-card">' + emailSection + '</div>' +
      '<a class="btn-secondary hub-cta" href="' + trackRoute + '#/progress">View full progress →</a> ' +
      '<button class="btn-secondary btn-sm" type="button" data-act="log-out">Log out</button></div>';
  }).catch(function (e) {
    appEl.innerHTML = '<div class="narrow-page"><h1>My Profile</h1>' + examErrorHtml(e, 'Could not load your profile. Try again shortly.') +
      '<button class="btn-secondary btn-sm" type="button" data-act="go-back">← Back</button></div>';
  });
}

// ---- Views --------------------------------------------------------------

// Content only (title/category/route/duration/questions/passScore/description/breakdown) -- kept
// as static JS since it's rich prose, not simple facts, and migrating it to D1 would need real
// admin CRUD for long-form text (out of scope for the 2026-08-30 track_registry migration).
// examType is kept as the join key against track_registry's identity fields (kind/state_code/
// short_name/active), same as it's already the join key in the pricing/questions tables -- HUB_EXAMS
// itself (below) is built by merging this with track_registry at boot, not assigned directly.
var HUB_EXAMS_CONTENT = [
  {
    examType: 'ca_notary',
    title: 'California Notary Public Exam', category: 'State Licensing', route: '/notary/ca',
    duration: '60 Minutes', questions: '45 Multiple Choice', passScore: '70% (Scaled Score 70+)',
    description: 'Practice questions covering the California notary handbook: statutory fees, thumbprint rules, journal requirements, and civil/criminal misconduct exposure.',
    // Rebuilt 2026-09-01 directly from the CA Secretary of State's own January 2026 Notary Public
    // Handbook (fetched from notary.cdn.sos.ca.gov/forms/notary-handbook-current.pdf), matching its
    // actual "General Information" section structure (pp. 7-27) rather than the old generic 4-bucket
    // template. CA publishes no official exam blueprint/topic weighting -- these percentages are
    // this handbook's own body-text proportion per section (page space per section / total body page
    // space), not a state-disclosed weighting. The old "Fees, Misconduct & Conflict of Interest"
    // bucket at 35% was overweighted relative to the real handbook (~15%), and Identification /
    // Satisfactory Evidence -- one of the handbook's densest, most-tested topics (ID-document tiers,
    // credible-witness rules, pp. 9-10) -- had no bucket of its own at all, buried inside a generic
    // "Application, Commission & Misc" line.
    breakdown: [['Appointment, Qualifications & Commission Administration', '14%'], ['Seal, Identification & Journal Requirements', '14%'], ['Acknowledgments, Jurats & Certifications', '37%'], ['Fees, Advertising & Discipline', '15%'], ['Common Questions & Scenarios', '20%']],
  },
  {
    examType: 'ca_driver',
    title: 'California Driver Knowledge Test (Class C)', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ca',
    duration: 'Untimed', questions: '46 Multiple Choice', passScore: '38/46 Correct (~83%)',
    description: 'Practice questions covering the 2025 California DMV Driver\'s Handbook, weighted by its own real section structure: licensing and introduction to driving, navigating the roads (signs, signals and markings), laws and rules of the road, safe driving, and alcohol/drugs, financial responsibility and other DMV requirements (registration, driver safety, seniors) for the Class C written permit test.',
    breakdown: [['Licensing & Introduction to Driving', '15%'], ['Navigating the Roads (Signs, Signals & Markings)', '24%'], ['Laws & Rules of the Road', '29%'], ['Safe Driving', '18%'], ['Alcohol, Drugs, Financial Responsibility & DMV Requirements', '14%']],
  },
  {
    examType: 'ca_cdl',
    title: 'California CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ca',
    duration: 'Untimed', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the California Commercial Driver Handbook (DMV), weighted by its own real section lengths: the General Knowledge test content (CDL rules, driving safely, transporting cargo safely) required of all applicants, the Air Brakes/Combination Vehicles/Doubles-Triples tests, the Passenger/School Bus/Tank Vehicle/HazMat endorsement tests, and Vehicle Inspection Test procedures -- for Class A/B commercial permits and endorsements.',
    breakdown: [['General Knowledge (CDL Rules, Safe Driving & Cargo)', '48%'], ['Air Brakes, Combination Vehicles & Doubles/Triples', '19%'], ['Passenger, School Bus, Tank & HazMat Endorsements', '27%'], ['Vehicle Inspection Procedures', '6%']],
  },
  {
    examType: 'ca_motorcycle',
    title: 'California Motorcycle Knowledge Test (M1/M2)', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/ca',
    duration: 'Untimed', questions: '25 Multiple Choice', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the 2024 California DMV Motorcycle Handbook, weighted by its own real section structure: license requirements and preparing to ride, basic vehicle control/lane position/SEE strategy, collision avoidance/hazards/mechanical problems/group riding, and alcohol/DUI/insurance law for the M1/M2 written knowledge test.',
    breakdown: [['License Requirements & Preparing to Ride', '29%'], ['Basic Vehicle Control, Lane Position & SEE Strategy', '31%'], ['Collision Avoidance, Hazards, Mechanical Problems & Group Riding', '29%'], ['Alcohol, DUI & Insurance Law', '11%']],
  },
  {
    examType: 'tx_driver',
    title: 'Texas Driver License Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/tx',
    duration: 'Untimed', questions: '30 Multiple Choice', passScore: '21/30 Correct (70%)',
    description: 'Practice questions covering the Texas Driver Handbook (DPS), weighted by its own real 14-chapter structure: licensing and testing, vehicle inspection/registration/safety responsibility and right-of-way, traffic signs/signals/markers and driving maneuvers, special driving situations, alcohol/drugs/crashes and pedestrian/bicycle safety, and additional safety tips.',
    breakdown: [['Licensing, Testing & Application', '21%'], ['Vehicle Inspection/Registration, Safety Responsibility & Right-of-Way', '15%'], ['Traffic Signs, Signals, Markers & Driving Maneuvers', '32%'], ['Special Driving Situations', '12%'], ['Alcohol/Drugs, Crashes & Pedestrian/Bicycle Safety', '13%'], ['Additional Safety Tips', '7%']],
  },
  {
    examType: 'tx_cdl',
    title: 'Texas CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/tx',
    duration: 'Untimed', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Texas Commercial Motor Vehicle Driver Handbook (DPS, AAMVA content, revised March 2026), weighted by its own real section lengths: the General Knowledge test content (CDL rules, driving safely, transporting cargo safely, and Texas-specific vehicle lighting/equipment requirements) required of all applicants, the Air Brakes/Combination Vehicles/Doubles-Triples tests, the Passenger/School Bus/Tank Vehicle/HazMat endorsement tests, and Vehicle Inspection Test procedures -- for Class A/B commercial permits and endorsements.',
    breakdown: [['General Knowledge (CDL Rules, Safe Driving, Cargo & TX Vehicle Requirements)', '39%'], ['Air Brakes, Combination Vehicles & Doubles/Triples', '14%'], ['Passenger, School Bus, Tank & HazMat Endorsements', '34%'], ['Vehicle Inspection Procedures', '13%']],
  },
  {
    examType: 'fl_driver',
    title: 'Florida Class E Knowledge Exam', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/fl',
    duration: 'Untimed', questions: '50 Multiple Choice', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Florida Driver License Handbook (FLHSMV), weighted by its own real 10-chapter section structure: driver licenses/IDs and testing, driver fitness/vehicle equipment/registration and traffic controls, driving safety/rules of the road/special situations and sharing the road, and your driving privilege (insurance, DUI, points and suspensions) for the Class E Knowledge Exam.',
    breakdown: [['Driver Licenses, IDs & Testing', '23%'], ['Driver Fitness, Vehicle Equipment/Registration & Traffic Controls', '30%'], ['Driving Safety, Rules of the Road, Special Situations & Sharing the Road', '36%'], ['Your Driving Privilege (Insurance, DUI, Points & Suspensions)', '11%']],
  },
  {
    examType: 'fl_cdl',
    title: 'Florida CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/fl',
    duration: 'Untimed', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Florida Commercial Driver License Handbook (FLHSMV), weighted by its own real section lengths: the General Knowledge test content (CDL rules, driving safely, transporting cargo safely) required of all applicants, the Air Brakes/Combination Vehicles/Doubles-Triples tests, the Passenger/School Bus/Tank Vehicle/HazMat endorsement tests, and Vehicle Inspection Test procedures -- for Class A/B/C commercial permits and endorsements.',
    breakdown: [['General Knowledge (CDL Rules, Safe Driving & Cargo)', '42%'], ['Air Brakes, Combination Vehicles & Doubles/Triples', '19%'], ['Passenger, School Bus, Tank & HazMat Endorsements', '32%'], ['Vehicle Inspection Procedures', '7%']],
  },
  {
    examType: 'ny_driver',
    title: 'New York Driver License Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ny',
    duration: 'Untimed', questions: '20 Multiple Choice', passScore: '14/20 Correct (70%)',
    description: 'Practice questions covering the New York State Driver\'s Manual: licensing and learner permit rules, right-of-way and traffic control, passing/parking/defensive driving, and impairment and crash-reporting law for the Class D written knowledge test.',
    breakdown: [['Driver Licensing & Learner Permits', '17%'], ['License Sanctions, Vehicle Ownership & Right-of-Way', '27%'], ['Passing, Parking & Defensive Driving', '20%'], ['Impairment, Special Conditions & Sharing the Road', '36%']],
  },
  {
    examType: 'ny_cdl',
    title: 'New York CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ny',
    duration: 'Untimed', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the New York State Commercial Driver\'s Manual (CDL-10), weighted by its own real section lengths: the General Knowledge test content (CDL rules, driving safely, transporting cargo safely) required of all applicants, the Air Brakes/Combination Vehicles/Doubles-Triples tests, the Passenger/School Bus/Tank Vehicle/HazMat endorsement tests, and Vehicle Inspection Test procedures -- for Class A/B commercial permits and endorsements.',
    breakdown: [['General Knowledge (CDL Rules, Safe Driving & Cargo)', '45%'], ['Air Brakes, Combination Vehicles & Doubles/Triples', '19%'], ['Passenger, School Bus, Tank & HazMat Endorsements', '29%'], ['Vehicle Inspection Procedures', '7%']],
  },
  {
    examType: 'ny_notary',
    title: 'New York Notary Public Exam', category: 'State Licensing', route: '/notary/ny',
    duration: '60 Minutes', questions: '40 Multiple Choice', passScore: '70% (28/40 Correct)',
    description: 'Practice questions covering the New York Notary Public License Law: appointment and professional conduct, powers and duties, statutory fees, real property acknowledgments, and the rules and regulations governing notaries.',
    // Rebuilt 2026-08-17 directly from the NY DOS's own March 2026 Notary Public License Law
    // booklet (local copy: temp/handbooks/ny/notary.txt), matching its actual section structure
    // rather than a generic 4-bucket template. NY publishes no official exam blueprint/topic
    // weighting -- these percentages are this booklet's own body-text proportion per section
    // (line count per section / total body line count), not a state-disclosed weighting. "Real
    // Property Law" is a real, standalone top-level section of this law (Real Property Law
    // §298-333: acknowledgments and proofs), not a stray real-estate-track leftover -- NY notaries
    // routinely acknowledge deeds/mortgages, and the booklet itself quotes case law on exactly that.
    breakdown: [['Appointment & Qualifications (Executive Law §130–133)', '15%'], ['Powers & Duties, Fees & Advertising (Executive Law §134–138, 142-a)', '29%'], ['Real Property Law: Acknowledgments & Proofs (§298–333)', '16%'], ['Restrictions, Violations & Penal Law (Judiciary Law §484–485)', '11%'], ['Electronic Notarization & Recordkeeping (19 NYCRR Part 182)', '29%']],
  },
  {
    examType: 'il_driver',
    title: 'Illinois Driver License Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/il',
    duration: 'Untimed', questions: '35 Multiple Choice', passScore: '28/35 Correct (80%)',
    description: 'Practice questions covering the Illinois Rules of the Road: licensing and exam procedures, roadway signs and signals, traffic laws, safe driving and vehicle ownership, sharing the road, and young-driver/DUI license sanctions for the Class D written knowledge test.',
    breakdown: [['Licensing & Exams', '12%'], ['Roadway Signs, Signals & Traffic Laws', '40%'], ['Safe Driving, Equipment & Vehicle Ownership', '19%'], ['Sharing the Road, Crash Procedures, Young Drivers & DUI', '29%']],
  },
  {
    examType: 'il_re_salesperson',
    title: 'Illinois Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/il',
    duration: '90 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '75% (30/40 Correct)',
    description: 'Practice questions covering the Illinois Real Estate License Act of 2000 (225 ILCS 454): licensing requirements, the License Act itself, additional Illinois laws affecting real estate practice, and required disclosures — the state-specific portion of the Broker exam.',
    breakdown: [['Licensing Requirements', '10%'], ['Illinois Real Estate License Act', '40%'], ['Additional Illinois Laws & Regulations', '25%'], ['Disclosures', '25%']],
  },
  {
    examType: 'il_re_broker',
    title: 'Illinois Managing Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/il',
    duration: '90 Minutes', questions: '50 Multiple Choice', passScore: '75% or Higher',
    description: 'Practice questions covering the Illinois Real Estate License Act of 2000 (225 ILCS 454) for the Managing Broker upgrade credential, scoped to PSI/IDFPR\'s own official Candidate Information Booklet state-specific Content Outline for the Managing Broker exam: licensing requirements, the Illinois Real Estate License Act (agency, advertising, sponsored-licensee relationships, teams, handling of monies/documents, disciplinary provisions), additional Illinois laws and regulations (ownership interests, transfer of title, real estate taxes, fair housing/landlord-tenant statutes), disclosures, and the Managing Broker-only topics (sponsoring-broker supervision, special/escrow accounts, examination of records, licensure by endorsement, real estate calculations and financing/lending).',
    breakdown: [['Licensing Requirements', '5%'], ['Illinois Real Estate License Act', '30%'], ['Additional Illinois Laws & Regulations', '15%'], ['Disclosures', '10%'], ['Managing Broker Supervisory Duties, Special Accounts, Records & Calculations', '40%']],
  },
  {
    examType: 'pa_driver',
    title: 'Pennsylvania Driver\'s License Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/pa',
    duration: 'Untimed', questions: '18 Multiple Choice', passScore: '15/18 Correct (83.3%)',
    description: 'Practice questions covering the Pennsylvania Driver\'s Manual (PennDOT, PUB 95), weighted by its own real 6-chapter page structure: introduction/learner\'s permit and driving record, signals/signs/pavement markings, everyday driving skills, special circumstances/emergencies and related laws, for the non-commercial written knowledge test.',
    breakdown: [['Introduction, Learner\'s Permit & Driving Record', '18%'], ['Signals, Signs & Pavement Markings', '23%'], ['Everyday Driving Skills', '33%'], ['Special Circumstances, Emergencies & Related Laws', '26%']],
  },
  {
    examType: 'pa_cdl',
    title: 'Pennsylvania CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/pa',
    duration: 'Untimed', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Pennsylvania Commercial Driver\'s Manual (PennDOT, PUB223), weighted by its own real section lengths: the General Knowledge test content (Sections 1-3: introduction, driving safely, transporting cargo safely) required of all applicants, the Air Brakes/Combination Vehicles/Doubles-Triples tests, the Passenger/Tank Vehicle/HazMat endorsement tests, and Vehicle Inspection Test procedures -- for Class A/B/C commercial permits and endorsements.',
    breakdown: [['General Knowledge (Introduction, Driving Safely & Cargo)', '48%'], ['Air Brakes, Combination Vehicles & Doubles/Triples', '22%'], ['Passenger, Tank & Hazardous Materials Endorsements', '22%'], ['Vehicle Inspection Procedures', '8%']],
  },
  {
    examType: 'pa_re_salesperson',
    title: 'Pennsylvania Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/pa',
    duration: '60 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '75% (30/40 Correct)',
    description: 'Practice questions covering 49 Pa. Code Chapter 35 (State Real Estate Commission regulations): the Real Estate Commission, licensure, agency and disclosure, regulations governing licensee activities, and miscellaneous topics — the state-specific portion of the Salesperson exam.',
    breakdown: [['Real Estate Commission & Licensure', '33%'], ['Agency and Disclosure', '25%'], ['Regulations Governing the Activities of Licensees', '27%'], ['Miscellaneous', '15%']],
  },
  {
    examType: 'ca_re_salesperson',
    title: 'California Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ca',
    duration: '3 Hours 15 Minutes', questions: '150 Multiple Choice', passScore: '70% (105/150 Correct)',
    description: 'Practice questions covering the California Real Estate Law (Business and Professions Code, Division 4), scoped to DRE\'s own official RE 425 exam content outline: property ownership and land use, agency and fiduciary duties, valuation, financing, transfer of property, practice/disclosures, and contracts.',
    breakdown: [['Property Ownership & Land Use Controls', '15%'], ['Agency & Fiduciary Duties', '17%'], ['Valuation, Financing & Transfer of Property', '31%'], ['Practice of Real Estate, Disclosures & Contracts', '37%']],
  },
  {
    examType: 'ca_re_broker',
    title: 'California Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ca',
    duration: '4 Hours', questions: '200 Multiple Choice', passScore: '75% (150/200 Correct)',
    description: 'Practice questions covering the California Real Estate Law (Business and Professions Code, Division 4) at broker level, scoped to the DRE\'s own official RE 425 exam content outline: property ownership and land use, agency and fiduciary duties, valuation, financing, transfer of property, practice/disclosures (including trust fund handling, agency supervision and property management), and contracts. DRE\'s RE 425 form states this same seven-area outline and the same area percentages apply to both the salesperson and broker exams -- the exams "differ in emphasis and difficulty," not in content weighting, so the broker exam tests these identical areas in greater depth (broker-level supervision, trust accounting, commercial/specialty content) rather than against a different percentage breakdown.',
    breakdown: [['Property Ownership & Land Use Controls', '15%'], ['Agency & Fiduciary Duties', '17%'], ['Valuation, Financing & Transfer of Property', '31%'], ['Practice of Real Estate, Disclosures & Contracts', '37%']],
  },
  {
    examType: 'oh_driver',
    title: 'Ohio Driver License Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/oh',
    duration: 'Untimed', questions: '40 Multiple Choice', passScore: '30/40 Correct (75%)',
    description: 'Practice questions covering the current Ohio Driver\'s Manual (BMV), weighted by its own real 13-section page structure: licensing process and requirements, rules of the road and driving maneuvers, sharing the road and emergency preparedness, and vehicle safety, impairment and penalties for the Class D written knowledge test.',
    breakdown: [['Licensing Process & Requirements', '26%'], ['Rules of the Road & Driving Maneuvers', '29%'], ['Sharing the Road & Emergency Preparedness', '20%'], ['Vehicle Safety, Impairment & Penalties', '25%']],
  },
  {
    examType: 'oh_cdl',
    title: 'Ohio CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/oh',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Ohio CDL Manual (BMV, 2025 AAMVA content), weighted by its own real 13-section lengths: the General Knowledge test content (CDL rules, driving safely, transporting cargo safely) required of all applicants, the Air Brakes/Combination Vehicles/Doubles-Triples tests, the Passenger/School Bus/Tank Vehicle/HazMat endorsement tests, and Vehicle Inspection Test procedures -- for Class A/B commercial permits and endorsements.',
    breakdown: [['General Knowledge (CDL Rules, Safe Driving & Cargo)', '43%'], ['Air Brakes, Combination Vehicles & Doubles/Triples', '19%'], ['Passenger, School Bus, Tank & HazMat Endorsements', '28%'], ['Vehicle Inspection Procedures', '10%']],
  },
  {
    examType: 'oh_motorcycle',
    title: 'Ohio Motorcycle Written Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/oh',
    duration: 'Untimed', questions: '40 Multiple Choice', passScore: '30/40 Correct (75%)',
    description: 'Practice questions covering the current Ohio Motorcycle Operator Manual (Motorcycle Ohio / ODPS), weighted by its own real section structure: basic operation, cornering and braking, gear, rider readiness and impairment, licensing, testing and Ohio law, and street strategies for special situations for the motorcycle written knowledge test.',
    breakdown: [['Basic Operation, Cornering & Braking', '44%'], ['Gear, Rider Readiness & Impairment', '25%'], ['Licensing, Testing & Ohio Law', '10%'], ['Street Strategies & Special Situations', '21%']],
  },
  {
    examType: 'oh_re_salesperson',
    title: 'Ohio Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/oh',
    duration: '60 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '28/40 Correct (70%)',
    description: 'Practice questions covering Ohio Revised Code Chapter 4735 (Real Estate Brokers) and Ohio Administrative Code Chapter 1301:5, scoped and weighted to PSI\'s own official Ohio Real Estate Salesperson and Broker Candidate Information Bulletin state-specific content outline (40 scored items: State Governance 4, Licensing Requirements 6, License Law & Rules 16, Brokerage Relationships/Agency Law 14): state governance, discipline and the Recovery Fund, licensing requirements and continuing education, license law and Commission rules (advertising, trust accounts, commissions, property management, listings), and brokerage relationships/agency law -- the 40-question, 60-minute, 70%-to-pass state-specific portion of the PSI-administered Salesperson exam.',
    breakdown: [['Licensing Requirements & Continuing Education', '15%'], ['State Governance, Discipline & Recovery Fund', '10%'], ['License Law & Commission Rules (Advertising, Trust Accounts, Property Management)', '40%'], ['Brokerage Relationships & Agency Law', '35%']],
  },
  {
    examType: 'oh_boating',
    title: 'Ohio Boater Education Certification Exam', category: 'Boating & Watercraft Safety', route: '/boating/oh',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the Ohio Boat Operators Guide (ODNR Division of Parks & Watercraft), weighted by the real guide\'s own page structure: registration, titling and required equipment, federal regulations and aids to navigation, navigation rules and lights, and Ohio operating laws, vessel accidents, state parks regulations and boating and the environment (invasive species, fueling, waste discharge) -- modeled on the common format used by NASBLA/ODNR-approved boater education course providers.',
    breakdown: [['Registration, Titling & Required Equipment', '29%'], ['Federal Regulations & Aids to Navigation', '15%'], ['Navigation Rules & Navigation Lights', '18%'], ['Ohio Operating Laws, Vessel Accidents, State Parks Regulations & Environment', '38%']],
  },
  {
    examType: 'ga_driver',
    title: 'Georgia Driver License Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ga',
    duration: 'Untimed', questions: '40 Multiple Choice', passScore: '30/40 Correct (75%)',
    description: 'Practice questions covering the 2023-2024 Georgia Driver\'s Manual (Department of Driver Services), weighted by its own real chapter page-space: general licensing and obtaining a license, permit or ID card, testing information and other DDS services, traffic laws, teen driving laws and signs/signals/markings, safety guidelines and sharing the road, and losing driving privileges and crashes for the DDS written knowledge test.',
    breakdown: [['Licensing, Obtaining a License, Testing & Other Services', '26%'], ['Traffic Laws', '18%'], ['Teen Driving Laws & Signs, Signals and Markings', '24%'], ['Safety Guidelines & Sharing the Road', '16%'], ['Losing Driving Privileges & Crashes', '16%']],
  },
  {
    examType: 'ga_cdl',
    title: 'Georgia CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ga',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Georgia CDL Manual/Study Guide (Department of Driver Services, AAMVA-based content): the General Knowledge test content (CDL rules, driving safely, transporting cargo safely) required of all applicants, the Air Brakes/Combination Vehicles/Doubles-Triples tests, the Passenger/School Bus/Tank Vehicle/HazMat endorsement tests, and Vehicle Inspection Test procedures -- for Class A/B commercial permits and endorsements.',
    breakdown: [['General Knowledge (CDL Rules, Safe Driving & Cargo)', '43%'], ['Air Brakes, Combination Vehicles & Doubles/Triples', '17%'], ['Passenger, School Bus, Tank & HazMat Endorsements', '33%'], ['Vehicle Inspection Procedures', '7%']],
  },
  {
    examType: 'ga_motorcycle',
    title: 'Georgia Motorcycle Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/ga',
    duration: '30 Minutes', questions: '25 Multiple Choice', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the Georgia Motorcycle Operator\'s Manual (Department of Driver Services), weighted by its own real chapter page-space: DDS motorcycle training and rider licensing/permits, impairment/gear and pre-ride preparation, vehicle control and braking skills, street strategies and special riding situations, and passengers/group riding/multi-track vehicles for the DDS motorcycle knowledge test.',
    breakdown: [['Licensing, Permits & Training', '44%'], ['Street Strategies & Special Riding Situations', '24%'], ['Impairment, Gear & Pre-Ride Preparation', '11%'], ['Vehicle Control & Braking Skills', '5%'], ['Passengers, Group Riding & Multi-Track Vehicles', '16%']],
  },
  {
    examType: 'ga_re_salesperson',
    title: 'Georgia Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ga',
    duration: '120 Minutes', questions: '52 Multiple Choice (State-Specific Portion)', passScore: '39/52 Correct (75%)',
    description: 'Practice questions covering the Georgia Salesperson Supplement Examination, scoped to GREC/PSI\'s own official Candidate Information Bulletin content outline (52 confirmed items: 16 State Laws and Rules, 21 Real Estate Practice in Georgia, 15 Finance and Closing) -- the state-specific portion of the Salesperson exam, covering the Georgia Real Estate Commission Rules (Chapter 520) and O.C.G.A. Title 43, Chapter 40: unfair practices, substantive regulations, qualifications and fees, fair housing laws, the Real Estate Education/Research/Recovery Fund, investigation and hearing process, commission organization and procedures, required licensure, real estate practice, sales contracts, listings and agency, property management, community association management, finance, and closing procedures.',
    breakdown: [['State Laws and Rules', '31%'], ['Real Estate Practice in Georgia', '40%'], ['Finance and Closing', '29%']],
  },
  {
    examType: 'nc_driver',
    title: 'North Carolina Driver License Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/nc',
    duration: 'Untimed', questions: '37 Multiple Choice (Knowledge + Road Signs)', passScore: '29/37 Correct (78.4%)',
    description: 'Practice questions covering the North Carolina Driver\'s Handbook by its own real 7-chapter structure: licensing, permits and required documents, alcohol and the law, points and license consequences, driver safety and basic driving skills, defensive driving/hazards/emergencies, signals/signs/pavement markings, sharing the road, and vehicle registration/insurance/DMV services -- for both the NC DMV general knowledge test and the required road-sign identification test.',
    breakdown: [['Licensing, Permits & Required Documents', '24%'], ['Alcohol, Points & License Consequences', '9%'], ['Driver Safety & Basic Driving Skills', '30%'], ['Defensive Driving, Hazards & Emergencies', '13%'], ['Signals, Signs & Pavement Markings', '10%'], ['Sharing the Road', '7%'], ['Registration, Insurance & DMV Services', '7%']],
  },
  {
    examType: 'nc_cdl',
    title: 'North Carolina CDL (Commercial Driver\'s License) Exam', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/nc',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the North Carolina CDL Manual (2005 CDL Testing System, AAMVA), weighted by its own real section lengths: the General Knowledge test content (CDL rules/licensing, driving safely, transporting cargo safely) required of all applicants, the Air Brakes/Combination Vehicles/Doubles-Triples tests, the Passenger/Tank Vehicle/HazMat/School Bus endorsement tests, and Vehicle Inspection Test procedures -- for Class A/B commercial permits and endorsements.',
    breakdown: [['General Knowledge (CDL Rules, Driving Safely & Cargo)', '41%'], ['Air Brakes, Combination Vehicles & Doubles/Triples', '15%'], ['Passenger, Tank, HazMat & School Bus Endorsements', '39%'], ['Vehicle Inspection Procedures', '5%']],
  },
  {
    examType: 'nc_re_salesperson',
    title: 'North Carolina Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/nc',
    duration: '120 Minutes', questions: '60 Multiple Choice (State-Specific Portion)', passScore: '45/60 Correct (75%)',
    description: 'Practice questions covering the North Carolina Real Estate License Law and Commission Rules, scoped and weighted to the North Carolina Real Estate Commission and Pearson VUE\'s own official Examination Content Outline (Real Estate Licensing in North Carolina, April 2026 ed.) for the 60-item State Section: Licensure, Agency, Supervision/Compensation, Brokerage Practice, Taxes/Insurance, Contracts/Closing, Landlord/Tenant, and Other NC Laws -- the state-specific portion of the Pearson VUE-administered Broker exam (North Carolina\'s entry-level real estate license is called "Broker," not "Salesperson").',
    breakdown: [['Licensure', '5%'], ['Agency', '27%'], ['Supervision/Compensation', '7%'], ['Brokerage Practice', '20%'], ['Taxes/Insurance', '6%'], ['Contracts/Closing', '12%'], ['Landlord/Tenant', '5%'], ['Other NC Laws', '18%']],
  },
  {
    examType: 'nc_notary',
    title: 'North Carolina Notary Public Exam', category: 'State Licensing', route: '/notary/nc',
    duration: 'Untimed', questions: '50 Multiple Choice (237-Question Practice Pool)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the North Carolina Notary Public Act (General Statutes Chapter 10B), weighted by each Article/Part\'s real statutory text length: general provisions and commissioning, notarial acts, powers, limitations and fees, electronic and remote notarization (Article 2, including the large Remote Electronic Notarization provisions), signature, seal and certificate forms, and changes in status, enforcement and validation -- grounded in the statutory 80% pass threshold set by G.S. 10B-8.',
    breakdown: [['General Provisions & Commissioning', '17%'], ['Notarial Acts, Powers, Limitations & Fees', '18%'], ['Electronic & Remote Notarization', '34%'], ['Signature, Seal & Certificate Forms', '14%'], ['Changes in Status, Enforcement & Validation', '17%']],
  },
  {
    examType: 'nc_boating',
    title: 'North Carolina Boater Education Certification Exam', category: 'Boating & Watercraft Safety', route: '/boating/nc',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the North Carolina Vessel Operator\'s Guide: registration, safety education and required equipment, boating accidents, rules of the road and regulations, operation of vessels, PWC and water sports, and inland lighting rules and waterway markers -- modeled on the common format used by NASBLA-approved boater education course providers.',
    breakdown: [['Registration, Safety Education & Required Equipment', '32%'], ['Boating Accidents, Rules of the Road & Regulations', '25%'], ['Operation of Vessels, PWC & Water Sports', '24%'], ['Inland Lighting Rules & Waterway Markers', '19%']],
  },
  {
    examType: 'va_driver',
    title: 'Virginia Driver License Knowledge Exam', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/va',
    duration: 'Untimed', questions: '40 Multiple Choice (Road Signs + General Knowledge)', passScore: '34/40 Correct (85%)',
    description: 'Practice questions covering the Virginia Driver\'s Manual: traffic signals, signs and pavement markings, space cushion, sharing the road and hazardous conditions, licensing, testing and registration, seat belts, child safety and penalties, speed, stopping, right-of-way and turning, and license types and other important information -- for both the required 10-question road-sign identification section and the general knowledge section of the DMV test.',
    breakdown: [['Traffic Signals, Signs & Pavement Markings', '24%'], ['Space Cushion, Sharing the Road & Hazardous Conditions', '23%'], ['Licensing, Testing & Registration', '17%'], ['Seat Belts, Child Safety & Penalties', '14%'], ['Speed, Stopping, Right-of-Way & Turning', '11%'], ['License Types & Other Important Information', '11%']],
  },
  {
    examType: 'va_cdl',
    title: 'Virginia CDL (Commercial Driver\'s License) Exam', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/va',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Virginia CDL Manual: vehicle control, air brakes and combination vehicles, CDL licensing and driving safety, hazardous materials and alcohol/drugs awareness, cargo/passenger safety and accident procedures, and school bus endorsement content.',
    breakdown: [['Vehicle Control, Air Brakes & Combination Vehicles', '34%'], ['CDL Licensing & Driving Safety', '31%'], ['Hazardous Materials & Alcohol/Drugs Basics', '17%'], ['Cargo, Passenger Safety & Accident Procedures', '13%'], ['School Bus', '5%']],
  },
  {
    examType: 'va_motorcycle',
    title: 'Virginia Motorcycle Knowledge Exam', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/va',
    duration: 'Untimed', questions: '25 Multiple Choice', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the Virginia Motorcycle Rider\'s Manual: visibility, lane positioning and following distance, gear, pre-ride inspection and vehicle control, hazardous surfaces, night riding and emergencies, and Virginia motorcycle licensing, permits and testing.',
    breakdown: [['Visibility, Lane Positioning & Following Distance', '28%'], ['Gear, Pre-Ride Inspection & Vehicle Control', '26%'], ['Hazardous Surfaces, Night Riding & Emergencies', '25%'], ['Virginia Motorcycle Licensing, Permits & Testing', '21%']],
  },
  {
    examType: 'va_re_salesperson',
    title: 'Virginia Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/va',
    duration: '45 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '30/40 Correct (75%)',
    description: 'Practice questions covering Virginia Code Chapter 21 (Real Estate Board) and 18VAC135-20: licensing, qualifications, continuing education and escrow accounts, agency definitions and brokerage relationships, disclosure requirements, advertising and recordkeeping, and Virginia Fair Housing Law -- the state-specific portion of the PSI-administered Salesperson exam.',
    breakdown: [['Licensing, Qualifications & Escrow Accounts', '37%'], ['Agency Definitions & Brokerage Relationships', '29%'], ['Disclosure Requirements, Advertising & Recordkeeping', '20%'], ['Virginia Fair Housing Law', '14%']],
  },
  {
    examType: 'va_re_broker',
    title: 'Virginia Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/va',
    duration: '160 Minutes (105 Min National + 55 Min State)', questions: '125 Multiple Choice (75 National + 50 State-Specific)', passScore: 'National 75% (60/80), State 76% (38/50) — Both Required',
    description: 'Practice questions covering PSI Services LLC\'s official Virginia Real Estate Broker exam content outline (administered on behalf of the Virginia Department of Professional and Occupational Regulation Real Estate Board): a separately-scored, separately-timed National portion (75 items, up to 80 points -- property ownership, land use controls, valuation, financing, contracts, agency, property disclosures, property management, transfer of title, practice of real estate, and real estate calculations) plus a separately-scored Virginia-specific portion (50 items -- licensing qualifications and disciplinary procedures, escrow accounts, disclosure requirements including the Chesapeake Bay Act and Megan\'s Law, agency definitions and brokerage relationships, Virginia Fair Housing Law, and specific acts including the Condominium Act, Residential Landlord and Tenant Act, and Property Owners\' Association Act). PSI\'s own Candidate Information Bulletin confirms each portion must be passed independently (60 of 80 National points, 38 of 50 Virginia-specific items) within a combined 160-minute time limit (105 minutes national, 55 minutes state); 1-10 unscored experimental items may also appear.',
    breakdown: [['Contracts (National)', '11%'], ['Agency (National)', '8%'], ['Practice of Real Estate (National)', '7%'], ['Property Ownership (National)', '6%'], ['Financing (National)', '5%'], ['Valuation (National)', '5%'], ['Property Disclosures (National)', '4%'], ['Real Estate Calculations (National)', '4%'], ['Transfer of Title (National)', '4%'], ['Land Use Controls (National)', '3%'], ['Property Management (National)', '3%'], ['Licensing (VA)', '10%'], ['Agency Definitions & Relationships (VA)', '9%'], ['Escrow Accounts (VA)', '6%'], ['Disclosure Requirements (VA)', '6%'], ['Virginia Fair Housing Law (VA)', '5%'], ['Specific Acts Pertaining to RE Practice (VA)', '4%']],
  },
  {
    examType: 'va_boating',
    title: 'Virginia Boating Safety Education Exam', category: 'Boating & Watercraft Safety', route: '/boating/va',
    duration: 'Untimed', questions: '75 Multiple Choice', passScore: '60/75 Correct (80%)',
    description: 'Practice questions covering the Virginia DWR Boater\'s Guide: required safety equipment, operating laws and safety course requirements, safety, accidents and recreation, registration and titling, and navigation rules and aids to navigation -- grounded directly in Virginia Administrative Code 4VAC15-410, the state\'s official boating safety equivalency exam.',
    breakdown: [['Required Safety Equipment', '26%'], ['Operating Laws & Safety Course', '20%'], ['Safety, Accidents & Recreation', '20%'], ['Registration & Titling', '18%'], ['Navigation Rules & Aids to Navigation', '16%']],
  },
  {
    examType: 'mi_driver',
    title: 'Michigan Driver License Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/mi',
    duration: 'Untimed', questions: '50 Multiple Choice', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Michigan Driver\'s Manual (Secretary of State), weighted by its own real 7-chapter page structure: your driver\'s license (licensing, GDL requirements, testing), your driving record (points, alcohol and drugs), voter registration and state IDs, traffic laws, signs/pavement markings/signals, sharing the road, and emergencies and special situations.',
    breakdown: [['Licensing, GDL Requirements, Testing & State IDs', '24%'], ['Traffic Laws: Distraction, Restraints, Speed, Right-of-Way, Passing, Turning & Parking', '25%'], ['Signs, Pavement Markings & Signals', '17%'], ['Driving Record, Points, Alcohol & Drugs', '9%'], ['Sharing the Road: Commercial Vehicles, Pedestrians, Motorcycles & Bicycles', '10%'], ['Emergencies & Special Situations', '15%']],
  },
  {
    examType: 'mi_cdl',
    title: 'Michigan CDL (Commercial Driver\'s License) Exam', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/mi',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Michigan Commercial Driver License Manual, weighted by its own real section page lengths: the General Knowledge test content (CDL rules, driving safely, transporting cargo safely) required of all applicants, the Air Brakes/Combination Vehicles/Doubles-Triples tests, the Passenger/School Bus/Tank Vehicle/HazMat endorsement tests, and Vehicle Inspection Test procedures -- for Class A/B commercial permits and endorsements.',
    breakdown: [['General Knowledge (CDL Rules, Safe Driving & Cargo)', '48%'], ['Air Brakes, Combination Vehicles & Doubles/Triples', '20%'], ['Endorsements (Passenger, School Bus, Tank & HazMat)', '26%'], ['Vehicle Inspection Procedures', '6%']],
  },
  {
    examType: 'mi_motorcycle',
    title: 'Michigan Motorcycle Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/mi',
    duration: 'Untimed', questions: '25 Multiple Choice', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the Michigan Motorcycle Operator Manual: licensing, permits and endorsement requirements, Michigan motorcycle laws and equipment, protective gear and helmets, vehicle inspection and street strategies, and alcohol, drugs and impairment.',
    breakdown: [['Licensing, Permits & Endorsement Requirements', '26%'], ['Michigan Motorcycle Laws & Equipment', '25%'], ['Protective Gear & Helmets', '18%'], ['Vehicle Inspection & Street Strategies', '17%'], ['Alcohol, Drugs & Impairment', '14%']],
  },
  {
    examType: 'mi_boating',
    title: 'Michigan Boater Safety Certification Exam', category: 'Boating & Watercraft Safety', route: '/boating/mi',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering Michigan Boating Laws and Responsibilities: required safety equipment, boating basics and navigation rules, operating laws, alcohol, accidents and environmental protection, registration, titling and legal operator requirements, and PWC-specific rules, operation and skiing.',
    breakdown: [['Required Safety Equipment', '23%'], ['Boating Basics & Navigation Rules', '22%'], ['Operating Laws, Alcohol, Accidents & Environmental Protection', '22%'], ['Registration, Titling & Legal Operator Requirements', '18%'], ['PWC-Specific Rules, Operation & Skiing', '15%']],
  },
  {
    examType: 'ca_boating',
    title: 'California Boater Card Knowledge Exam', category: 'Boating & Watercraft Safety', route: '/boating/ca',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering California\'s Boater Card education requirement (California State Parks Division of Boating and Waterways, DBW): boat types and classification, required safety equipment (PFDs, fire extinguishers, ventilation and signaling devices), navigation rules and right-of-way, aids to navigation, California Boater Card and registration requirements, operating rules and reckless-operation law, boating under the influence, personal watercraft rules, trailering and launching, on-water emergencies and cold-water safety, weather, water sports and towing, California\'s invasive-species and environmental rules, and accident reporting -- modeled on the common format used by DBW-approved boater safety course providers.',
    breakdown: [['Required Safety Equipment (PFDs, Fire, Ventilation & Signaling)', '16%'], ['Navigation Rules, Right-of-Way & Aids to Navigation', '14%'], ['California Boater Card, Registration & Boat Types', '15%'], ['Operating Rules, BUI & PWC Rules', '19%'], ['Trailering, Water Sports & Towing', '12%'], ['Emergencies, Weather, Invasive Species & Accident Reporting', '24%']],
  },
  {
    examType: 'tx_boating',
    title: 'Texas Boater Education Knowledge Exam', category: 'Boating & Watercraft Safety', route: '/boating/tx',
    duration: 'Untimed', questions: '75 Multiple Choice', passScore: '53/75 Correct (70%)',
    description: 'Practice questions covering Texas\'s boater education requirement (Texas Parks & Wildlife Department, TPWD) and the Texas Boating Laws and Responsibilities handbook: boat types and classification, required safety equipment, navigation rules and right-of-way, aids to navigation, navigation lights and anchoring, operating rules, speed zones and boating while intoxicated (BWI), Texas-specific boating laws, trailering and launching, on-water emergencies, weather and water conditions, water sports and towing, invasive species (Clean, Drain, Dry), accident reporting and duty to assist, and general safe boating practices -- modeled on the common format used by TPWD-approved boater education course providers.',
    breakdown: [['Boat Types & Required Safety Equipment', '25%'], ['Navigation Rules, Aids to Navigation & Lights/Anchoring', '21%'], ['Operating Rules, BWI & Texas-Specific Boating Laws', '16%'], ['On-Water Emergencies, Weather & Water Sports/Towing', '17%'], ['Trailering, Invasive Species & Accident Reporting/General Practices', '21%']],
  },
  {
    examType: 'fl_boating',
    title: 'Florida Boating Safety Education Knowledge Exam', category: 'Boating & Watercraft Safety', route: '/boating/fl',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering Florida\'s Boating Safety Education ID Card requirement (Florida Fish and Wildlife Conservation Commission, FWC) and the Florida Boater\'s Guide: boat types and classification, PFDs and life jackets, required safety equipment, navigation rules and right-of-way, aids to navigation, operating rules and speed zones, the Florida Boating Safety ID Card and education mandate, registration and titling, personal watercraft rules, boating under the influence, manatee protection zones, trailering and launching, on-water emergencies, Florida-specific weather and storms, water sports and towing, and accident reporting and FWC officer authority -- modeled on the common format used by FWC-approved boater safety course providers.',
    breakdown: [['Required Safety Equipment (PFDs & Equipment)', '13%'], ['Navigation Rules, Right-of-Way & Aids to Navigation', '13%'], ['Boat Types, Registration/Titling & FL Boating Safety ID Card/Education Mandate', '18%'], ['Operating Rules, PWC & BUI', '18%'], ['Manatee Protection Zones', '6%'], ['Trailering, Water Sports, Emergencies, Weather & Accident Reporting', '32%']],
  },
  {
    examType: 'ny_boating',
    title: "New York Boater Safety Certificate Exam (Brianna's Law)", category: 'Boating & Watercraft Safety', route: '/boating/ny',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering New York\'s Brianna\'s Law boater safety certificate requirement (New York State Office of Parks, Recreation and Historic Preservation, OPRHP) and the New York State Boater\'s Guide: boat types and classification, PFDs and life jackets, required safety equipment, navigation rules and right-of-way, aids to navigation, lights, sound signals and anchoring, operating rules and reckless operation, Brianna\'s Law and boater education requirements, registration, titling and hull identification numbers, personal watercraft rules, boating while intoxicated/ability-impaired (BWI/BWAI) and alcohol, trailering and launching, on-water emergencies and cold-water safety, weather, water sports and towing, invasive species and environmental rules, and accident reporting -- modeled on the common format used by OPRHP-approved boater safety course providers.',
    breakdown: [['Required Safety Equipment (PFDs & Equipment)', '13%'], ['Navigation Rules, Aids to Navigation & Lights/Sound Signals/Anchoring', '19%'], ["Boat Types, Registration/Titling & Brianna's Law/Boater Education", '25%'], ['Personal Watercraft Rules & BWI/BWAI/Alcohol', '12%'], ['Trailering, Emergencies/Cold-Water Safety, Weather & Water Sports/Towing', '22%'], ['Invasive Species/Environment & Accident Reporting', '9%']],
  },
  {
    examType: 'pa_boating',
    title: 'Pennsylvania Boating Safety Education Certificate Exam', category: 'Boating & Watercraft Safety', route: '/boating/pa',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the Pennsylvania Boating Safety Education Certificate requirement (Pennsylvania Fish and Boat Commission, PFBC) and the Pennsylvania Boating Handbook: boat types and classification, required equipment (PFDs, fire extinguishers and signaling devices), navigation rules and right-of-way, aids to navigation, operating rules, speed and boating under the influence, the PA Boating Safety Certificate and registration process, personal watercraft rules, trailering and launching, boating emergencies, weather and boating, water sports and towing, and accident reporting and legal duties -- modeled on the common format used by PFBC-approved boater safety course providers.',
    breakdown: [['Required Safety Equipment (PFDs & Equipment)', '17%'], ['Navigation Rules, Right-of-Way & Aids to Navigation', '17%'], ['Boat Types & PA Boating Safety Certificate/Registration', '16%'], ['Operating Rules, BUI & PWC Rules', '16%'], ['Trailering, Weather, Water Sports & Boating Emergencies', '29%'], ['Accident Reporting & Legal Duties', '5%']],
  },
  {
    examType: 'il_boating',
    title: 'Illinois Boating Safety Certificate Exam', category: 'Boating & Watercraft Safety', route: '/boating/il',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the Handbook of Illinois Boating Laws and Responsibilities (Illinois Department of Natural Resources): vessel basics, required equipment and navigation lights, navigation rules and aids to navigation, operating rules and PWC-specific rules, the Boating Safety Certificate and registration/titling process, alcohol/BUI and accident-reporting enforcement, and trailering, weather, water sports and cold-water emergencies -- modeled on the common format used by IDNR-directed NASBLA-approved course providers.',
    breakdown: [['Vessel Basics, PFDs & Required Equipment', '25%'], ['Navigation Rules & Aids to Navigation', '12%'], ['Operating Rules & PWC-Specific Rules', '12%'], ['Boating Safety Certificate & Registration', '12%'], ['Alcohol, BUI & Accident Enforcement', '11%'], ['Trailering, Weather & Water Sports', '16%'], ['Emergencies, Diving, Sewage & Environment', '12%']],
  },
  {
    examType: 'ga_boating',
    title: 'Georgia Boating Education Exam', category: 'Boating & Watercraft Safety', route: '/boating/ga',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the Handbook of Georgia Boating Laws and Responsibilities (Kalkomey/Boat-Ed course material, approved by the Georgia Department of Natural Resources for Georgia\'s boating education requirement): vessel basics, required equipment and navigation lights, navigation rules and aids to navigation, operating rules and PWC-specific rules, boating education certification and age requirements, registration and titling, BUI and accident-reporting enforcement, and trailering, weather, water sports, cold-water emergencies and waste discharge -- for the DNR-approved NASBLA-standard boating education course final exam.',
    breakdown: [['Vessel Basics, PFDs & Required Equipment', '24%'], ['Navigation Rules & Aids to Navigation', '13%'], ['Operating Rules & PWC-Specific Rules', '13%'], ['Boating Education Certificate & Registration', '12%'], ['BUI, Alcohol & Accident Enforcement', '10%'], ['Trailering, Weather & Water Sports', '16%'], ['Emergencies & Waste Discharge/Environment', '12%']],
  },
  {
    examType: 'nj_boating',
    title: 'New Jersey Boat Safety Certificate Exam', category: 'Boating & Watercraft Safety', route: '/boating/nj',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the New Jersey Boat Safety Certificate program (NJ State Police Marine Services Bureau): vessel basics, required equipment and navigation lights, navigation rules and aids to navigation, operating rules and PWC-specific rules, the NJ Boat Safety Certificate and registration/titling process (handled by the NJ Motor Vehicle Commission), BUI and accident-reporting enforcement, and trailering, weather/coastal conditions, water sports and cold-water emergencies -- for the NASBLA-approved online course\'s final exam, one half of New Jersey\'s unique two-step certificate process.',
    breakdown: [['Vessel Basics, PFDs & Required Equipment', '26%'], ['Navigation Rules & Aids to Navigation', '14%'], ['Operating Rules & PWC-Specific Rules', '11%'], ['NJ Boat Safety Certificate & Registration', '14%'], ['BUI & Accident Enforcement', '10%'], ['Trailering, Weather & Water Sports', '14%'], ['Emergencies & NJ Waters/Environment', '11%']],
  },
  {
    examType: 'wa_boating',
    title: 'Washington Boater Education Card Exam', category: 'Boating & Watercraft Safety', route: '/boating/wa',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the Washington Boating Program handbook (Washington State Parks): vessel basics, required equipment and nighttime navigation, navigation rules and aids to navigation, operating rules, wake and PWC-specific rules, the Boater Education Card and age requirements, registration and titling, BUI and accident-reporting enforcement, and trailering, weather/coastal hazards, water sports, cold-water emergencies and aquatic invasive species -- for the State Parks-approved course\'s own final exam.',
    breakdown: [['Vessel Basics, PFDs & Required Equipment', '24%'], ['Navigation Rules & Aids to Navigation', '12%'], ['Operating Rules & PWC-Specific Rules', '13%'], ['Boater Education Card & Registration', '12%'], ['BUI & Accident Enforcement', '9%'], ['Trailering, Weather/Coastal Bars & Water Sports', '16%'], ['Emergencies & Aquatic Invasive Species', '14%']],
  },
  {
    examType: 'az_boating',
    title: 'Arizona Boating Safety Course Exam', category: 'Boating & Watercraft Safety', route: '/boating/az',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering The Boater\'s Guide of Arizona (Arizona Game and Fish Department): vessel basics, required equipment and navigation lights, navigation rules and aids to navigation, operating rules and PWC-specific rules, Arizona boater education and registration, BUI and accident-reporting enforcement, interstate waters on Lake Mead, Lake Powell and the Colorado River, and trailering, weather, water sports and emergencies. Note: Arizona has no mandatory boater-education law -- see full disclosure on the track page.',
    breakdown: [['Vessel Basics, PFDs & Required Equipment', '24%'], ['Navigation Rules & Aids to Navigation', '11%'], ['Operating Rules & PWC-Specific Rules', '12%'], ['Arizona Boater Education & Registration', '11%'], ['BUI, Alcohol & Accident Enforcement', '12%'], ['Interstate Waters (Lake Mead, Lake Powell & Colorado River)', '7%'], ['Trailering, Weather, Water Sports & Emergencies', '23%']],
  },
  {
    examType: 'ma_boating',
    title: 'Massachusetts Boater Safety Certificate Course Exam', category: 'Boating & Watercraft Safety', route: '/boating/ma',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the Massachusetts Environmental Police (MEP) boater education program: boat types and classification, PFDs and life jackets, required safety equipment, navigation rules and right-of-way, aids to navigation, operating rules and speed zones, boating under the influence, the new Massachusetts Boater Education Law (Hanson-Milone Boater Safety Act) and its phased birth-date deadlines, registration and PWC rules, trailering and launching, cold-water emergencies, New England weather hazards, water sports/towing, and accident reporting -- modeled on the 80%-to-pass format independently confirmed by both MEP-approved course vendors.',
    breakdown: [['Boat Types, PFDs & Required Equipment', '28%'], ['Navigation Rules, Lights & Aids to Navigation', '16%'], ['Operating Rules, Speed Zones & BUI/Alcohol', '12%'], ['MA Boater Education Law & Registration/PWC Rules', '16%'], ['Trailering, Emergencies & Cold Water', '12%'], ['Weather, Water Sports/Towing & Accident Reporting', '16%']],
  },
  {
    examType: 'tn_boating',
    title: 'Tennessee Boating Safety Education Exam', category: 'Boating & Watercraft Safety', route: '/boating/tn',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the Tennessee Wildlife Resources Agency (TWRA) boating safety program: boat types and classification, PFDs and life jackets, required safety equipment, navigation lights and sound signals, navigation rules and right-of-way, aids to navigation, operating rules and speed zones, alcohol and BUI, the TN Boater Education Mandate, registration and titling, personal watercraft (PWC) rules, paddlecraft and non-motorized vessels, trailering and launching, cold-water emergencies, weather, water sports/towing, TVA reservoirs and dam safety, and accident reporting/enforcement -- modeled on the 80%-to-pass format independently confirmed for TWRA-approved courses.',
    breakdown: [['Boat Types, PFDs & Required Equipment', '19%'], ['Navigation Lights, Nav Rules & Aids to Navigation', '18%'], ['Operating Rules/Speed & Alcohol/BUI', '10%'], ['TN Boater Education Mandate & Registration/Titling', '12%'], ['PWC Rules & Paddlecraft/Non-Motorized Vessels', '10%'], ['Trailering, Emergencies & Weather', '15%'], ['Water Sports/Towing, TVA Reservoirs & Accident Reporting', '16%']],
  },
  {
    examType: 'mo_boating',
    title: 'Missouri Boating Safety Identification Card Exam', category: 'Boating & Watercraft Safety', route: '/boating/mo',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the Missouri State Highway Patrol (MSHP) Water Patrol Division boating safety program and Missouri Revised Statutes Chapters 306 and 577: boat types and classification, PFDs and life jackets, required safety equipment, navigation rules and right-of-way, aids to navigation, operating rules and speed zones, boating while intoxicated (BUI), the Missouri Boater Education Law, registration/titling and PWC rules, trailering and launching, cold-water emergencies, weather and environmental hazards, water sports/towing, and accident reporting/Water Patrol authority.',
    breakdown: [['Boat Types, PFDs & Required Equipment', '22%'], ['Navigation Rules, Aids to Navigation & Operating Rules/Speed', '24%'], ['BUI/Alcohol & MO Boater Education Law', '15%'], ['Registration/Titling/PWC Rules & Trailering', '13%'], ['Emergencies/Cold Water & Weather/Environmental Hazards', '13%'], ['Water Sports/Towing & Accident Reporting/Water Patrol Authority', '13%']],
  },
  {
    examType: 'md_boating',
    title: 'Maryland Boating Safety Certificate Exam', category: 'Boating & Watercraft Safety', route: '/boating/md',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the Maryland Department of Natural Resources (DNR) Natural Resources Police boating safety program: vessel types and classification, personal flotation devices, required safety equipment, navigation rules and right-of-way, aids to navigation, operating rules and speed zones, boating under the influence, the Maryland Boater Education Law, registration/titling and PWC rules, trailering and launching, cold-water emergencies, Chesapeake Bay weather conditions, water sports/towing, Chesapeake Bay-specific boating, and accident reporting/enforcement.',
    breakdown: [['Vessel Types, PFDs & Required Equipment', '24%'], ['Navigation Rules & Aids to Navigation', '16%'], ['Operating Rules/Speed & Boating Under the Influence', '13%'], ['MD Boater Education Law & Registration/Titling/PWC Rules', '15%'], ['Trailering, Emergencies & Chesapeake Bay Conditions', '17%'], ['Water Sports/Towing, Chesapeake Bay Boating & Accident Reporting', '15%']],
  },
  {
    examType: 'sc_boating',
    title: 'South Carolina Boater Education Exam', category: 'Boating & Watercraft Safety', route: '/boating/sc',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the South Carolina Department of Natural Resources (SCDNR) boating safety program and S.C. Code of Laws Title 50, Chapter 21: boat types and classification, PFDs and life jackets, required safety equipment, navigation rules and right-of-way, aids to navigation, operating rules and speed zones, reckless operation and BUI, the South Carolina Boater Education Law, registration and PWC rules, trailering and launching, cold-water emergencies, weather, water sports/towing, and accident reporting/SCDNR enforcement.',
    breakdown: [['Boat Types, PFDs & Required Equipment', '21%'], ['Navigation Rules & Aids to Navigation', '14%'], ['Operating Rules/Speed & Reckless Operation/BUI', '15%'], ['SC Boater Education Law & Registration/PWC Rules', '14%'], ['Trailering & Emergencies/Cold Water', '14%'], ['Weather, Water Sports/Towing & Accident Reporting/SCDNR Enforcement', '22%']],
  },
  {
    examType: 'mn_boating',
    title: 'Minnesota Boater Education Certification Exam', category: 'Boating & Watercraft Safety', route: '/boating/mn',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the Minnesota DNR-approved boater education curriculum grounded in Minn. Stat. 86B (registration, titling, PWC rules, boating-while-impaired law), Sec. 86B.313 personal watercraft rules, Sophia\'s Law carbon monoxide detector requirements, and Minnesota\'s aquatic invasive species drain-plug law -- for the state\'s phased-in watercraft operator\'s permit mandate, which applies on a rolling birth-date schedule through 2028.',
    breakdown: [['Boat Types, Classification & PFDs/Life Jackets', '14%'], ['Required Equipment, Navigation Rules & Aids to Navigation', '23%'], ['Operating Rules, Speed Zones & BUI/Alcohol', '14%'], ['Minnesota Boater Education Law, Registration & PWC Rules', '16%'], ['Trailering, Emergencies, Cold Water & Weather', '20%'], ['Water Sports, Towing & Accident Reporting', '13%']],
  },
  {
    examType: 'wi_boating',
    title: 'Wisconsin Boater Safety Certification Exam', category: 'Boating & Watercraft Safety', route: '/boating/wi',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering the Wisconsin DNR boater-safety curriculum required under Wis. Stat. ch. 30 for operators born on or after January 1, 1989: required equipment, PFD and life-jacket rules, navigation rules and aids to navigation, personal watercraft rules (minimum age 12, no supervision exception), accident reporting under Wis. Admin. Code NR 5, and Wisconsin\'s extensive inland-lake boating culture.',
    breakdown: [['Boat Types, Classification & PFDs/Life Jackets', '14%'], ['Required Equipment, Navigation Rules & Aids to Navigation', '24%'], ['Operating Rules, Speed/No-Wake Zones & Alcohol/BUI', '13%'], ['Wisconsin Boater Education Law, Registration & PWC Rules', '17%'], ['Trailering, Emergencies, Cold Water & Weather', '19%'], ['Water Sports, Towing & Accident Reporting', '13%']],
  },
  {
    examType: 'al_boating',
    title: 'Alabama Boating Safety Certification Exam', category: 'Boating & Watercraft Safety', route: '/boating/al',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering Alabama\'s vessel "V" license requirements administered by ALEA Marine Patrol: PFD Performance Level and Type I-V labeling, personal watercraft rules (minimum age 14), a 0.08% BUI standard with implied-consent-style suspension penalties, 24-hour accident reporting, and Alabama\'s distinct Northern (Tennessee River/Lake Guntersville), Central (Alabama River/Lake Martin) and Southern (Mobile Bay/Gulf of Mexico) marine patrol districts, including Gulf hurricane-season and hydroelectric-dam hazards.',
    breakdown: [['Boat Types, Classification & PFDs/Life Jackets', '17%'], ['Required Equipment, Navigation Rules & Aids to Navigation', '25%'], ['Operating Rules, Speed Zones & BUI', '8%'], ['Alabama Boater Education Law, Registration & Marine Patrol Authority', '19%'], ['Trailering, Emergencies, Cold Water & Gulf Coast Weather', '19%'], ['Water Sports, Towing & Accident Reporting', '12%']],
  },
  {
    examType: 'la_boating',
    title: 'Louisiana Boater Education Certification Exam', category: 'Boating & Watercraft Safety', route: '/boating/la',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering LDWF\'s boater education requirements for anyone born after January 1, 1984 operating a motorboat over 10hp or a PWC: required safety equipment scaled by vessel class, PWC-specific restrictions, BUI parity with Louisiana\'s 0.08% highway DUI standard, vessel registration/titling, accident reporting procedures, and Louisiana\'s distinctive bayou, wetland and Mississippi River hazard content grounded in LDWF\'s own published guidance.',
    breakdown: [['Boat Types, Classification & PFDs/Life Jackets', '13%'], ['Required Equipment, Navigation Rules & Aids to Navigation', '19%'], ['Operating Rules, Speed/No-Wake Zones & Reckless Operation/BUI', '12%'], ['Louisiana Boater Education Law, Registration/Titling & PWC/LDWF Enforcement', '19%'], ['Bayou, Wetland & Mississippi River Hazards', '7%'], ['Trailering, Emergencies, Cold Water & Hurricane Weather', '18%'], ['Water Sports, Towing & Accident Reporting', '12%']],
  },
  {
    examType: 'nv_boating',
    title: 'Nevada Boater Safety Certification Exam', category: 'Boating & Watercraft Safety', route: '/boating/nv',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering NRS Chapter 488\'s safe-boating course requirement for persons born on or after January 1, 1983 operating a power-driven vessel over 15hp on Nevada\'s interstate boundary waters (Lake Tahoe, Lake Mead, Lake Mohave and the Colorado River): registration and titling, aquatic invasive species rules targeting quagga mussels, the 0.08 BUI standard, PWC rules (minimum age 14), and Nevada\'s split desert-heat/alpine-cold-water boating geography.',
    breakdown: [['Boat Types, Classification & PFDs/Life Jackets', '15%'], ['Required Equipment, Navigation Rules & Aids to Navigation', '22%'], ['Operating Rules, Speed Zones & Reckless Operation/BUI', '14%'], ['Nevada Boater Education Law, Registration & PWC Rules', '14%'], ['Trailering, Emergencies, Cold Water & Weather Awareness', '21%'], ['Water Sports, Towing & Accident Reporting/Enforcement', '14%']],
  },
  {
    examType: 'ct_boating',
    title: 'Connecticut Boater Safety Certification Exam', category: 'Boating & Watercraft Safety', route: '/boating/ct',
    duration: 'Untimed', questions: '60 Multiple Choice', passScore: '48/60 Correct (80%)',
    description: 'Practice questions covering Connecticut\'s Safe Boating Certificate requirements administered by DEEP: required equipment by federal length class, the post-2020 engine cut-off switch mandate, PFD wear rules, BUI/DUI reciprocal-suspension law, Public Act 16-187 flyboard rules, Thames River federal security zones, and Connecticut\'s Long Island Sound coastal boating culture including its tidal-current "gates."',
    breakdown: [['Boat Types, Classification & PFDs/Life Jackets', '15%'], ['Required Equipment, Navigation Rules & Aids to Navigation', '21%'], ['Operating Rules, Speed Zones & Reckless Operation/BUI', '15%'], ['Connecticut Boater Education Law, Registration & PWC Rules', '14%'], ['Trailering, Emergencies, Cold Water & Long Island Sound Weather', '21%'], ['Water Sports, Towing & Accident Reporting/Enforcement', '14%']],
  },
  {
    examType: 'mi_re_salesperson',
    title: 'Michigan Real Estate Salesperson Exam Prep (Michigan-Specific Content)', category: 'Real Estate Licensing', route: '/real-estate-salesperson/mi',
    duration: '45 Minutes', questions: '40 Multiple Choice (Michigan-Specific Content)', passScore: '28/40 Correct (70%)',
    description: 'Practice questions covering Michigan\'s Occupational Code Article 25 (Real Estate Brokers and Salespersons, MCL 339.2501-2518), weighted by PSI\'s own official Candidate Information Bulletin\'s exact Michigan-specific-portion item counts: duties and powers of the Department and State Board, licensing requirements, statutory requirements governing licensee activities (advertising, commissions, trust accounts, disclosure/conflict of interest), Michigan agency relationships and contractual relationships, and additional state topics (Land Division Act, Michigan fair housing). Note: Michigan\'s real Salesperson exam is one unified 115-question national+state test with no separate standalone state-only portion -- this track covers the Michigan-specific subject matter as supplemental practice, not a full state-portion exam.',
    breakdown: [['Duties & Powers of the Department and State Board', '11%'], ['Licensing Requirements', '18%'], ['Statutory Requirements Governing Licensee Activities', '36%'], ['Contractual Relationships & Michigan Agency Types', '18%'], ['Additional Michigan State Topics', '18%']],
  },
  {
    examType: 'wa_driver',
    title: 'Washington Driver License Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/wa',
    duration: 'Untimed', questions: '40 Multiple Choice', passScore: '32/40 Correct (80%)',
    description: 'Practice questions covering the Washington Driver Guide (Department of Licensing): licensing, permits and endorsements, vehicles, safety technology and basic control, traffic laws, signals, signs, intersections and road markings, sharing the road with people, buses, large vehicles, motorcycles, bicyclists, trains and emergency vehicles, impaired, distracted and smart driving, hazard awareness, speed, space, zones and parking, and road conditions, vehicle failures, collisions and law enforcement.',
    breakdown: [['Licensing, Permits & Endorsements', '11%'], ['Vehicles, Safety Technology & Basic Control', '11%'], ['Traffic Laws, Signals, Signs, Intersections & Road Markings', '22%'], ['Sharing the Road: People, Vehicles & Vulnerable Users', '19%'], ['Impaired, Distracted & Smart Driving', '10%'], ['Hazard Awareness, Speed, Space, Zones & Parking', '17%'], ['Road Conditions, Vehicle Failures, Collisions & Law Enforcement', '10%']],
  },
  {
    examType: 'wa_cdl',
    title: 'Washington CDL (Commercial Driver\'s License) Exam', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/wa',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Washington Commercial Driver Guide: vehicle control, air brakes and combination vehicles, CDL licensing, driving safety and cargo/passenger safety, hazardous materials, and school bus content.',
    breakdown: [['Vehicle Control, Air Brakes & Combination Vehicles', '32%'], ['CDL Licensing, Driving Safety & Cargo/Passenger Safety', '41%'], ['Hazardous Materials', '17%'], ['School Bus', '10%']],
  },
  {
    examType: 'wa_motorcycle',
    title: 'Washington Motorcycle Endorsement Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/wa',
    duration: 'Untimed', questions: '25 Multiple Choice', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the Washington Motorcycle Operator Manual: licensing, permits and endorsement process, gear, motorcycle inspection and personal responsibility, two-wheel riding controls, cornering and braking, riding a three-wheeled motorcycle, street strategies, and impairments.',
    breakdown: [['Licensing, Permits & Endorsement Process', '14%'], ['Gear, Motorcycle Inspection & Personal Responsibility', '13%'], ['Two-Wheel Riding: Controls, Cornering & Braking', '10%'], ['Riding a Three-Wheeled Motorcycle', '21%'], ['Strategies for the Street', '24%'], ['Impairments', '18%']],
  },
  {
    examType: 'al_motorcycle',
    title: 'Alabama Motorcycle Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/al',
    duration: 'Untimed', questions: '30 Multiple Choice', passScore: '24/30 Correct (80%)',
    description: 'Practice questions covering the Alabama Motorcycle Operator Manual (18th Edition, ALEA): protective gear and Alabama motorcycle licensing/road rules, motorcycle controls and basic vehicle operation, following distance, SEE strategy, intersections and conspicuity, crash avoidance and dangerous riding surfaces, mechanical problems, passengers, cargo and group riding, alcohol/drug/fatigue impairment and licensing safety facts, and the manual\'s three-wheel motorcycle and sidecar supplement.',
    breakdown: [['Gear & Alabama Licensing/Road Rules', '16%'], ['Know Your Motorcycle & Basic Vehicle Control', '16%'], ['Keeping Your Distance, SEE Strategy & Conspicuity', '20%'], ['Crash Avoidance & Dangerous Surfaces', '11%'], ['Mechanical Problems, Passengers, Cargo & Group Riding', '18%'], ['Alcohol, Drugs, Fatigue & Licensing Safety Facts', '12%'], ['Three-Wheel Motorcycle Supplement', '7%']],
  },
  {
    examType: 'ar_motorcycle',
    title: 'Arkansas Motorcycle Endorsement Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/ar',
    duration: 'Untimed', questions: '25 Multiple Choice', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the Motorcycle Operator Manual (Motorcycle Safety Foundation, distributed by the Arkansas Department of Public Safety / Arkansas State Police as its official Motorcycle Endorsement Study Guide): protective gear and vehicle control, space management and SEE strategy, intersections and conspicuity, crash avoidance and dangerous surfaces, mechanical problems, roadside hazards and passengers/cargo, group riding and alcohol/drugs/fatigue, Arkansas Class M/MD licensing requirements, and the three-wheel motorcycle supplement.',
    breakdown: [['Gear & Vehicle Control', '20%'], ['Space Management & SEE Strategy', '12%'], ['Intersections & Conspicuity', '12%'], ['Crash Avoidance & Dangerous Surfaces', '11%'], ['Mechanical Problems, Roadside Hazards & Passengers/Cargo', '15%'], ['Group Riding & Alcohol/Drugs/Fatigue', '15%'], ['Arkansas Licensing & Three-Wheel Supplement', '15%']],
  },
  {
    examType: 'ct_motorcycle',
    title: 'Connecticut Motorcycle Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/ct',
    duration: 'Untimed', questions: '16 Multiple Choice', passScore: '13/16 Correct (80%)',
    description: 'Practice questions covering the Connecticut DMV Motorcycle Operator Manual: preparing to ride and gear, knowing your motorcycle, the CT motorcycle endorsement and learner\'s permit (including the 2025 protective headgear law, the legal definition of a motor-driven cycle/moped, and permit restrictions), basic vehicle control, keeping your distance and lane position, intersections, crash avoidance, increasing conspicuity, handling dangerous surfaces, mechanical problems and road hazards, carrying passengers and cargo, group riding, and alcohol, drugs and fatigue -- for the DMV\'s 16-question motorcycle knowledge test.',
    breakdown: [['CT Motorcycle Endorsement & Permit', '9%'], ['Gear & Know Your Motorcycle', '15%'], ['Basic Vehicle Control, Lane Position & Intersections', '23%'], ['Crash Avoidance, Conspicuity & Dangerous Surfaces', '22%'], ['Mechanical Problems, Passengers/Cargo & Group Riding', '23%'], ['Alcohol, Drugs & Fatigue', '8%']],
  },
  {
    examType: 'mn_motorcycle',
    title: 'Minnesota Motorcycle Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/mn',
    duration: 'Untimed', questions: '40 Multiple Choice', passScore: '32/40 Correct (80%)',
    description: 'Practice questions covering the Minnesota DPS Motorcycle and Motorized Bicycle Manual (PS30001-21, 11/2021), published by the Minnesota Department of Public Safety, Driver and Vehicle Services Division: preparing to ride and gear, knowing your motorcycle and basic vehicle control, keeping your distance, the SEE strategy at intersections and increasing conspicuity, crash avoidance, handling dangerous surfaces and mechanical problems, carrying passengers, cargo and group riding, alcohol, drugs and fatigue, and earning your license and the licensing process. The manual\'s own Preface states that Minnesota tests everyone seeking permits and license endorsements, so the knowledge test is mandatory for essentially all applicants -- but neither the manual nor DPS/DVS publishes an official item count or passing score for it, so this practice exam uses the 40-question, 32-correct (80%) format consistently reported by third-party test-prep sources.',
    breakdown: [['Preparing to Ride: Gear', '9%'], ['Know Your Motorcycle & Basic Vehicle Control', '17%'], ['Keeping Your Distance, SEE Strategy & Increasing Conspicuity', '24%'], ['Crash Avoidance, Dangerous Surfaces & Mechanical Problems', '19%'], ['Carrying Passengers, Cargo & Group Riding', '13%'], ['Alcohol, Drugs & Fatigue', '7%'], ['Earning Your License and Licensing Process', '11%']],
  },
  {
    examType: 'ms_motorcycle',
    title: 'Mississippi Motorcycle Endorsement Written Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/ms',
    duration: 'Untimed', questions: '25 Multiple Choice', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the Mississippi Motorcycle Operator Manual (Mississippi Department of Public Safety, Driver Service Bureau): protective gear, knowing your motorcycle, basic vehicle control, keeping your distance, SEE and intersections, conspicuity, crash avoidance, dangerous surfaces, mechanical problems and road hazards, carrying passengers and cargo, group riding, alcohol/drugs/fatigue, and earning your license -- plus the manual\'s full Three-Wheel Motorcycle/Sidecar Supplement and its Hand Signals/T-CLOCS pre-ride inspection content.',
    breakdown: [['Gear & Basic Vehicle Control', '15%'], ['Know Your Motorcycle & Mechanical Problems/Hazards', '13%'], ['Keeping Distance, SEE/Intersections & Crash Avoidance', '19%'], ['Conspicuity, Dangerous Surfaces & Hand Signals/T-CLOCS', '18%'], ['Passengers, Cargo & Group Riding', '14%'], ['Alcohol/Drugs/Fatigue & Earning Your License', '12%'], ['Three-Wheel/Sidecar Supplement', '9%']],
  },
  {
    examType: 'nc_motorcycle',
    title: 'North Carolina Motorcycle Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/nc',
    duration: 'Untimed', questions: '25 Multiple Choice', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the NC DMV Motorcyclists\' Handbook, Thirteenth Edition (NCDMV), weighted by its own real page structure: gear and motorcycle responsibilities, basic vehicle control, keeping your distance/SEE/intersections, increasing conspicuity, crash avoidance, handling dangerous surfaces, mechanical problems and road hazards, carrying passengers and cargo, group riding, alcohol, drugs and fatigue, and earning your license, for the motorcycle knowledge test.',
    breakdown: [['Gear, Motorcycle Basics & Vehicle Control', '21%'], ['Distance, Visibility, SEE & Intersections', '30%'], ['Crash Avoidance & Road Hazards', '23%'], ['Passengers, Cargo & Group Riding', '11%'], ['Alcohol, Drugs & Fatigue', '10%'], ['Earning Your License', '5%']],
  },
  {
    examType: 'ny_motorcycle',
    title: 'New York Motorcycle Written Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/ny',
    duration: 'Untimed', questions: '20 Multiple Choice', passScore: '14/20 Correct (70%)',
    description: 'Practice questions covering the New York State DMV Motorcycle Manual, weighted by its own real section structure: licenses/registration and preparing to ride, basic vehicle control/lane position/following-passing/SEE strategy, crash prevention/dangerous surfaces/mechanical problems/group riding, and alcohol/drugs/fatigue/earning your license (MSF program) for the Class M written knowledge test.',
    breakdown: [['Licenses, Registration & Preparing to Ride', '20%'], ['Basic Vehicle Control, Lane Position & SEE Strategy', '30%'], ['Crash Prevention, Dangerous Surfaces, Mechanical Problems & Group Riding', '26%'], ['Alcohol, Drugs, Fatigue & Earning Your License (MSF Program)', '24%']],
  },
  {
    examType: 'pa_motorcycle',
    title: 'Pennsylvania Motorcycle Written Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/pa',
    duration: 'Untimed', questions: '20 Multiple Choice', passScore: '16/20 Correct (80%)',
    description: 'Practice questions covering the PennDOT Motorcycle Operator Manual, Pub 147 (11-24 ed.), weighted by its own real page structure: gear and basic vehicle control, knowing your motorcycle and rider responsibilities, keeping your distance, intersections and increasing conspicuity, crash avoidance and dangerous surfaces, mechanical problems, animals and objects in the roadway, carrying passengers and cargo, group riding, and alcohol, drugs, fatigue and earning your license through the PAMSP.',
    breakdown: [['Gear & Basic Vehicle Control', '11%'], ['Know Your Motorcycle & Responsibilities', '11%'], ['Following Distance, Intersections & Conspicuity', '32%'], ['Crash Avoidance & Dangerous Surfaces', '16%'], ['Mechanical Problems, Animals & Road Hazards', '8%'], ['Passengers, Cargo & Group Riding', '8%'], ['Alcohol, Drugs, Fatigue & Earning Your License (PAMSP)', '14%']],
  },
  {
    examType: 'tx_motorcycle',
    title: 'Texas Motorcycle Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/tx',
    duration: 'Untimed', questions: '25 Multiple Choice', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the Texas Motorcycle Operator Training Manual 2020-2021 (Texas Department of Licensing & Regulation / Texas Department of Public Safety), weighted by its own real section structure: riding environment, licensing, equipment and earning your license, preparing to ride and basic vehicle control, keeping your distance/SEE strategy/intersections/conspicuity, crash avoidance/dangerous surfaces/mechanical problems/off-road hazards, passengers/cargo/group riding/hand signals, alcohol/drugs/fatigue and the three-wheel motorcycle supplement, and the manual\'s own FAQ on course requirements and age-based licensing rules. Note: most Texas applicants complete a TDLR-approved course instead of taking this written test -- see full disclosure on the track page.',
    breakdown: [['Licensing, Equipment & Earning Your License', '15%'], ['Preparing to Ride & Basic Vehicle Control', '16%'], ['Keeping Distance, SEE Strategy/Intersections & Conspicuity', '20%'], ['Crash Avoidance, Dangerous Surfaces, Mechanical Problems & Off-Road Hazards', '13%'], ['Passengers, Cargo, Group Riding & Hand Signals', '15%'], ['Alcohol, Drugs, Fatigue & Three-Wheel Supplement', '18%'], ['Licensing Program FAQs (Course Requirements & Age-Based Rules)', '3%']],
  },
  {
    examType: 'ut_motorcycle',
    title: 'Utah Motorcycle Endorsement Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/motorcycle/ut',
    duration: 'Untimed', questions: '25 Multiple Choice', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the Utah Motorcycle Operator Manual (Utah Driver License Division, DLD): basic vehicle control, keeping distance, SEE strategy and intersections; Utah traffic law, vehicle definitions (mopeds, e-bikes, motor-assisted scooters and autocycles) and the three-wheel motorcycle supplement; mechanical problems, carrying passengers/cargo and group riding; increasing conspicuity and crash avoidance on dangerous surfaces; wearing the right gear and knowing your motorcycle; Utah\'s tiered engine-size licensing and learner-permit system; and alcohol, other drugs and fatigue -- for the DLD\'s 25-question motorcycle endorsement written knowledge test, including Utah-specific content on lane filtering drawn from the manual\'s 22-page Utah insert.',
    breakdown: [['Basic Vehicle Control, Distance & Intersections', '24%'], ['Utah Traffic Law, Vehicle Definitions & Three-Wheel Supplement', '17%'], ['Mechanical Problems, Passengers & Group Riding', '16%'], ['Conspicuity & Crash Avoidance on Dangerous Surfaces', '15%'], ['Gear & Knowing Your Motorcycle', '14%'], ['Utah Licensing & Permits', '9%'], ['Alcohol, Other Drugs & Fatigue', '5%']],
  },
  {
    examType: 'wa_re_salesperson',
    title: 'Washington Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/wa',
    duration: '90 Minutes', questions: '30 Multiple Choice (State-Specific Portion)', passScore: '21/30 Correct (70%)',
    description: 'Practice questions covering RCW 18.85 (broker licensing), RCW 18.86 (brokerage relationships/agency) and RCW 49.60.222-.227 (fair housing): licensing requirements and examination, agency relationships and disclosure, trust accounts and client funds, fair housing and anti-discrimination, and records, supervision and discipline -- the state-specific portion of the PSI-administered Broker exam. Washington\'s entry-level real estate license is called "Broker" (not "Salesperson").',
    breakdown: [['Licensing Requirements & Examination', '25%'], ['Agency Relationships & Disclosure', '21%'], ['Trust Accounts & Client Funds', '18%'], ['Fair Housing & Anti-Discrimination', '15%'], ['Records, Supervision & Discipline', '21%']],
  },
  {
    examType: 'wa_re_broker',
    title: 'Washington Managing Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/wa',
    duration: '90 Minutes', questions: '44 Multiple Choice (State-Specific Portion)', passScore: '33/44 Correct (75%)',
    description: 'Practice questions covering RCW 18.85 (managing-broker sections), WAC 308-124C (Records and Responsibilities), WAC 308-124E (Trust Account Procedures) and WAC 308-124B (Firms, Branch Offices & Advertising): licensing and qualifications, designated broker and supervisory authority, branch office supervision and recordkeeping, trust account oversight, advertising compliance and disciplinary oversight, and license renewal/continuing education -- the state-specific portion of the PSI-administered Managing Broker exam, Washington\'s supervisory upgrade tier above the base Broker license.',
    breakdown: [['Licensing & Qualifications', '16%'], ['Designated Broker & Supervisory Authority', '21%'], ['Branch Office Supervision & Recordkeeping', '18%'], ['Trust Account Oversight', '21%'], ['Advertising Compliance & Disciplinary Oversight', '13%'], ['License Renewal, Continuing Education & Firm Closure', '11%']],
  },
  {
    examType: 'mlo',
    title: 'NMLS SAFE National MLO Exam', category: 'Mortgage Loan Origination', route: '#',
    duration: '190 Minutes', questions: '125 Questions (115 Scored)', passScore: '75%',
    description: 'The NMLS National Test Component: federal lending regulations, origination activities, and ethics.',
    breakdown: [['Origination Activities', '27%'], ['Federal Laws & Rules', '24%'], ['General Mortgage Knowledge', '20%'], ['Ethics & Fair Lending', '18%']],
  },
  {
    examType: 'ak_re_salesperson',
    title: 'Alaska Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ak',
    duration: '80 Minutes', questions: '40 Multiple Choice (State Law Portion)', passScore: '30/40 Correct (75%)',
    description: 'Practice questions covering the Alaska Real Estate Law Content Outline (Alaska Statutes Title 08, Chapter 88 and the Real Estate Commission\'s regulations at 12 AAC 64): powers of the Real Estate Commission, licensing, licensee duties and disclosures to the public, requirements governing licensee activities (advertising, handling of documents and monies, prohibited conduct), personal services agreements (listings, property management, buyer representation), and property management under the Alaska Landlord Tenant Act -- the state law portion of the Pearson VUE-administered Salesperson exam.',
    breakdown: [['Powers of the Real Estate Commission', '10%'], ['Licensing', '10%'], ['Licensee Duties & Disclosures to the Public', '28%'], ['Requirements Governing Licensee Activities', '25%'], ['Personal Services Agreements', '12%'], ['Property Management & Landlord Tenant Act', '15%']],
  },
  {
    examType: 'ak_re_broker',
    title: 'Alaska Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ak',
    duration: '240 Minutes (4 Hours, Single Combined Sitting)', questions: '140 Multiple Choice (80 National + 60 Alaska State Law)', passScore: 'Scaled Score of 75 (0-100 Scale, Not Raw Percent-Correct)',
    description: 'Practice questions covering Pearson VUE\'s national real estate broker content outline (real property characteristics, forms of ownership/title, property value and appraisal, contracts and agency, real estate practice, property disclosures and environmental issues, financing and settlement, and real estate math calculations) plus the Alaska State Law portion administered on behalf of the Alaska Real Estate Commission: powers of the Commission (including the real Recovery Fund with both a $15,000 per-transaction cap and a $50,000 per-licensee cap), licensing (mandatory Errors and Omissions insurance with real coverage minimums), licensee duties and disclosures to the public (Alaska\'s distinctive agency framework -- no default dual agency, a "neutral licensee" status requiring a separate standalone consent form, and a post-2005 "designated licensee" system letting different licensees at the same firm represent opposing sides), requirements governing the activities of licensees, personal services agreements, property management under the Alaska Landlord Tenant Act, and broker-only trust account, supervision, place of business, and recordkeeping topics. Unlike most other states, Alaska requires retaking the ENTIRE exam (both portions) if either section is failed, not just the failed portion. National and state portions are separately scored. Item counts and the scaled-score-75 passing rule are confirmed directly against Pearson VUE\'s official Alaska Candidate Handbook.',
    breakdown: [['Real Estate Math Calculations (National)', '9%'], ['Forms of Ownership & Title (National)', '9%'], ['Broker Only (AK)', '8%'], ['Contracts & Agency (National)', '8%'], ['Real Estate Practice (National)', '8%'], ['Financing & Settlement (National)', '8%'], ['Property Value & Appraisal (National)', '8%'], ['Real Property Characteristics (National)', '7%'], ['Property Disclosures & Environmental (National)', '7%'], ['Licensee Duties & Disclosures to the Public (AK)', '6%'], ['Property Management (AK)', '6%'], ['Powers of the Alaska Real Estate Commission (AK)', '5%'], ['Requirements Governing Licensee Activities (AK)', '5%'], ['Licensing (AK)', '4%'], ['Personal Services Agreements (AK)', '2%']],
  },
  {
    examType: 'al_re_salesperson',
    title: 'Alabama Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/al',
    duration: '60 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '28/40 Correct (70%)',
    description: 'Practice questions covering the Alabama Real Estate License Law (Code of Alabama 1975, Title 34, Chapter 27) and the Alabama Real Estate Commission\'s administrative rules (Alabama Administrative Code Title 790): violations and grounds for disciplinary action, licensing requirements, license status and the Commission\'s role, RECAD, trust funds and estimated closing statements, broker, company and place-of-business licenses, and the Recovery Fund and disciplinary process -- the state-specific portion of the Pearson VUE-administered Salesperson exam.',
    breakdown: [['Violations & Grounds for Disciplinary Action', '38%'], ['Licensing Requirements, License Status & Role of the Commission', '25%'], ['RECAD, Trust Funds & Estimated Closing Statements', '15%'], ['Broker, Company & Place-of-Business Licenses', '12%'], ['Recovery Fund & the Disciplinary Process', '10%']],
  },
  {
    examType: 'al_re_broker',
    title: 'Alabama Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/al',
    duration: '210 Minutes (2.5hr National + 1hr State)', questions: '120 Multiple Choice (80 National + 40 State-Specific)', passScore: 'Scaled Score of 70 (0-100 Scale)',
    description: 'Practice questions covering Pearson VUE\'s official Alabama Real Estate Broker exam content outline (administered on behalf of the Alabama Real Estate Commission, effective 2/1/2026): a National/General portion (80 items -- real property characteristics and legal descriptions, forms of ownership and title, property value and appraisal, real estate contracts and agency, real estate practice, property disclosures and environmental issues, financing and settlement, and real estate math calculations) plus an Alabama-specific portion (40 items -- licensing requirements, license status, broker/company/place-of-business licenses, the Recovery Fund, disciplinary actions and process, the estimated closing statement, trust funds, RECAD, and violations which may result in disciplinary action). A flat scaled score of 70 is required to pass, the same threshold for salespersons and brokers. Grounded in Ala. Code Title 34, Chapter 27 and Alabama Administrative Code Chapter 790-X, sourced primarily via the Alabama Real Estate Commission\'s own official site.',
    breakdown: [['Real Estate Contracts & Agency (National)', '13%'], ['Real Estate Practice (National)', '10%'], ['Violations & Disciplinary Actions (AL)', '10%'], ['Property Value & Appraisal (National)', '8%'], ['Real Property Characteristics (National)', '8%'], ['Property Disclosures & Environmental Issues (National)', '8%'], ['Forms of Ownership & Title (National)', '7%'], ['Financing & Settlement (National)', '7%'], ['Real Estate Math Calculations (National)', '7%'], ['Licensing Requirements (AL)', '5%'], ['Broker, Company & Place-of-Business Licenses (AL)', '5%'], ['RECAD (AL)', '4%'], ['Trust Funds (AL)', '3%'], ['Disciplinary Actions & Process (AL)', '3%'], ['License Status (AL)', '2%'], ['Estimated Closing Statement (AL)', '2%'], ['Recovery Fund (AL)', '1%']],
  },
  {
    examType: 'ar_re_salesperson',
    title: 'Arkansas Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ar',
    duration: '60 Minutes', questions: '30 Multiple Choice (State-Specific Portion)', passScore: '21/30 Correct (70%)',
    description: 'Practice questions covering Arkansas Real Estate License Law (Arkansas Code Annotated Title 17, Chapter 42) and the Arkansas Real Estate Commission\'s Rules and Regulations: statutory requirements governing licensee activities (advertising, trust funds, sales contracts, agency agreements and broker price opinions), agency relationships and disclosure duties, the Commission\'s duties and powers (including the Recovery Fund and license discipline), licensing requirements, and other statutory requirements including timeshares and reporting violations -- the Arkansas law portion of the Pearson VUE-administered Salesperson exam.',
    breakdown: [['Statutory Requirements Governing Licensee Activities', '47%'], ['Agency Relationships & Disclosures', '27%'], ['Duties & Powers of the Real Estate Commission', '13%'], ['Licensing Requirements', '7%'], ['Other Statutory Requirements', '6%']],
  },
  {
    examType: 'ar_re_broker',
    title: 'Arkansas Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ar',
    duration: '240 Minutes (4 Hours)', questions: '120 Multiple Choice (Unified National + Arkansas State Content)', passScore: 'Scaled Score of 70 (0-100 Scale)',
    description: 'Practice questions covering Pearson VUE\'s Arkansas Unified Real Estate Broker Examination -- a single comprehensive exam combining national and Arkansas-specific content rather than separately-timed sections: Duties and Authority of the Arkansas Real Estate Commission (including the Recovery Fund), Arkansas statutory licensure requirements, other Arkansas statutes (including the Time-Share Act and auction licensing), federal laws governing real estate (RESPA, TILA, fair housing, environmental disclosure), Broker Operations and Responsibilities (supervision, trust accounts, recordkeeping, advertising, compensation), Client and Customer Relationships and Agency Disclosures, real property characteristics and legal descriptions, valuation and appraisal, contracts/financing/settlement (including Arkansas\'s predominantly non-judicial foreclosure process), and property management (including Arkansas\'s distinctive absence of an implied warranty of habitability). Unlike most states, a failure on Arkansas\'s unified exam requires retaking the entire exam, not just the failed portion. Item counts, the scaled passing score of 70, and the unified exam structure are confirmed directly against Pearson VUE\'s official Arkansas Candidate Handbook and Content Outline PDFs.',
    breakdown: [['Broker Operations & Responsibilities', '18%'], ['Contracts, Financing & Settlement', '15%'], ['Client & Customer Relationships & Agency Disclosures', '12%'], ['Arkansas Statutory Requirements Governing Licensure', '10%'], ['Federal Laws Governing Real Estate', '10%'], ['Property Management', '10%'], ['Real Property Characteristics & Legal Descriptions', '10%'], ['Other Arkansas Statutory Requirements', '6%'], ['Property Valuation & Appraisal', '5%'], ['Duties & Authority of the Real Estate Commission', '4%']],
  },
  {
    examType: 'az_re_salesperson',
    title: 'Arizona Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/az',
    duration: '90 Minutes', questions: '60 Multiple Choice (State-Specific Portion)', passScore: '45/60 Correct (75%)',
    description: 'Practice questions covering the Arizona Department of Real Estate\'s Arizona Real Estate Law Book (A.R.S. Title 32, Chapter 20 and A.A.C. Title 4, Chapter 28): timeshares, membership camping and cemetery regulation; licensing, education and Department administration; disciplinary grounds, the Recovery Fund, advertising and conduct rules; definitions, trust accounts, property management and related consumer statutes; and subdivided and unsubdivided land sales -- ADRE\'s full regulatory scope for real estate licensees, which is broader than the narrower state-specific portion content outline published for the standard Pearson VUE-administered Salesperson exam.',
    breakdown: [['Timeshares, Membership Camping & Cemetery Regulation', '24%'], ['Licensing, Education & Department Administration', '22%'], ['Disciplinary Grounds, Recovery Fund, Advertising & Conduct Rules', '21%'], ['Definitions, Trust Accounts, Property Management & Consumer Statutes', '18%'], ['Subdivided & Unsubdivided Land Sales', '15%']],
  },
  {
    examType: 'az_re_broker',
    title: 'Arizona Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/az',
    duration: '315 Minutes', questions: '180 Multiple Choice (Single Combined Exam)', passScore: '135/180 Correct (75%)',
    description: 'Practice questions covering Pearson VUE\'s official Arizona Real Estate Broker Examination Content Outline (administered on behalf of the Arizona Department of Real Estate, ADRE): a single combined 180-item exam -- unlike some states, Arizona does not separately score a national and state portion. Topics include Arizona Real Estate Statutes (A.R.S. Title 32, Chapter 20), Commissioner\'s Rules (A.A.C. Title 4, Chapter 28), agency relationships and managerial duties, contracts, property interests and tenancies, government rights and land descriptions, encumbrances and title transfer, deed of trust foreclosure, escrow and trust accounting, fair housing and consumer protection, leases, property insurance and appraisal, Arizona water and environmental law, financing, and real estate math calculations. 15 additional unscored pretest items may appear during the sitting but do not count toward the 180-item score; 75% (135 of 180) is required to pass.',
    breakdown: [['Real Estate Statutes', '16%'], ['Encumbrances, Transfer of Title & Foreclosure', '9%'], ['Commissioner\'s Rules', '10%'], ['Agency Relationships & Managerial Duties', '8%'], ['Financing Concepts & Income Tax Aspects', '7%'], ['Government Rights, Land Descriptions & Development', '7%'], ['Escrow, Settlement & Accounting', '6%'], ['Fair Housing & Consumer Protection', '6%'], ['Leases & Leasehold Estates', '6%'], ['Arizona Water & Environmental Law', '6%'], ['Math Calculations', '6%'], ['Contracts & Contract Law', '5%'], ['Property Interests, Estates & Tenancies', '5%'], ['Property Insurance & Appraisal', '3%']],
  },
  {
    examType: 'co_re_salesperson',
    title: 'Colorado Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/co',
    duration: '110 Minutes', questions: '74 Multiple Choice (State Portion)', passScore: '53/74 Correct (71.6%)',
    description: 'Practice questions covering the Colorado Real Estate Manual, Colorado Revised Statutes Title 12, Article 10, and 4 CCR 725-1 (Rules Regarding Real Estate Brokers): brokerage relationships and agency duties, broker licensing (education, experience, application review, errors & omissions insurance, renewal and status changes), definitions and the statutory framework, broker compensation, trust and escrow accounts, contracts, standard forms and closing, employing broker supervision and firm policies, and disciplinary grounds, violations and enforcement -- the state portion of the PSI-administered Broker exam.',
    breakdown: [['Colorado Forms & Contracts', '31%'], ['Requirements Governing Licensee Activities', '15%'], ['Brokerage Relationships', '15%'], ['Closing & Settlement', '13%'], ['Additional Topics (Property Mgmt, Water Rights, Taxes, Fair Housing, Foreclosure)', '9%'], ['Licensing Requirements', '7%'], ['Record Keeping & Trust Accounts', '7%'], ['Duties & Powers of the Real Estate Commission', '3%']],
  },
  {
    examType: 'ct_re_salesperson',
    title: 'Connecticut Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ct',
    duration: '45 Minutes', questions: '35 Multiple Choice (State-Specific Portion)', passScore: '25/35 Correct (70%)',
    description: 'Practice questions covering Connecticut General Statutes Title 20, Chapter 392 (Real Estate Licensees) and its implementing Regulations of Connecticut State Agencies: Real Estate Commission powers, licensing requirements and registrations, licensee conduct covering deposits, disclosure, advertising and compensation, Connecticut real estate agency and designated-agency disclosure, and Connecticut-specific property, landlord-tenant and fair housing law -- the state-specific portion of the PSI-administered Salesperson exam.',
    breakdown: [['Real Estate Commission, Licensing Requirements & Registrations', '20%'], ['Licensee Conduct: Deposits, Disclosure, Advertising & Compensation', '31%'], ['Real Estate Agency, Disclosure & Designated Agency', '26%'], ['Connecticut-Specific Property, Landlord-Tenant & Fair Housing Law', '23%']],
  },
  {
    examType: 'ct_re_broker',
    title: 'Connecticut Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ct',
    duration: '180 Minutes (120 Min National + 60 Min State)', questions: '120 Multiple Choice (80 National + 40 State-Specific)', passScore: '75% on Both Portions',
    description: 'Practice questions covering PSI\'s national real estate broker content outline (property ownership, land use controls, valuation, financing, agency, property disclosures, contracts, leasing and property management, transfer of title, practice of real estate, and real estate calculations) plus the Connecticut-specific portion administered on behalf of the CT Department of Consumer Protection: broker licensing requirements, license status and branch office rules, the Real Estate Guaranty Fund and trust account handling, disciplinary authority and prohibited conduct, and Connecticut\'s own agency-disclosure and residential property condition disclosure statutes. Item count and the 75%-on-each-portion passing standard are confirmed directly against Connecticut Dept. of Consumer Protection sources. The 180-minute time allowance is derived from Connecticut\'s own confirmed 1.5-minute-per-item pacing (seen consistently in PSI\'s real Connecticut Salesperson bulletin: 80 national items/120 minutes and 30 state items/45 minutes) applied to the Broker exam\'s larger 40-item state portion, since Connecticut\'s Broker-specific candidate bulletin sits behind a JavaScript-only portal that could not be independently fetched.',
    breakdown: [['Contracts (National)', '10%'], ['Practice of Real Estate (National)', '8%'], ['General Principles of Agency (National)', '9%'], ['Licensing Requirements (CT)', '6%'], ['Property Condition & Disclosures (National)', '8%'], ['Financing (National)', '6%'], ['Real Estate Guaranty Fund & Trust Accounts (CT)', '3%'], ['Disciplinary Actions & Commission Authority (CT)', '3%'], ['Agency Relationships & Disclosures (CT)', '3%'], ['License Status & Broker Offices (CT)', '6%'], ['Property Ownership (National)', '5%'], ['Valuation & Market Analysis (National)', '5%'], ['Transfer of Title (National)', '4%'], ['Land Use Controls (National)', '4%'], ['Leasing & Property Management (National)', '4%'], ['Real Estate Calculations (National)', '3%']],
  },
  {
    examType: 'de_re_salesperson',
    title: 'Delaware Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/de',
    duration: '80 Minutes', questions: '40 Multiple Choice (Delaware State Portion)', passScore: 'Scaled Score of 70 (0–100 Scale)',
    description: 'Practice questions covering Delaware Code Title 24, Chapter 29 (Real Estate Services, Brokers, Associate Brokers and Salespersons) and the Delaware Real Estate Commission\'s Rules and Regulations (Title 24, Regulation 2900): the Commission\'s duties, powers and sanctions; licensing requirements; statutory requirements governing licensee conduct (advertising, broker/salesperson relationships, disclosures, handling of documents and monies, and public responsibility); and additional state topics including the Unit Property Act, the Delaware Uniform Common Interest Ownership Act, the Landlord-Tenant Code, transfer taxes, and the Delaware Fair Housing Act -- the state-specific portion of the Pearson VUE-administered Salesperson exam.',
    breakdown: [['Duties, Powers & Sanctions of the Real Estate Commission', '10%'], ['Licensing Requirements', '8%'], ['Statutory Requirements Governing Licensee Activities', '42%'], ['Additional State Topics (Condos, DUCIOA, Landlord-Tenant Code & Fair Housing)', '40%']],
  },
  {
    examType: 'de_re_broker',
    title: 'Delaware Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/de',
    duration: '240 Minutes (4 Hours, Single Combined Sitting)', questions: '130 Multiple Choice (80 National + 50 Delaware State-Specific)', passScore: 'Scaled Score of 70 (0-100 Scale, Not Raw Percent-Correct)',
    description: 'Practice questions covering Pearson VUE\'s national real estate broker content outline (real property characteristics, forms of ownership/title, property value and appraisal, contracts and agency, real estate practice, property disclosures and environmental issues, financing and settlement, and real estate math calculations) plus the Delaware-specific portion administered on behalf of the Delaware Real Estate Commission (DREC): the Commission\'s duties and powers (including the real Guaranty Fund cap of $50,000 per claim/transaction), licensing requirements (Delaware\'s real 5-year/3-active-year/30-transaction broker experience prerequisite plus a 99-hour pre-licensing course), the Statutory Requirements Governing the Activities of Licensees (by far the largest state section -- advertising, the broker/associate-broker/salesperson relationship, Delaware\'s real Seller\'s Disclosure of Real Property Condition Report and radon disclosure statutes, its distinctive Psychologically Impacted Properties rule, presumed dual agency, and the Rule 14 Voluntary Treatment Option for chemically dependent licensees), Additional State Topics (the Delaware Uniform Common Interest Ownership Act, Delaware\'s genuinely high combined Realty Transfer Tax, the Clear Zone Safety Law, and Delaware\'s pure-race recording statute), and Broker-only topics (escrow accounts, the Foreclosure Consultants Act, the New Home Buyer Protection Act, the Commercial Broker\'s Lien Act, and Mortgage Loan Modification Services). Delaware uniquely licenses Associate Broker and Broker candidates on the SAME exam, distinguished only by post-exam management-authority verification. National and state portions are scored and passed independently. Item counts, the real scaled-score-70 passing rule, and the 4-hour single combined sitting are confirmed directly against Pearson VUE\'s official Delaware Candidate Handbook.',
    breakdown: [['Statutory Requirements Governing Licensee Activities (DE)', '13%'], ['Additional State Topics (DE)', '12%'], ['Contracts & Agency (National)', '12%'], ['Real Estate Practice (National)', '9%'], ['Broker Only (DE)', '8%'], ['Property Value & Appraisal (National)', '8%'], ['Real Property Characteristics (National)', '8%'], ['Property Disclosures & Environmental (National)', '7%'], ['Forms of Ownership & Title (National)', '6%'], ['Financing & Settlement (National)', '6%'], ['Real Estate Math (National)', '6%'], ['Duties & Powers of the Commission (DE)', '3%'], ['Licensing Requirements (DE)', '2%']],
  },
  {
    examType: 'hi_re_salesperson',
    title: 'Hawaii Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/hi',
    duration: '90 Minutes', questions: '50 Multiple Choice (State-Specific Portion)', passScore: '35/50 Correct (70%)',
    description: 'Practice questions covering the Hawaii Real Estate Brokers and Salespersons Law (Hawaii Revised Statutes Chapter 467) and the Real Estate Commission\'s Administrative Rules (Hawaii Administrative Rules Title 16, Chapter 99) -- the state-specific portion of the PSI-administered Salesperson exam: professional practices and conduct (trust accounts, advertising, agency disclosure and disciplinary grounds), ascertaining and disclosing material facts, types of ownership (including condominiums and time sharing plans), contracts and addenda, title and conveyances, financing, property management, escrow and closing statements, and land utilization and zoning.',
    breakdown: [['Professional Practices & Conduct', '28%'], ['Ascertaining & Disclosing Material Facts', '16%'], ['Types of Ownership', '12%'], ['Contracts & Addenda', '12%'], ['Title & Conveyances', '8%'], ['Financing', '8%'], ['Property Management', '6%'], ['Escrow Process & Closing Statements', '6%'], ['Land Utilization', '4%']],
  },
  {
    examType: 'hi_re_broker',
    title: 'Hawaii Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/hi',
    duration: '240 Minutes (4 Hours)', questions: '125 Multiple Choice (75 National + 50 Hawaii State-Specific)', passScore: '75% (Each Section Scored Independently)',
    description: 'Practice questions covering PSI\'s national real estate broker content outline (property ownership, land use controls, valuation, financing, contracts, agency, property disclosures, property management, transfer of title, practice of real estate, and real estate calculations) plus the Hawaii-specific portion administered on behalf of the Hawaii Real Estate Commission (DCCA Real Estate Branch): Ascertaining and Disclosing Material Facts (HRS Chapter 508D seller disclosure timelines, HARPTA nonresident withholding, GET on commissions, the dual Bureau of Conveyances/Land Court recording system), Types of Ownership (condominiums, time sharing plans, cooperative housing corporations), Property Management (Hawaii\'s Residential Landlord-Tenant Code and broker-only commercial/trust-account duties), Land Utilization (Hawaii\'s distinctive statewide four-district land use classification system and Special Management Area coastal permitting), Title and Conveyances (the regular recording system vs. the Land Court/Torrens system, leasehold estates, and foreclosure), Contracts (disclosure-to-contract timing and the real Agreement of Sale seller-financing instrument), Financing, Escrow Process and Closing Statements (Hawaii\'s licensed independent escrow-depository closing practice), and Professional Practices and Conduct -- the largest state section, covering trust account rules, the real Recovery Fund ($25,000 per-transaction / $50,000 per-licensee caps), and the broker experience prerequisite (3 of the most recent 5 years as a full-time licensed salesperson). Unlike the Salesperson exam, each Broker section (national and state) is scored and passed independently at a flat 75%, and a candidate who fails one section retakes only that section within 2 years. Item counts, section weights, and the passing rule are confirmed directly against PSI\'s official Hawaii Candidate Information Bulletin.',
    breakdown: [['Contracts (National)', '12%'], ['Professional Practices & Conduct (HI)', '10%'], ['Agency (National)', '8%'], ['Practice of Real Estate (National)', '7%'], ['Property Ownership (National)', '6%'], ['Financing & Settlement (National)', '6%'], ['Ascertaining & Disclosing Material Facts (HI)', '5%'], ['Title & Conveyances (HI)', '5%'], ['Contracts (HI)', '5%'], ['Valuation (National)', '5%'], ['Transfer of Title (National)', '4%'], ['Real Estate Calculations (National)', '4%'], ['Property Disclosures (National)', '4%'], ['Property Management (HI)', '4%'], ['Escrow Process & Closing Statements (HI)', '3%'], ['Property Management (National)', '3%'], ['Land Use Controls (National)', '3%'], ['Types of Ownership (HI)', '2%'], ['Land Utilization (HI)', '2%'], ['Financing (HI)', '2%']],
  },
  {
    examType: 'ia_re_salesperson',
    title: 'Iowa Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ia',
    duration: '60 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '28/40 Correct (70%)',
    description: 'Practice questions covering Iowa Code Chapter 543B (Real Estate Brokers and Salespersons) and Iowa Administrative Code 193E (Real Estate Commission): licensing, qualifications, application and commission administration, definitions and agency relationships/fiduciary duties, brokerage agreements and broker-salesperson relationships, trust accounts, E&amp;O insurance and advertising, disciplinary grounds and unlicensed practice enforcement, continuing education and property disclosure/closing, and property management and wholesaling -- the state-specific portion of the PSI-administered Salesperson exam.',
    breakdown: [['Licensing, Qualifications, Application & Commission Administration', '20%'], ['Definitions, Agency Relationships & Fiduciary Duties', '16%'], ['Continuing Education, Property Disclosure & Closing', '16%'], ['Trust Accounts, E&O Insurance & Advertising', '14%'], ['Brokerage Agreements, Listings & Broker-Salesperson Relationships', '13%'], ['Disciplinary Grounds, Investigations & Unlicensed Enforcement', '13%'], ['Property Management & Wholesaling', '8%']],
  },
  {
    examType: 'ia_re_broker',
    title: 'Iowa Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ia',
    duration: '180 Minutes (3 Hours)', questions: '115 Multiple Choice (75 National + 40 Iowa State-Specific)', passScore: '90/120 Points Combined (60/80 National + 30/40 State)',
    description: 'Practice questions covering PSI\'s national real estate broker content outline (property ownership, land use controls, valuation, financing, contracts, agency, property disclosures, property management, transfer of title, practice of real estate including broker-only supervisory responsibilities, and real estate calculations) plus the Iowa-specific portion administered on behalf of the Iowa Real Estate Commission: licensing requirements and continuing education, license maintenance, disciplinary actions, trust accounts (broker-weighted), contracts, agency (including Iowa\'s distinctive designated/"appointed agent" framework under Iowa Code 543B.59), property disclosure requirements, the Iowa Civil Rights Act, unlicensed assistants, broker responsibilities and supervision, and property management. Broker candidates must already hold an active Iowa salesperson license for at least 24 months. Item counts and the real points-based passing thresholds (not literal percent-correct) are confirmed directly against the Iowa Real Estate Commission/PSI Licensing Information Bulletin.',
    breakdown: [['Contracts (National)', '19%'], ['Broker Responsibilities (IA)', '15%'], ['Agency (National)', '13%'], ['Practice of Real Estate incl. Supervisory Responsibilities (National)', '12%'], ['Property Ownership (National)', '10%'], ['Financing (National)', '9%'], ['Valuation (National)', '8%'], ['Property Disclosures (National)', '7%'], ['Contracts (IA)', '6%'], ['Transfer of Title (National)', '6%'], ['Real Estate Calculations (National)', '6%'], ['Agency (IA)', '5%'], ['Land Use Controls (National)', '5%'], ['Property Management (National)', '5%'], ['Trust Accounts (IA)', '4%'], ['License Maintenance (IA)', '4%'], ['Disciplinary Actions (IA)', '4%'], ['Property Disclosure Requirements & Civil Rights Act (IA)', '3%'], ['Property Management (IA)', '3%'], ['Licensing Requirements & Education (IA)', '2%'], ['Unlicensed Assistants (IA)', '2%']],
  },
  {
    examType: 'id_re_salesperson',
    title: 'Idaho Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/id',
    duration: '90 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: 'Scaled Score of 70 (Scale of 0-100)',
    description: 'Practice questions covering the Idaho Real Estate Commission\'s License Law and Rules (Idaho Code Title 54, Chapter 20 and IDAPA 24.37.01) -- the state-specific portion of the Salesperson exam: the Commission\'s duties and powers, licensing requirements, license law and rules governing advertising, trust accounts, document handling and prohibited conduct, brokerage representation and agency law, calculations and closing costs, and Idaho real estate principles and practices.',
    breakdown: [['License Law & Rules of the Real Estate Commission', '40%'], ['Brokerage Representation (Agency Law)', '25%'], ['Idaho Principles & Practices', '15%'], ['Licensing Requirements', '10%'], ['Duties & Powers of the Real Estate Commission', '5%'], ['Calculations & Closing Costs', '5%']],
  },
  {
    examType: 'id_re_broker',
    title: 'Idaho Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/id',
    duration: '240 Minutes (4 Hours)', questions: '130 Multiple Choice (80 National + 50 Idaho State-Specific)', passScore: 'Scaled Score of 75 (0-100 Scale)',
    description: 'Practice questions covering Pearson VUE\'s national real estate broker content outline (property ownership, forms of ownership and title, valuation and appraisal, contracts and agency, real estate practice, property disclosures and environmental issues, financing and settlement, and real estate math) plus the Idaho-specific portion administered on behalf of the Idaho Real Estate Commission (IREC): the Commission\'s duties and powers (including the Recovery Fund\'s real $10,000-per-licensee-per-year cap), licensing requirements across Idaho\'s three real license tiers (Salesperson, Associate Broker, and Designated Broker), License Law and Rules including trust account rules, Idaho\'s real Brokerage Representation Act (which has NO default agency relationship absent a written agreement, unlike some states), calculations and closing costs, Idaho Principles and Practices (including Idaho\'s community property law and prior-appropriation water rights doctrine), and the real broker-only Brokerage Management section covering designated-broker supervision and trust account fund caps. Item counts, the scaled passing score of 75, and the 4-hour time allowance are confirmed directly against Pearson VUE\'s official Idaho Candidate Handbook and Content Outline PDFs.',
    breakdown: [['License Law & Rules of IREC (ID)', '18%'], ['Brokerage Management (ID)', '12%'], ['Brokerage Representation/Agency (ID)', '12%'], ['Contracts & Agency (National)', '9%'], ['Idaho Principles & Practices (ID)', '7%'], ['Real Estate Practice (National)', '7%'], ['Calculations & Closing Costs (ID)', '6%'], ['Property Value & Appraisal (National)', '6%'], ['Property Ownership (National)', '6%'], ['Property Disclosures & Environmental (National)', '5%'], ['Financing & Settlement (National)', '5%'], ['Real Estate Math (National)', '5%'], ['Forms of Ownership & Title (National)', '5%'], ['Licensing Requirements (ID)', '2%'], ['Duties & Powers of the Commission (ID)', '2%']],
  },
  {
    examType: 'in_re_salesperson',
    title: 'Indiana Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/in',
    duration: '90 Minutes', questions: '50 Multiple Choice (State-Specific Portion)', passScore: 'Scaled Score of 75 on a 0-100 Scale (Not a Raw Percentage)',
    description: 'Practice questions covering Indiana Code Title 25, Article 34.1 (the Real Estate Broker Licensing Act) and 876 IAC (Indiana Administrative Code, Indiana Real Estate Commission): the Real Estate Commission\'s powers and disciplinary authority, licensing requirements and license maintenance, statutory and regulatory requirements (advertising, compensation, brokerage agreements), statutes and rules governing licensee conduct and agency relationships, and real estate office procedures -- the state-specific portion of the Pearson VUE-administered Broker exam.',
    breakdown: [['The Real Estate Commission', '10%'], ['Licensing', '18%'], ['Statutory & Regulatory Requirements', '24%'], ['Statutes & Rules Governing Licensees', '34%'], ['Real Estate Office Procedures', '14%']],
  },
  {
    examType: 'ks_re_salesperson',
    title: 'Kansas Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ks',
    duration: '90 Minutes', questions: '30 Multiple Choice (State-Specific Portion)', passScore: 'Scaled Score of 70 (0-100 Scale, Not a Raw Percentage)',
    description: 'Practice questions covering the Kansas Real Estate Brokers\' and Salespersons\' License Act (K.S.A. 58-3034 et seq.), the Brokerage Relationships in Real Estate Transactions Act (BRRETA), and Kansas Administrative Regulations, Agency 86: agency relationships, fiduciary duties and brokerage agreements; licensing, qualifications, renewal and continuing education; trust accounts, the Recovery Fund and advertising; disciplinary grounds, prohibited practices and unlicensed-activity enforcement; and Commission administration and statutory definitions -- our question bank spans the full License Act and its implementing regulations (including broker-only subject matter such as trust accounts and exam qualifications), which is broader than the narrower 30-item state-specific content outline published for the standard Pearson VUE-administered Salesperson exam.',
    breakdown: [['Agency Relationships, Fiduciary Duties & Brokerage Agreements', '27%'], ['Licensing, Qualifications, Renewal & Continuing Education', '27%'], ['Trust Accounts, Recovery Fund & Advertising', '19%'], ['Disciplinary Grounds, Prohibited Practices & Enforcement', '16%'], ['Commission Administration & Definitions', '11%']],
  },
  {
    examType: 'ks_re_broker',
    title: 'Kansas Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ks',
    duration: '240 Minutes (4 Hours)', questions: '120 Multiple Choice (80 National + 40 Kansas State-Specific)', passScore: 'Scaled Score of 70 (0-100 Scale)',
    description: 'Practice questions covering Pearson VUE\'s national real estate broker content outline (property ownership, forms of ownership and title, valuation and appraisal, contracts and agency, real estate practice, property disclosures and environmental issues, financing and settlement, and real estate math) plus the Kansas-specific portion administered on behalf of the Kansas Real Estate Commission (KREC): the Commission\'s duties and powers (including the real Recovery Revolving Fund), licensing requirements (including Kansas\'s real transaction-points broker-experience system), requirements governing licensee activities, prohibited acts and disciplinary process, the Brokerage Relationships in Real Estate Transactions Act (BRRETA) -- Kansas\'s real, distinctive statutory framework that defaults to transaction-broker status absent a written agreement and FLATLY PROHIBITS dual agency in favor of a designated-agency mechanism -- and real broker-only topics (licensure exemptions, trust fund handling, supervision of primary/branch offices, and out-of-state fee-sharing). Item counts, the scaled passing score of 70, and the 4-hour time allowance are confirmed directly against Pearson VUE\'s official Kansas Candidate Handbook and Content Outline PDFs.',
    breakdown: [['BRRETA (Brokerage Relationships) (KS)', '23%'], ['Requirements Governing Licensee Activities (KS)', '12%'], ['Prohibited Acts (KS)', '12%'], ['Contracts & Agency (National)', '9%'], ['Broker-Only Topics (KS)', '6%'], ['Real Estate Practice (National)', '7%'], ['Property Value & Appraisal (National)', '6%'], ['Property Ownership (National)', '6%'], ['Property Disclosures & Environmental (National)', '5%'], ['Financing & Settlement (National)', '5%'], ['Real Estate Math (National)', '5%'], ['Forms of Ownership & Title (National)', '5%'], ['Licensing Requirements (KS)', '2%'], ['Duties & Powers of the Commission (KS)', '2%']],
  },
  {
    examType: 'ky_re_salesperson',
    title: 'Kentucky Real Estate Sales Associate Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ky',
    duration: '90 Minutes', questions: '50 Multiple Choice (State-Specific Portion)', passScore: '38/50 Correct (76%)',
    description: 'Practice questions covering Kentucky Revised Statutes Chapter 324 and the Real Estate Commission\'s regulations at 201 KAR Chapter 11 -- the state-specific portion of the PSI-administered Sales Associate exam: brokerage activities and requirements, requirements for a license, disclosures and agency issues, license law requirements for contracts, Real Estate Commission powers and enforcement, and property management.',
    breakdown: [['Brokerage Activities & Requirements', '36%'], ['Requirements for a License', '20%'], ['Disclosures & Agency Issues', '16%'], ['License Law Requirements for Contracts', '12%'], ['Real Estate Commission Powers & Enforcement', '10%'], ['Property Management', '6%']],
  },
  {
    examType: 'ky_re_broker',
    title: 'Kentucky Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ky',
    duration: '240 Minutes (150 Min National + 90 Min State)', questions: '120 Multiple Choice (80 National + 40 State-Specific)', passScore: '75% on Both Portions',
    description: 'Practice questions covering PSI\'s official Kentucky Real Estate Commission content outline: a separately-scored, separately-timed National/General portion (80 items, 150 minutes -- property ownership, land use controls, valuation, financing, agency, property condition and disclosures, contracts, transfer of title, practice of real estate, real estate calculations, and specialty areas like 1031 exchanges and commercial property) plus a separately-scored Kentucky State portion (40 items, 90 minutes -- Kentucky Revised Statutes Chapter 324 and 201 KAR Chapter 11: Real Estate Commission powers and enforcement, requirements for a license, brokerage activities and requirements including trust accounts and the broker lien law, license law requirements for contracts, disclosures and agency issues, and property management). PSI\'s official Candidate Information Bulletin confirms 75% required to pass EACH portion independently. Broker eligibility requires 24 months of active sales-associate experience plus a mandatory KREC-approved brokerage management course.',
    breakdown: [['Contracts (National)', '10%'], ['Practice of Real Estate (National)', '10%'], ['Brokerage Activities & Requirements (KY)', '13%'], ['General Principles of Agency (National)', '9%'], ['Property Condition & Disclosures (National)', '8%'], ['Financing (National)', '6%'], ['Real Estate Commission Powers (KY)', '6%'], ['Requirements for a License (KY)', '6%'], ['Property Ownership (National)', '5%'], ['Valuation & Market Analysis (National)', '5%'], ['Transfer of Title (National)', '4%'], ['Land Use Controls (National)', '4%'], ['Real Estate Calculations (National)', '3%'], ['Specialty Areas (National)', '3%'], ['License Law Requirements for Contracts (KY)', '3%'], ['Disclosures & Agency Issues (KY)', '3%'], ['Property Management (KY)', '3%']],
  },
  {
    examType: 'la_re_salesperson',
    title: 'Louisiana Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/la',
    duration: '90 Minutes', questions: '55 Multiple Choice (State-Specific Portion)', passScore: 'Scaled Score of 70 (0-100 Scale, Not a Raw Percentage)',
    description: 'Practice questions covering the Louisiana Real Estate License Law (La. R.S. 37:1430-1470) and the Louisiana Real Estate Commission\'s Rules (Louisiana Administrative Code Title 46, Part LXVII): duties, overview and powers of the Real Estate Commission, investigations and discipline; licensing requirements, renewal, education and reciprocity; advertising, compensation, listings, offers and broker supervision; escrow/trust accounts, property management and recordkeeping; and agency relationships and required disclosures. This track covers License Law and Commission Rules subject matter only -- it does not include the separate Louisiana Civil Law System portion of the official state-specific content outline (property, successions, obligations/contracts, sales and leases under the Louisiana Civil Code), which Pearson VUE weights at roughly a quarter of the 55-item state-specific exam.',
    breakdown: [['Licensing, Renewal, Education & Reciprocity', '41%'], ['Commission Powers, Investigations & Discipline', '22%'], ['Advertising, Compensation, Listings & Broker Supervision', '21%'], ['Escrow, Trust Accounts, Property Management & Recordkeeping', '11%'], ['Agency Relationships & Disclosures', '5%']],
  },
  {
    examType: 'la_re_broker',
    title: 'Louisiana Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/la',
    duration: '240 Minutes (National + State Portions)', questions: '135 Multiple Choice (80 National + 55 State-Specific)', passScore: 'Scaled Score of 75 on Both Portions',
    description: 'Practice questions covering Pearson VUE\'s official Louisiana content outlines: an 80-item National/General portion (real property characteristics and legal descriptions, forms of ownership and title transfer, property value and appraisal, contracts and agency, real estate practice, property disclosures, financing and settlement, and real estate math) plus a 55-item Louisiana State portion covering the Louisiana Real Estate License Law and Commission Rules AND, unlike the standard Salesperson content bank, the full Louisiana Civil Law System -- Louisiana\'s unique civil-law property regime (movables/immovables, servitudes, usufruct, successions, redhibition, "privileges" in place of common-law liens, and lease reconduction) that Pearson VUE weights at roughly a quarter of the state-specific exam. Louisiana is the only U.S. state administering real estate licensing under a civil-law rather than common-law framework, making this one of the most distinctive state portions in the country.',
    breakdown: [['Real Estate Contracts and Agency (National)', '11%'], ['Louisiana Civil Law System (LA)', '10%'], ['Statutory Requirements Governing Licensees (LA)', '10%'], ['Louisiana Law of Agency (LA)', '10%'], ['Real Estate Practice (National)', '9%'], ['Real Property Characteristics & Legal Descriptions (National)', '7%'], ['Property Value and Appraisal (National)', '7%'], ['Property Disclosures & Environmental Issues (National)', '7%'], ['Licensing Requirements (LA)', '6%'], ['Forms of Ownership, Transfer & Recording of Title (National)', '6%'], ['Financing and Settlement (National)', '6%'], ['Real Estate Math Calculations (National)', '6%'], ['Duties & Powers of the Real Estate Commission (LA)', '4%']],
  },
  {
    examType: 'ma_re_salesperson',
    title: 'Massachusetts Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ma',
    duration: '90 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '28/40 Correct (70%)',
    description: 'Practice questions covering Massachusetts General Laws Chapter 112, Sections 87PP-87DDD 1/2 and 254 CMR 2.00-7.00 (Board of Registration of Real Estate Brokers and Salespersons) -- the state-specific portion of the PSI-administered Salesperson exam: license requirements and the broker-salesperson relationship, agency relationships, disclosure and the home inspection brochure, advertising, client funds and conflicts of interest, licensing fees and the broker surety bond, disciplinary grounds and complaints, continuing education, and apartment-finding fee disclosure and rental recordkeeping.',
    breakdown: [['Requirements Governing Licensees (Advertising, Agency, Disclosures & Commissions)', '33%'], ['Consumer Protection Laws', '12%'], ['Licensing Requirements', '10%'], ['Massachusetts Fair Housing Law', '10%'], ['Environmental Issues & Hazardous Materials', '10%'], ['Landlord Tenant Law', '10%'], ['Duties & Powers of the Board of Registration', '5%'], ['Contracts', '5%'], ['Additional Topics (Ownership, Condominiums & Registered Land)', '5%']],
  },
  {
    examType: 'ma_re_broker',
    title: 'Massachusetts Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ma',
    duration: '240 Minutes (150 Min General + 90 Min State)', questions: '115 Multiple Choice (75 General + 40 State-Specific)', passScore: '70% on Both Portions',
    description: 'Practice questions covering PSI Services LLC\'s official Massachusetts Real Estate Broker exam content outline (administered on behalf of the Division of Occupational Licensure Board of Registration of Real Estate Brokers and Salespersons): a separately-scored, separately-timed General portion (75 items -- property ownership, land use controls, valuation, financing, contracts, agency, property disclosures, property management, transfer of title, practice of real estate, and real estate calculations) plus a separately-scored Massachusetts-specific portion (40 items -- requirements governing licensees, licensing requirements, duties and powers of the Board, Massachusetts contract forms, consumer protection laws, environmental issues and hazardous materials including the Lead Law and Title 5 septic regulations, Massachusetts Fair Housing Law, landlord tenant law, and additional topics including registered land). PSI\'s own Candidate Information Bulletin confirms 70% required to pass EACH portion independently within a combined 4-hour time limit (150 minutes general, 90 minutes state); 5-10 unscored experimental items may also appear.',
    breakdown: [['Contracts (National)', '12%'], ['Requirements Governing Licensees (MA)', '12%'], ['Agency (National)', '8%'], ['Practice of Real Estate (National)', '8%'], ['Property Ownership (National)', '7%'], ['Financing (National)', '6%'], ['Valuation (National)', '5%'], ['Property Disclosures (National)', '5%'], ['Licensing Requirements (MA)', '4%'], ['Consumer Protection Laws (MA)', '4%'], ['Transfer of Title (National)', '4%'], ['Real Estate Calculations (National)', '4%'], ['Land Use Controls (National)', '3%'], ['Property Management (National)', '3%'], ['Environmental Issues & Hazardous Materials (MA)', '3%'], ['Massachusetts Fair Housing Law (MA)', '3%'], ['Landlord Tenant Law (MA)', '3%'], ['Duties & Powers of the Board (MA)', '2%'], ['Massachusetts Contract Forms (MA)', '2%'], ['Additional Topics (MA)', '2%']],
  },
  {
    examType: 'md_re_salesperson',
    title: 'Maryland Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/md',
    duration: '30 Minutes', questions: '30 Multiple Choice (State-Specific Portion)', passScore: '21/30 Correct (70%)',
    description: 'Practice questions covering the Maryland Real Estate Commission Law (Business Occupations and Professions Article, Title 17) and COMAR Title 09, Subtitle 11 -- the state-specific portion of the PSI-administered Salesperson exam: duties and powers of the Real Estate Commission, licensing requirements, brokerage relationships and required disclosures, supervision and handling of trust monies, business conduct (offers, commissions and advertising), and ethics.',
    breakdown: [['Brokerage Relationships: Listing Agreements & Disclosure', '24%'], ['Business Conduct: Offers, Commissions & Advertising', '20%'], ['Supervision: Trust Monies & Recordkeeping', '17%'], ['Duties & Powers of the Real Estate Commission', '13%'], ['Licensing Requirements', '13%'], ['Ethics', '13%']],
  },
  {
    examType: 'md_re_broker',
    title: 'Maryland Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/md',
    duration: '120 Minutes (90 Min National + 30 Min State)', questions: '115 Multiple Choice (75 National + 40 State-Specific)', passScore: '84/120 Points (70% on Both Portions)',
    description: 'Practice questions covering PSI Services LLC\'s official Maryland Real Estate Broker exam content outline (administered on behalf of the Maryland Real Estate Commission, bulletin id 529): a separately-scored National portion (75 items -- property ownership, land use controls, valuation, financing, contracts, agency, property disclosures, broker-level property management, transfer of title, broker-level practice of real estate and supervisory responsibilities, and real estate calculations) plus a separately-scored Maryland-specific portion (40 items -- duties and powers of the Real Estate Commission including the Guaranty Fund, licensing requirements, brokerage relationships and required disclosures, supervision and trust-monies handling, business conduct including offers/commissions/advertising, and ethics). Passing requires 56 of 80 National points AND 28 of 40 State points independently -- both national broker items scoring up to two points each -- within a combined 120-minute time limit, notably shorter than several other states\' broker exams despite a nearly identical 115-item/70%-pass structure. Grounded in the Annotated Code of Maryland Real Property Article Title 17 and COMAR Title 09, Subtitle 11.',
    breakdown: [['Contracts (National)', '12%'], ['Business Conduct (MD)', '8%'], ['Agency (National)', '8%'], ['Practice of Real Estate (National)', '8%'], ['Licensing Requirements (MD)', '7%'], ['Brokerage Relationships (MD)', '6%'], ['Financing (National)', '6%'], ['Supervision (MD)', '5%'], ['Valuation (National)', '5%'], ['Property Disclosures (National)', '5%'], ['Transfer of Title (National)', '4%'], ['Real Estate Calculations (National)', '4%'], ['Duties & Powers of the Commission (MD)', '4%'], ['Ethics (MD)', '4%'], ['Land Use Controls (National)', '3%'], ['Property Management (National)', '3%']],
  },
  {
    examType: 'me_re_salesperson',
    title: 'Maine Real Estate Sales Agent Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/me',
    duration: '90 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '75% (Scaled Score 75+)',
    description: 'Practice questions covering the Maine Real Estate Commission\'s Maine Law content outline -- grounded in 32 M.R.S. Chapter 114 and the Commission\'s Rules (Code of Maine Rules 02-039, Chapters 300-410): the Real Estate Commission\'s powers and enforcement, Maine laws and rules governing licensee activities (listings, offers, trust accounts, material disclosures and advertising), law of agency/brokerage relationships, Maine-specific principles and practices (property transfer, the Landlord-Tenant Act, condominium law and closings), and Maine land-use law (shoreland zoning, subdivisions and underground oil storage tanks) -- the state-specific Maine Law portion of the Pearson VUE-administered Sales Agent exam.',
    breakdown: [['Maine Real Estate Commission (Powers, Investigations & Sanctions)', '5%'], ['Maine Laws & Rules Governing Licensee Activities', '38%'], ['Law of Agency/Brokerage', '25%'], ['Maine-Specific Principles & Practices', '20%'], ['Maine Land-Use Law', '12%']],
  },
  {
    examType: 'mn_re_salesperson',
    title: 'Minnesota Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/mn',
    duration: '90 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '30/40 Correct (75%)',
    description: 'Practice questions covering Minnesota Statutes Chapter 82, Sections 82.55-82.89 (Real Estate Broker, Salesperson, and Closing Agent Licensing Law): licensing, fees, examinations, and pre-license/continuing education; agency disclosure and brokerage contracts; advertising, compensation, records, and prohibited practices; trust accounts and specialty business operations; and discipline, public information, and the real estate education research and recovery fund -- the state-specific portion of the PSI-administered Salesperson exam.',
    breakdown: [['Discipline, Penalties, Public Information & Recovery Fund', '20%'], ['Definitions, Pre-License Education & Continuing Education', '19%'], ['Advertising, Compensation, Records & Prohibited Practices', '19%'], ['Licensing, Fees, Examinations & Closing Agent Licensure', '17%'], ['Agency Disclosure & Brokerage Contracts', '16%'], ['Trust Accounts & Specialty Business Operations', '9%']],
  },
  {
    examType: 'mn_re_broker',
    title: 'Minnesota Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/mn',
    duration: '240 Minutes (2.5hr General + 1.5hr State)', questions: '135 Multiple Choice (75 General + 60 State-Specific)', passScore: '75% Correct',
    description: 'Practice questions covering PSI Services LLC\'s official Minnesota Real Estate Broker exam content outline (administered on behalf of the Minnesota Department of Commerce, bulletin id 10954): a General portion (75 items -- property ownership, land use controls, valuation, financing, contracts, agency, property disclosures, broker-level property management, transfer of title, broker-level practice of real estate and supervisory responsibilities, and real estate calculations) plus a Minnesota-specific portion (grounded in Minn. Stat. Chapter 82 -- Real Estate Brokerage License Law, interests in real property including common-interest ownership and landlord-tenant law, conveyance procedures and protection of parties including recording/registration and environmental disclosures, and financial instruments/obligations covering mortgages, contracts for deed, and foreclosure). A flat 75% correct is required to pass; candidates who pass one portion and fail the other need only retake the failed portion. Note: PSI\'s own published bulletin has a genuine internal arithmetic discrepancy between its summary table (60 state items) and its detailed category breakdown (which sums to 50) -- our content is proportionally sized using the more granular category breakdown while the exam mechanics reflect the real administered 135-item/75% structure.',
    breakdown: [['Real Estate Brokerage License Law (MN)', '22%'], ['Contracts (National)', '11%'], ['Interests in Real Property (MN)', '9%'], ['Conveyance Procedures & Protection of Parties (MN)', '8%'], ['Agency (National)', '7%'], ['Practice of Real Estate (National)', '7%'], ['Property Ownership (National)', '6%'], ['Financial Instruments, Obligations & Remedies (MN)', '5%'], ['Financing (National)', '5%'], ['Valuation (National)', '4%'], ['Property Disclosures (National)', '4%'], ['Transfer of Title (National)', '3%'], ['Real Estate Calculations (National)', '3%'], ['Property Management (National)', '3%'], ['Land Use Controls (National)', '3%']],
  },
  {
    examType: 'mo_re_salesperson',
    title: 'Missouri Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/mo',
    duration: '120 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '30/40 Correct (75%)',
    description: 'Practice questions covering the Missouri Real Estate Practice Act (RSMo Chapter 339) and the statutory Agency Relationships subchapter (RSMo 339.710-339.855) -- the state-specific portion of the PSI-administered Salesperson exam: definitions and licensing requirements, the Missouri Real Estate Commission\'s structure, license administration and fees, agency relationship definitions, disclosure, and designated agency/brokerage agreements, seller and buyer agency duties, escrow/trust accounts and compensation, and disciplinary grounds, enforcement, and licensee liability.',
    breakdown: [['Business Conduct & Practices', '42%'], ['Licenses & Application Requirements', '18%'], ['Disciplinary Proceedings & Enforcement', '15%'], ['Brokerage Relationships & Agency Disclosure', '15%'], ['General Rules, Definitions & Educational Requirements', '10%']],
  },
  {
    examType: 'mo_re_broker',
    title: 'Missouri Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/mo',
    duration: '270 Minutes (150 Min National + 120 Min State)', questions: '165 Multiple Choice (90 National + 75 State-Specific)', passScore: '75% on Both Portions',
    description: 'Practice questions covering PSI Services LLC\'s official Missouri Real Estate Broker exam content outline (administered on behalf of the Missouri Real Estate Commission): a separately-scored, separately-timed National portion (90 items -- property ownership, land use controls, valuation, financing, contracts, agency, property disclosures, broker-level property management, transfer of title, broker-level practice of real estate and supervisory responsibilities, and real estate calculations) plus a separately-scored Missouri-specific portion (75 items -- licenses and continuing education requirements, business conduct and practices including office/branch/personnel administration, advertising, escrow and trust accounts, earnest money disputes, closings and commissions, disciplinary proceedings, listing/offer/closing contract forms and costs, and brokerage relationships). PSI\'s official Missouri Real Estate Candidate Handbook confirms 75% required to pass EACH portion independently within a combined 270-minute time limit (150 minutes national, 120 minutes state); 5-10 unscored experimental items may also appear. Missouri\'s disciplinary process is notably distinctive: contested cases go first to the independent Administrative Hearing Commission, whose finding is not binding on the Real Estate Commission, which holds its own separate hearing to decide actual discipline. Missouri also imposes a real statutory minimum-services requirement (RSMo 339.780.7) that a broker must provide even under a limited-service listing agreement.',
    breakdown: [['Transactions, Escrow & Commissions (MO)', '10%'], ['Contracts (National)', '10%'], ['Office & Personnel Administration (MO)', '9%'], ['Agency (National)', '7%'], ['Practice of Real Estate (National)', '7%'], ['Listing, Offer & Closing Contract Forms and Costs (MO)', '7%'], ['Property Ownership (National)', '5%'], ['Financing (National)', '5%'], ['Licenses & Educational Requirements (MO)', '5%'], ['Disciplinary Proceedings (MO)', '5%'], ['Valuation (National)', '4%'], ['Property Disclosures (National)', '4%'], ['Brokerage Relationships (MO)', '4%'], ['Transfer of Title (National)', '3%'], ['Real Estate Calculations (National)', '3%'], ['Land Use Controls (National)', '3%'], ['Property Management (National)', '3%'], ['Advertising & Franchises (MO)', '3%'], ['Records & Property Management (MO)', '3%']],
  },
  {
    examType: 'ms_re_salesperson',
    title: 'Mississippi Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ms',
    duration: '90 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '30/40 Correct (75%)',
    description: 'Practice questions covering the Mississippi Real Estate Brokers License Law of 1954 (Miss. Code Ann. §§ 73-35-1 to 73-35-105) and the Mississippi Real Estate Commission Rules and Regulations (Title 30, Miss. Admin. Code, Parts 1601-1603): out-of-state brokers/developers, recordkeeping and advertising/marketing rules, the Commission\'s powers and duties, licensing requirements and license maintenance, agency disclosure and duties to parties, property condition disclosures and trust accounts, and broker responsibilities including supervision of sales associates -- the state-specific portion of the PSI-administered Salesperson exam.',
    breakdown: [['Out-of-State Brokers/Developers, Records & Advertising', '25%'], ['Commission Powers, Licensing Requirements & License Maintenance', '20%'], ['Agency Disclosure & Duties to Parties', '20%'], ['Property Condition Disclosures & Trust Accounts', '20%'], ['Broker Responsibilities & Supervision of Sales Associates', '15%']],
  },
  {
    examType: 'ms_re_broker',
    title: 'Mississippi Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ms',
    duration: '240 Minutes (4 Hours)', questions: '115 Multiple Choice (75 National + 40 Mississippi State-Specific)', passScore: '75% National / 80% State (Scored Separately)',
    description: 'Practice questions covering PSI\'s national real estate broker content outline (property ownership, land use controls, valuation, financing, contracts, agency including broker-only supervisory responsibilities, property disclosures, broker-level property management, transfer of title, practice of real estate/fair housing, and real estate calculations) plus the Mississippi-specific portion administered on behalf of the Mississippi Real Estate Commission (MREC): the Commission\'s powers and duties (Mississippi has no Recovery Fund -- only an internal License Fund), licensing requirements including the 2026-revised 120-classroom-hour broker coursework rule, property condition disclosures, agency disclosure and duties (Mississippi notably does not recognize designated/appointed agency -- every salesperson is a subagent of the broker), advertising/marketing/internet rules, out-of-state brokers and developers, trust accounts, broker responsibilities and supervision, and records/documents. Mississippi uniquely scores its two portions at DIFFERENT literal percent-correct thresholds -- 75% national, 80% state -- both confirmed directly against MREC\'s official PSI Candidate Information Bulletin and the current License Law.',
    breakdown: [['Contracts (National)', '19%'], ['Broker Operations (National)', '13%'], ['Agency Disclosure & Duties (MS)', '7%'], ['Practice of Real Estate & Fair Housing (National)', '10%'], ['Property Ownership (National)', '9%'], ['Financing (National)', '8%'], ['Valuation (National)', '7%'], ['Property Condition Disclosures (MS)', '5%'], ['Property Disclosures (National)', '6%'], ['Transfer of Title (National)', '5%'], ['Real Estate Calculations (National)', '5%'], ['Broker Responsibilities & Supervision (MS)', '4%'], ['Land Use Controls (National)', '4%'], ['Property Management (National)', '4%'], ['Records & Documents (MS)', '3%'], ['Licensing Requirements & Maintenance (MS)', '3%'], ['Commission Powers & Duties (MS)', '3%'], ['Advertising, Marketing & Internet (MS)', '3%'], ['Out-of-State Brokers & Developers (MS)', '3%'], ['Trust Accounts (MS)', '2%']],
  },
  {
    examType: 'mt_re_salesperson',
    title: 'Montana Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/mt',
    duration: '90 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: 'Scaled Score of 75 (0-100 Scale, Not Raw Percent-Correct)',
    description: 'Practice questions covering the Montana Real Estate License Act (Montana Code Annotated Title 37, Chapter 51) and the Montana Board of Realty Regulation\'s implementing rules (Administrative Rules of Montana Title 24, Chapter 210): licensee conduct, disclosure, compensation and trust funds, advertising and brokerage/listing agreements, additional topics including errors and omissions insurance and landlord-tenant law, licensing activities and renewal, and the Board\'s investigative and disciplinary powers — the state-specific portion of the Pearson VUE-administered Salesperson exam.',
    breakdown: [['Licensee Conduct, Disclosure, Compensation & Trust Funds', '70%'], ['E&O Insurance, Land Description, Landlord-Tenant & Foreclosure', '15%'], ['Licensing Activities, Renewal & Status Changes', '8%'], ['Board Powers: Investigations, Hearings & Sanctions', '7%']],
  },
  {
    examType: 'mt_re_broker',
    title: 'Montana Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/mt',
    duration: '240 Minutes (4 Hours)', questions: '120 Multiple Choice (80 National + 40 Montana State-Specific)', passScore: 'Scaled Score of 75 (0-100 Scale, Not Raw Percent-Correct)',
    description: 'Practice questions covering Pearson VUE\'s national real estate broker content outline (real property characteristics, forms of ownership/title, property value and appraisal, contracts and agency, real estate practice, property disclosures and environmental issues, financing and settlement, and real estate math calculations) plus the Montana-specific portion administered on behalf of the Montana Board of Realty Regulation: the Board\'s powers (investigations, hearings, sanctions), licensing (license-required activities, renewal, status changes), the Requirements Governing the Activities of Licensees (by far the largest state section -- advertising, the broker/salesperson relationship, unprofessional conduct, compensation, disclosure, agency duties including Montana\'s distinctive "statutory broker" default non-agency status and in-house designated-agent framework, and trust-fund handling), additional topics (errors and omissions insurance, land description, common interest ownership, landlord-tenant law, foreclosure and redemption, and the statute of frauds), and Broker-only topics (trust accounts, supervision, place of business, recordkeeping, and closing statements). Montana\'s Real Estate Recovery Fund was repealed in 2019 (House Bill 376); consumer protection today runs instead through the mandatory Errors and Omissions insurance requirement under MCA 37-51-325. National and state portions are scored and passed independently -- a candidate who fails one section retakes only that section. Item counts, the real scaled-score-75 passing rule, and the 240-minute time allowance are confirmed directly against Pearson VUE\'s official Montana Candidate Handbook.',
    breakdown: [['Requirements Governing Licensee Activities (MT)', '22%'], ['Contracts & Agency (National)', '12%'], ['Real Estate Practice (National)', '10%'], ['Real Property Characteristics (National)', '8%'], ['Property Value & Appraisal (National)', '8%'], ['Property Disclosures & Environmental (National)', '7%'], ['Financing & Settlement (National)', '7%'], ['Real Estate Math (National)', '7%'], ['Forms of Ownership & Title (National)', '7%'], ['Additional Broker Topics (MT)', '5%'], ['Additional Topics (MT)', '3%'], ['Licensing Agency Powers (MT)', '2%'], ['Licensing (MT)', '2%']],
  },
  {
    examType: 'nd_re_salesperson',
    title: 'North Dakota Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/nd',
    duration: '90 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '30/40 Correct (75%)',
    description: 'Practice questions covering North Dakota Century Code Chapter 43-23 (State Real Estate Commission) and the implementing rules at North Dakota Administrative Code Title 70 -- the state-specific portion of the PSI-administered Salesperson exam: agency relationships, fiduciary duties, broker/salesperson relationships, brokerage agreements, listings, advertising and trust account handling; licensing qualifications, applications, renewal, nonresident reciprocity and continuing education; commission administration, investigations, discipline and unlicensed-practice enforcement; and closing practices and the Real Estate Education, Research and Recovery Fund.',
    breakdown: [['Statutory Duties of Licensees: Agency, Advertising, Disclosure & Trust Accounts', '45%'], ['Licensing Requirements, Qualifications & Continuing Education', '29%'], ['Commission Powers, Discipline & Unlicensed Practice Enforcement', '16%'], ['Recovery Fund, Closing Statements & Additional Topics', '10%']],
  },
  {
    examType: 'nd_re_broker',
    title: 'North Dakota Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/nd',
    duration: '240 Minutes (4 Hours)', questions: '130 Multiple Choice (90 National + 40 North Dakota State-Specific)', passScore: '75% Correct on Each Portion',
    description: 'Practice questions covering PSI\'s national real estate broker content outline (property ownership, land use controls, valuation, financing, contracts, agency, property disclosures, property management, transfer of title, practice of real estate, and real estate calculations) plus the North Dakota-specific portion administered on behalf of the North Dakota Real Estate Commission (NDREC): the Commission\'s duties and powers (including the real distinction that unlicensed practice is a Class B misdemeanor while a trust-account violation is only an infraction), licensing requirements (North Dakota\'s real third license tier, Broker Associate, distinct from Salesperson and designated Broker), the Statutory Requirements Governing the Activities of Licensees (by far the largest state section, including broker-only branch office, trust account, and recordkeeping rules), and additional topics including North Dakota\'s Subdivided Lands Disposition Act, broker-only closing statement duties, and the Real Estate Education, Research, and Recovery Fund ($15,000 per-transaction and per-licensee caps). PSI\'s own official bulletin does not publish a per-section item breakdown for the state portion, so this practice bank\'s state-topic proportions are modeled on each section\'s real topical breadth rather than an official weighting. National and state portions are scored and passed independently. Item counts and the real literal 75% passing threshold on each portion are confirmed directly against PSI\'s official North Dakota Candidate Information Bulletin.',
    breakdown: [['Statutory Requirements Governing Licensee Activities (ND)', '15%'], ['Contracts (National)', '13%'], ['Agency (National)', '9%'], ['Practice of Real Estate (National)', '8%'], ['Property Ownership (National)', '7%'], ['Financing (National)', '6%'], ['Valuation (National)', '6%'], ['Licensing Requirements (ND)', '6%'], ['Duties & Powers of the Commission (ND)', '6%'], ['Property Disclosures (National)', '5%'], ['Land Use Controls (National)', '4%'], ['Transfer of Title (National)', '4%'], ['Real Estate Calculations (National)', '4%'], ['Additional Topics (ND)', '4%'], ['Property Management (National)', '3%']],
  },
  {
    examType: 'ne_re_salesperson',
    title: 'Nebraska Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ne',
    duration: '90 Minutes', questions: '50 Multiple Choice (State-Specific Portion)', passScore: '38/50 Correct (75% Minimum)',
    description: 'Practice questions covering the Nebraska Real Estate License Act (Neb. Rev. Stat. &sect;&sect; 81-885 to 81-885.56), the agency relationships statute (&sect;&sect; 76-2401 to 76-2430), and the Real Estate Commission\'s implementing rules (NAC Titles 299, 301 and 305) -- the licensing and regulatory portion of the state-specific Salesperson exam: qualifications, applications and licensing procedures, commission administration and disciplinary enforcement, agency relationships and fiduciary duties, trust accounts and errors and omissions insurance, advertising and brokerage agreements, and property condition disclosure, continuing education, nonresident reciprocity and subdivided land registration.',
    breakdown: [['Duties & Powers of the Real Estate Commission', '10%'], ['Licensing Requirements & Activities', '15%'], ['Statutory Requirements Governing Licensee Activities', '30%'], ['Agency: Duties, Disclosures & Transactions', '35%'], ['Additional Topics: Subdivided Land, Fair Housing & Equitable Interest', '10%']],
  },
  {
    examType: 'ne_re_broker',
    title: 'Nebraska Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ne',
    duration: '240 Minutes (4 Hours)', questions: '130 Multiple Choice (80 National + 50 Nebraska State-Specific)', passScore: '75% Correct on Each Portion',
    description: 'Practice questions covering Pearson VUE\'s national real estate broker content outline (property ownership, forms of ownership and title, valuation and appraisal, contracts and agency, real estate practice, property disclosures and environmental issues, financing and settlement, and real estate math) plus the Nebraska-specific portion administered on behalf of the Nebraska Real Estate Commission (NREC): the Commission\'s duties and powers (Nebraska has no Recovery Fund), licensing (including the real 2-year salesperson-experience broker requirement), Statutory Requirements Governing the Activities of Licensees (including the real 72-hour trust-deposit rule), Agency (governed by a wholly separate statute, Neb. Rev. Stat. &sect;&sect; 76-2401 to 76-2430, including Nebraska\'s real 2025 mandatory written buyer-representation-agreement rule), and additional topics including landlord-tenant law and property condition disclosure. Unlike some peer states, a Nebraska broker candidate who fails EITHER portion must retake the entire exam, not just the failed section. Item counts and the real literal 75% passing threshold on each portion are confirmed directly against Pearson VUE\'s official Nebraska Candidate Handbook and Content Outline PDFs.',
    breakdown: [['Statutory Requirements Governing Licensee Activities (NE)', '14%'], ['Agency (NE)', '12%'], ['Contracts & Agency (National)', '9%'], ['Real Estate Practice (National)', '7%'], ['Licensing (NE)', '5%'], ['Property Value & Appraisal (National)', '6%'], ['Property Ownership (National)', '6%'], ['Duties & Powers of the Commission (NE)', '4%'], ['Property Disclosures & Environmental (National)', '5%'], ['Financing & Settlement (National)', '5%'], ['Real Estate Math (National)', '5%'], ['Forms of Ownership & Title (National)', '5%'], ['Additional Topics (NE)', '4%']],
  },
  {
    examType: 'nh_re_salesperson',
    title: 'New Hampshire Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/nh',
    duration: '90 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '28/40 Correct (70%)',
    description: 'Practice questions covering the New Hampshire Real Estate Practice Act (RSA 331-A) and the Real Estate Commission\'s administrative rules (N.H. Code of Admin. Rules Rea 100-700): Commission administration and licensee definitions, licensing qualifications, applications, renewal, continuing education and nonresident reciprocity, agency relationships, fiduciary duties and brokerage agreements, advertising, trust accounts and property condition disclosure, and disciplinary grounds, investigations and barred practices -- the state-specific portion of the PSI-administered Salesperson exam.',
    breakdown: [['Licensing, Qualifications, Applications & Continuing Education', '31%'], ['Agency Relationships, Fiduciary Duties & Brokerage Agreements', '22%'], ['Advertising, Trust Accounts & Property Condition Disclosure', '19%'], ['Disciplinary Grounds, Investigations & Barred Practices', '15%'], ['Commission Administration & Definitions', '13%']],
  },
  {
    examType: 'nh_re_broker',
    title: 'New Hampshire Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/nh',
    duration: '240 Minutes (4 Hours)', questions: '115 Multiple Choice (75 National + 40 New Hampshire State-Specific)', passScore: '70% (Each Section Scored Independently)',
    description: 'Practice questions covering PSI\'s national real estate broker content outline (property ownership, land use controls, valuation, financing, contracts, agency, property disclosures, property management, transfer of title, practice of real estate, and real estate calculations) plus the New Hampshire-specific portion administered on behalf of the New Hampshire Real Estate Commission (NHREC): the Real Estate Commission\'s purpose, duties, and disciplinary authority (now centered in RSA Chapter 310 after a 2023 licensing-law reorganization), Licensure (including the real $25,000-minimum surety bond required of principal/managing brokers under RSA 331-A:14 -- New Hampshire has no Recovery Fund), Regulation of Licensee Conduct (advertising, branch offices, the real RSA 331-A:26 prohibited-conduct list, and three genuinely New Hampshire-specific property disclosure rules covering private water supply, insulation, and sewage disposal systems), Regulation of Agency Conduct (New Hampshire\'s real five-type statutory agency-relationship framework under RSA 331-A:25-a through 25-f, including a designated-agency mechanism and a non-fiduciary facilitator role), and New Hampshire Principles and Practice (human rights/fair housing under RSA 354-A, environmental disclosure law, the Condominium Act, planning and zoning, wetlands, taxation including the Real Estate Transfer Tax, manufactured housing, landlord-tenant law, recordation, and descent and distribution). Unlike some peer states, a New Hampshire broker candidate who fails one portion retakes only that portion, not the full exam. Item counts, section weights, and the flat 70% passing rule on each portion are confirmed directly against PSI\'s official New Hampshire Candidate Information Bulletin.',
    breakdown: [['Contracts (National)', '11%'], ['Regulation of Licensee Conduct (NH)', '10%'], ['Regulation of Agency Conduct (NH)', '10%'], ['NH Principles & Practice (NH)', '9%'], ['Agency (National)', '8%'], ['Practice of Real Estate (National)', '8%'], ['Property Ownership (National)', '7%'], ['Financing (National)', '6%'], ['Property Disclosures (National)', '5%'], ['Valuation (National)', '5%'], ['Licensure (NH)', '4%'], ['Transfer of Title (National)', '4%'], ['Real Estate Calculations (National)', '4%'], ['Real Estate Commission (NH)', '3%'], ['Land Use Controls (National)', '3%'], ['Property Management (National)', '3%']],
  },
  {
    examType: 'nj_re_salesperson',
    title: 'New Jersey Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/nj',
    duration: '60 Minutes', questions: '30 Multiple Choice (State-Specific Portion of a 110-Question Combo Exam)', passScore: '21/30 Correct (70%)',
    description: 'Practice questions covering the New Jersey Real Estate License Act (N.J.S.A. 45:15) and the Real Estate Commission\'s implementing regulations (N.J.A.C. 11:5) — the state-specific regulatory subject matter tested on the New Jersey portion of the PSI-administered Salesperson exam: licensing qualifications, pre-license and continuing education, and license fees; agency relationships under the 2024 Real Estate Consumer Protection Enhancement Act, advertising, referrals and licensee conduct; trust accounts, discipline and the Real Estate Guaranty Fund; the Real Estate Timeshare Act; and the Subdivided Lands Full Disclosure Act.',
    breakdown: [['Licensing Qualifications, Pre-License/Continuing Education & Fees', '29%'], ['Agency Relationships, Advertising & Licensee Conduct (NJAC)', '20%'], ['Trust Accounts, Discipline & Guaranty Fund', '20%'], ['Real Estate Timeshare Act', '18%'], ['Subdivided Lands Full Disclosure Act', '13%']],
  },
  {
    examType: 'nm_re_salesperson',
    title: 'New Mexico Real Estate Broker Examination', category: 'Real Estate Licensing', route: '/real-estate-salesperson/nm',
    duration: '60 Minutes', questions: '50 Multiple Choice (State-Specific Portion)', passScore: '38/50 Correct (75%)',
    description: 'Practice questions covering the New Mexico Real Estate Brokers and Salesmen Act (NMSA 1978 §§ 61-29-1 to 61-29-29) and the New Mexico Real Estate Commission\'s rules at NMAC Title 16, Chapter 61 -- the state-specific portion of the PSI-administered Broker Examination for New Mexico\'s Associate Broker license: licensing, qualifications, applications and commission administration, agency, fiduciary duties and broker relationships, trust accounts, the Real Estate Recovery Fund and errors and omissions insurance, advertising, property management and closing practices, continuing education, nonresident reciprocity and timeshare registration, and discipline, investigations and unlicensed practice enforcement.',
    breakdown: [['Licensing, Qualifications, Applications & Commission Administration', '24%'], ['Agency, Fiduciary Duties & Broker Relationships', '19%'], ['Trust Accounts, Recovery Fund & E&O Insurance', '17%'], ['Advertising, Property Management & Closing Practices', '15%'], ['Continuing Education, Nonresident Reciprocity & Timeshare Registration', '14%'], ['Discipline, Investigations & Unlicensed Enforcement', '11%']],
  },
  {
    examType: 'nv_re_salesperson',
    title: 'Nevada Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/nv',
    duration: '90 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '30/40 Correct (75%)',
    description: 'Practice questions covering Nevada Revised Statutes (NRS) Chapter 645 and Nevada Administrative Code (NAC) Chapter 645 -- Real Estate Brokers and Salespersons: licensing qualifications, examinations and license issuance, agency relationships and licensee duties, broker office supervision and trust accounts, brokerage agreements and advance fees, advertising and required disclosures, disciplinary grounds, investigations and hearings, and continuing education, business brokers and property management -- the state-specific portion of the Pearson VUE-administered Salesperson exam.',
    breakdown: [['Duties & Powers of the Commission', '2%'], ['Licensing Requirements', '3%'], ['Agency & Duties Owed', '20%'], ['License Practice, Supervision & Advertising', '24%'], ['Residential, CIC & Environmental Disclosures', '20%'], ['Contracts, Brokerage Agreements & Earnest Money', '23%'], ['Record Keeping & Trust Accounts', '3%'], ['Subdivisions, Timeshares, Water Rights & Solar', '5%']],
  },
  {
    examType: 'nv_re_broker',
    title: 'Nevada Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/nv',
    duration: '240 Minutes (150 Min National + 90 Min State)', questions: '130 Multiple Choice (80 National + 50 State-Specific)', passScore: '75% Correct on the Full Exam',
    description: 'Practice questions covering Pearson VUE\'s national real estate broker content outline (property ownership, forms of ownership and title, valuation and appraisal, contracts and agency, real estate practice, property disclosures and environmental issues, financing and settlement, and real estate math) plus the Nevada-specific portion administered on behalf of the Nevada Real Estate Division: duties and powers of the Real Estate Commission, broker licensing requirements including branch offices and cooperative certificates, Nevada\'s statutory agency and duties-owed disclosure framework, license practice standards, Nevada\'s Seller\'s Real Property Disclosure and common-interest-community resale disclosure laws, brokerage agreements and trust/earnest-money handling, record keeping, and special topics including subdivisions, timeshares, water rights and solar-access law. Item counts, the literal 75%-correct passing score (not a scaled score), and the 240-minute time allowance are confirmed directly against Pearson VUE\'s official Nevada Candidate Handbook and Content Outline, including the handbook\'s own Examination Time Allotted table.',
    breakdown: [['Contracts & Agency (National)', '12%'], ['Contracts (NV)', '9%'], ['Real Estate Practice (National)', '9%'], ['Agency & Duties Owed (NV)', '8%'], ['License Practice (NV)', '8%'], ['Property Value & Appraisal (National)', '8%'], ['Property Ownership (National)', '8%'], ['Property Disclosures & Environmental (National)', '7%'], ['Disclosures (NV)', '6%'], ['Financing & Settlement (National)', '6%'], ['Real Estate Math (National)', '6%'], ['Forms of Ownership & Title (National)', '6%'], ['Record Keeping (NV)', '3%'], ['Duties & Powers of the Commission (NV)', '2%'], ['Licensing Requirements (NV)', '2%'], ['Special Topics (NV)', '2%']],
  },
  {
    examType: 'ok_re_salesperson',
    title: 'Oklahoma Real Estate Provisional Sales Associate Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ok',
    duration: '90 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '70% Scaled Score (State-Specific Portion)',
    description: 'Practice questions covering the Oklahoma Real Estate License Code (59 O.S. § 858-101 et seq.) and Title 605 of the Oklahoma Administrative Code: laws and rules affecting Oklahoma real estate practice, the Oklahoma Broker Relationships Act, property management and landlord-tenant requirements, and mandatory property disclosures and hazards — Pearson VUE’s own four content areas for the state-specific portion of the Provisional Sales Associate exam — plus additional Code and Rules coverage (licensing and application, trust and escrow accounts, the Education and Recovery Fund, nonresident licensing, and investigations/discipline) that extends beyond that 40-item outline.',
    breakdown: [['Laws & Rules Affecting Oklahoma Real Estate Practice', '50%'], ['Oklahoma Broker Relationships Act', '20%'], ['Property Management', '15%'], ['Disclosures & Hazards', '15%']],
  },
  {
    examType: 'ok_re_broker',
    title: 'Oklahoma Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ok',
    duration: '240 Minutes (4 Hours)', questions: '135 Multiple Choice (Scored up to 140 Points)', passScore: '75% (105/140 Points)',
    description: 'Practice questions covering PSI\'s official Oklahoma Real Estate Commission content outline: a 75-item National/General portion (property ownership, land use controls, valuation, financing, agency, property disclosures, contracts -- the largest national section at 18% -- leasing and property management, transfer of title, practice of real estate, and real estate calculations) plus a 60-item Oklahoma State portion covering the Oklahoma Real Estate License Code (59 O.S. Ch. 20) and OAC Title 605 rules: laws and rules affecting Oklahoma practice, the distinctive Oklahoma Broker Relationships Act (Oklahoma brokers do not practice under the common-law of agency with consumers at all -- one of the most exam-relevant, counterintuitive facts on this exam), property management, disclosures and hazards, trust accounts and trust funds, and broker management (supervision, place of business, advertising oversight, trade names). PSI\'s official bulletin confirms 135 items scored up to 140 points (some scenario-based items are worth 2 points) with 75% (105/140) required to pass, in 4 hours.',
    breakdown: [['Contracts (National)', '10%'], ['Laws & Rules Affecting Oklahoma Practice (OK)', '15%'], ['Practice of Real Estate (National)', '8%'], ['Broker Management (OK)', '7%'], ['Oklahoma Broker Relationships Act (OK)', '7%'], ['General Principles of Agency (National)', '6%'], ['Property Ownership (National)', '6%'], ['Trust Accounts & Trust Funds (OK)', '6%'], ['Real Estate Calculations (National)', '4%'], ['Financing (National)', '4%'], ['Property Disclosures (National)', '4%'], ['Transfer of Title (National)', '4%'], ['Property Management (OK)', '5%'], ['Valuation & Market Analysis (National)', '4%'], ['Disclosures & Hazards (OK)', '4%'], ['Leasing & Property Management (National)', '3%'], ['Land Use Controls (National)', '3%']],
  },
  {
    examType: 'or_re_salesperson',
    title: 'Oregon Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/or',
    duration: '90 Minutes', questions: '50 Multiple Choice (State-Specific Portion)', passScore: '38/50 Correct (76%)',
    description: 'Practice questions covering Oregon Revised Statutes Chapter 696 (Real Estate and Escrow Activities) and Oregon Administrative Rules Chapter 863 (Real Estate Agency) -- the state-specific portion of the PSI-administered Broker license exam: Oregon real estate related statutes, regulation of broker activities and broker/principal broker relationships, license law and disciplinary measures, agency law and rules, document handling and recordkeeping, property management, and handling of clients\' funds. Oregon\'s entry-level license is titled "Real Estate Broker" (the supervisory tier is a separate "Principal Broker" license); this track also draws on broader ORS 696/OAR 863 subject matter -- escrow agent licensing, real estate property manager licensing, and marketing organization/wholesaling regulation -- that goes beyond PSI\'s official 50-item Broker State Section outline.',
    breakdown: [['Oregon Real Estate Related Statutes', '30%'], ['Regulation of Broker Activities', '24%'], ['License Law & Disciplinary Measures', '12%'], ['Agency Law & Rules', '10%'], ['Document Handling & Recordkeeping', '10%'], ['Property Management', '8%'], ['Handling of Clients\' Funds', '6%']],
  },
  {
    examType: 'or_re_broker',
    title: 'Oregon Principal Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/or',
    duration: '240 Minutes (150 Min National + 90 Min State)', questions: '125 Multiple Choice (75 National + 50 State-Specific)', passScore: '75% on Each Section',
    description: 'Practice questions covering PSI\'s national principal broker content outline (property ownership, encumbrances and land use controls, contracts/agency/disclosure, financing and settlement, real estate calculations, valuation and appraisal, practice of real estate and fair housing, and property management and leasing) plus the Oregon-specific portion administered on behalf of the Oregon Real Estate Agency (REA): licensing requirements, license law and disciplinary measures, handling of clients\' funds and the recovery fund, regulation of broker activities, agency law and rules, and Oregon real estate related statutes. Oregon\'s entry-level real estate license is itself called "Broker" (see this site\'s own Oregon Real Estate track); this exam is for the supervisory "Principal Broker" tier above it. Item counts, the 75%-on-each-section passing standard, and the 240-minute time allowance are confirmed directly from PSI\'s official Oregon candidate bulletin. Note: PSI scores some Principal Broker national items at up to 2 points each (75 items are worth 80 total points) -- this site\'s practice mock exam uses a straightforward percent-correct-of-125-items approximation, since that real point-weighting can\'t be replicated in a simple correct-count score.',
    breakdown: [['Regulation of Broker Activities (OR)', '10%'], ['Oregon Real Estate Related Statutes (OR)', '12%'], ['Contracts, Agency & Disclosure (National)', '10%'], ['Financing & Settlement (National)', '9%'], ['Practice of Real Estate & Fair Housing (National)', '9%'], ['Property Valuation & Appraisal (National)', '8%'], ['Property Ownership (National)', '8%'], ['Property Management & Leasing (National)', '8%'], ['Encumbrances & Land Use Controls (National)', '7%'], ['Real Estate Calculations (National)', '7%'], ['License Law & Disciplinary Measures (OR)', '5%'], ['Handling of Clients\' Funds & Recovery Fund (OR)', '4%'], ['Agency Law & Rules (OR)', '3%']],
  },
  {
    examType: 'ri_re_salesperson',
    title: 'Rhode Island Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ri',
    duration: '90 Minutes', questions: '50 Multiple Choice (State-Specific Portion)', passScore: 'Scaled Score of 70 (0-100 Scale)',
    description: 'Practice questions covering Rhode Island\'s real estate licensing law -- R.I. Gen. Laws Chapter 5-20.5 (Real Estate Brokers and Salespersons), Chapter 5-20.6 (Relationships in Residential Real Estate Transactions), and Chapter 5-20.8 (Real Estate Sales Disclosures), together with the Real Estate Commission\'s implementing rule at 230-RICR-30-20-2 -- the state-specific portion of the Pearson VUE-administered Salesperson exam: Department/Commission duties and obligations, licensing requirements and eligibility (including the Recovery Account and E&amp;O insurance), statutory requirements governing licensee conduct (advertising, disclosure, trust funds, commissions and agency relationships), and additional Rhode Island-specific topics such as Fair Housing, landlord-tenant law, lead and property-condition disclosures, and nonresident transactions.',
    breakdown: [['Duties &amp; Obligations Under Licensing Law (Department &amp; Real Estate Commission)', '4%'], ['Licensing Requirements, Eligibility, Recovery Account &amp; E&amp;O Insurance', '12%'], ['Statutory Requirements Governing Licensees (Advertising, Disclosure, Trust Funds &amp; Commissions)', '48%'], ['Additional RI-Specific Topics (Fair Housing, Landlord-Tenant, Disclosures &amp; Related Statutes)', '36%']],
  },
  {
    examType: 'ri_re_broker',
    title: 'Rhode Island Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ri',
    duration: '4.0 Hours (2 Separately-Timed Parts)', questions: '140 Multiple Choice (80 National + 60 Rhode Island State-Specific)', passScore: 'Scaled Score of 70 (0-100 Scale, Each Part Independent)',
    description: 'Practice questions covering Pearson VUE\'s national real estate broker content outline (real property characteristics, forms of ownership/title, property value and appraisal, contracts and agency, real estate practice, property disclosures and environmental issues, financing and settlement, and real estate math calculations) plus the Rhode Island-specific portion administered on behalf of the RI Dept. of Business Regulation (DBR): DBR\'s and the Real Estate Commission\'s duties and authority, licensing requirements (including the real Real Estate Recovery Account and Errors &amp; Omissions insurance eligibility rules), the Statutory Requirements Governing the Activities of Licensees (the largest state section -- advertising, the broker/salesperson relationship, commissions, disclosure, handling of documents and monies, listings, unfair inducements, and Rhode Island\'s real, narrow unauthorized-practice-of-law exemption), additional Rhode Island-specific statutes (Fair Housing, landlord-tenant law, onsite wastewater/cesspool law, non-resident seller withholding, lead disclosure, the Real Estate Sales Disclosure Act, the Condominium Act, and agency-relationship types), and a Broker-only section (place of business, office policies, commingling, escrow accounts, the license-required-for-ownership rule, and investigations/hearings/sanctions). Rhode Island DOES have a real Recovery Account under R.I. Gen. Laws 5-20.5-5 -- a $50,000 per-licensee cap, replenished when the account balance falls below $200,000. The National/General and State portions are separately scheduled, scored, and passed exams -- a candidate who fails one retakes only that part, each valid for one year. Item counts, the real scaled-score-70 passing rule, and per-part time allowances are confirmed directly against Pearson VUE\'s official Rhode Island Candidate Handbook.',
    breakdown: [['Statutory Requirements Governing Licensees (RI)', '16%'], ['Additional RI-Specific Topics', '13%'], ['Contracts & Agency (National)', '10%'], ['Real Estate Practice (National)', '9%'], ['Broker Only (RI)', '9%'], ['Real Property Characteristics (National)', '7%'], ['Property Value & Appraisal (National)', '7%'], ['Forms of Ownership & Title (National)', '6%'], ['Property Disclosures & Environmental (National)', '6%'], ['Financing & Settlement (National)', '6%'], ['Real Estate Math (National)', '6%'], ['Licensing Requirements (RI)', '4%'], ['Duties & Obligations Under Licensing Law (RI)', '1%']],
  },
  {
    examType: 'sc_re_salesperson',
    title: 'South Carolina Real Estate Associate Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/sc',
    duration: '80 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '28/40 Correct (70%)',
    description: 'Practice questions covering the South Carolina Real Estate License Act (S.C. Code Title 40, Chapter 57) and the Real Estate Commission\'s Regulations (S.C. Code of Regulations, Chapter 105): the Commission\'s powers and licensing requirements, statutes governing licensee and non-licensee conduct (advertising, compensation, disclosure, and handling of monies), South Carolina agency and non-agency relationships, additional South Carolina statutes (residential property disclosure, fair housing, landlord-tenant and consumer protection topics), and closing details -- the state-specific portion of the PSI-administered Real Estate Associate exam.',
    breakdown: [['Real Estate Commission & Licensing Requirements', '22%'], ['Statutes Governing Licensee & Non-Licensee Activities', '28%'], ['SC Agency & Non-Agency Relationships & Issues', '28%'], ['Additional SC Statutes & Topics', '15%'], ['Closing Details', '7%']],
  },
  {
    examType: 'sc_re_broker',
    title: 'South Carolina Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/sc',
    duration: '200 Minutes (120 Min National + 80 Min State)', questions: '125 Multiple Choice (75 National + 50 State-Specific)', passScore: '96/125 Points (60/80 National + 36/50 State)',
    description: 'Practice questions covering PSI Services LLC\'s official South Carolina Real Estate Broker exam content outline (administered on behalf of the SC Real Estate Commission, bulletin id 441): a separately-scored National portion (75 items -- property ownership, land use controls, valuation, financing, contracts, agency, property disclosures, broker-level property management, transfer of title, broker-level practice of real estate and supervisory responsibilities, and real estate calculations) plus a separately-scored South Carolina-specific portion (50 items -- Commission powers and licensing requirements, statutes governing licensee and non-licensee activities including advertising and trust-money handling, South Carolina agency and non-agency relationships, additional South Carolina statutes such as the Residential Property Condition Disclosure Act, Fair Housing Law, and Landlord-Tenant Act, and closing details). Passing requires 60 of 80 National points AND 36 of 50 State points independently, within a combined 200-minute time limit. Grounded in S.C. Code Ann. Title 40, Chapter 57 -- notably, South Carolina requires a licensed attorney to conduct residential real estate closings (State v. Buyers Service Co.), a genuine state-specific practice this bank covers under Closing Details.',
    breakdown: [['Statutes Governing Licensees & Non-Licensees (SC)', '13%'], ['Contracts (National)', '11%'], ['SC Agency & Non-Agency Relationships (SC)', '10%'], ['Agency (National)', '8%'], ['Commission & Licensing Requirements (SC)', '8%'], ['Practice of Real Estate (National)', '7%'], ['Property Ownership (National)', '6%'], ['Additional SC Statutes & Topics (SC)', '6%'], ['Valuation (National)', '5%'], ['Financing (National)', '5%'], ['Property Disclosures (National)', '4%'], ['Transfer of Title (National)', '4%'], ['Real Estate Calculations (National)', '4%'], ['Land Use Controls (National)', '3%'], ['Property Management (National)', '3%'], ['Closing Details (SC)', '3%']],
  },
  {
    examType: 'sd_re_salesperson',
    title: 'South Dakota Real Estate Broker Associate Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/sd',
    duration: '120 Minutes', questions: '52 Multiple Choice (State-Specific Portion)', passScore: '39/52 Correct (75%)',
    description: 'Practice questions covering South Dakota real estate licensing law (SDCL Title 36, Chapter 21A) and the Real Estate Commission\'s rules (ARSD Article 20:69) -- the state portion of the PSI-administered Broker Associate exam (South Dakota\'s entry-level real estate license): licensing, qualifications, applications and Commission administration; agency, fiduciary duties, disclosure and brokerage relationships; trust accounts, advertising, errors and omissions insurance and the recovery fund; discipline, investigations, unlicensed practice and continuing education; and property management and closing practices.',
    breakdown: [['Licensing, Qualifications, Applications & Commission Administration', '30%'], ['Agency, Fiduciary Duties, Disclosure & Brokerage Relationships', '21%'], ['Trust Accounts, Advertising, E&O Insurance & Recovery Fund', '20%'], ['Discipline, Investigations, Unlicensed Practice & Continuing Education', '17%'], ['Property Management & Closing/Barred Practices', '12%']],
  },
  {
    examType: 'tn_re_salesperson',
    title: 'Tennessee Real Estate Affiliate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/tn',
    duration: '80 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '28/40 Correct (70%)',
    description: 'Practice questions covering the Tennessee Real Estate Broker License Act of 1973 (Tenn. Code Ann. Title 62, Chapter 13) and the Real Estate Commission\'s Rules (Tenn. Comp. R. and Regs. Chapter 1260) -- the state-specific portion of the PSI-administered Affiliate Broker exam: Commission powers and licensing requirements, advertising and marketing, broker/affiliate relationships, handling of documents, trust/escrow funds and consumer protection, agency and disclosure issues, and special areas of practice -- plus additional Tennessee-specific licensing topics (vacation lodging and rental location agents, time-share programs, and commercial real estate broker liens) drawn from the same statute and rules.',
    breakdown: [['Documents, Trust/Escrow Funds & Consumer Protection', '27%'], ['Commission Powers & Licensing Requirements', '20%'], ['Advertising & Marketing', '18%'], ['Agency & Disclosure Issues', '15%'], ['Broker/Affiliate Relationships', '13%'], ['Special Areas of Practice', '7%']],
  },
  {
    examType: 'tn_re_broker',
    title: 'Tennessee Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/tn',
    duration: '4 Hours (150 Min National + 90 Min State)', questions: '125 Multiple Choice (75 National + 50 State-Specific)', passScore: '75% on Both Portions (60/80 National, 38/50 State)',
    description: 'Practice questions covering PSI Services LLC\'s official Tennessee Real Estate Broker exam content outline (administered on behalf of the Tennessee Real Estate Commission, TREC): a separately-scored, separately-timed National portion (75 items, up to 80 points -- property ownership, land use controls, valuation, financing, contracts, agency, property disclosures, property management, transfer of title, practice of real estate, and real estate calculations) plus a separately-scored Tennessee-specific portion (50 items -- TREC\'s duties and powers, licensing requirements, advertising and marketing, broker/affiliate relationships, handling of documents and recordkeeping, handling of trust and escrow funds, other improper activities and consumer protection, agency and disclosure issues, and special areas of practice, grounded in the Tennessee Real Estate Broker License Act of 1973, Tenn. Code Ann. Title 62, Chapter 13, and TREC Rules, Tenn. Comp. R. and Regs. Chapter 1260). PSI\'s own Candidate Information Bulletin confirms 75% required to pass EACH portion independently (60 of 80 national points, 38 of 50 state items) within a combined 4-hour time limit (150 minutes national, 90 minutes state); 5-10 unscored experimental items may also appear.',
    breakdown: [['Contracts (National)', '11%'], ['Agency (National)', '8%'], ['Practice of Real Estate (National)', '7%'], ['Property Ownership (National)', '6%'], ['Financing (National)', '5%'], ['Valuation (National)', '5%'], ['Property Disclosures (National)', '4%'], ['Real Estate Calculations (National)', '4%'], ['Transfer of Title (National)', '4%'], ['Land Use Controls (National)', '3%'], ['Property Management (National)', '3%'], ['Advertising & Marketing (TN)', '6%'], ['Handling of Trust & Escrow Funds (TN)', '6%'], ['Duties & Powers of the Commission (TN)', '5%'], ['Broker & Affiliate Relationships (TN)', '5%'], ['Handling of Documents & Recordkeeping (TN)', '5%'], ['Agency & Disclosure Issues (TN)', '5%'], ['Licensing Requirements (TN)', '4%'], ['Other Improper Activities & Consumer Protection (TN)', '2%'], ['Special Areas of Practice (TN)', '2%']],
  },
  {
    examType: 'ut_re_salesperson',
    title: 'Utah Real Estate Sales Agent Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ut',
    duration: '90 Minutes', questions: '50 Multiple Choice (Utah State-Specific Portion)', passScore: 'Scaled Score of 70 (0-100 Scale)',
    description: 'Practice questions covering the Utah Real Estate Licensing and Practices Act (Utah Code Title 61, Chapter 2f) and its implementing regulations, Utah Administrative Code R162-2f: licensee practice (advertising, handling money, agency relationships and disclosure, and approved forms), licensing and license maintenance, real estate office procedures and trust accounts, enforcement and disciplinary action, closing statements, and property management &mdash; the Utah state-law portion of the Pearson VUE-administered Sales Agent exam.',
    breakdown: [['Licensee Practice: Advertising, Money Handling, Agency & Approved Forms', '33%'], ['Licensing, Qualifications & License Maintenance', '16%'], ['Definitions, Property Management, Education/Recovery Fund & Additional State Topics', '19%'], ['Closing Statements', '14%'], ['Real Estate Office Procedures & Trust Accounts', '9%'], ['Enforcement & Disciplinary Action', '9%']],
  },
  {
    examType: 'ut_re_broker',
    title: 'Utah Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ut',
    duration: '240 Minutes (4 Hours)', questions: '170 Multiple Choice (80 National + 90 Utah State-Specific)', passScore: 'Scaled Score of 75 (0-100 Scale)',
    description: 'Practice questions covering Pearson VUE\'s national real estate broker content outline (property ownership, forms of ownership and title, valuation and appraisal, contracts and agency, real estate practice, property disclosures and environmental issues, financing and settlement, and real estate math) plus the Utah-specific portion administered on behalf of the Utah Division of Real Estate: real estate definitions and the Division\'s "one act for compensation" licensing trigger, broker licensing and continuing education, the large Licensee Practice section covering conduct, commissions, discharge/termination, administrative procedures and approved forms including the Real Estate Purchase Contract (REPC), disciplinary grounds and enforcement, the Real Estate Education, Research and Recovery Fund, a named grab-bag of additional Utah topics (fractionalized estates, the Timeshare and Camp Resort Act, water rights, mechanic\'s liens, the Residence Lien Restriction and Lien Recovery Fund, property taxes, foreclosure, the Sex Offender Registry Act and stigmatized-property law), property management, and closing statements. Item counts, the scaled passing score of 75 (not literal percent-correct), and the 4-hour time allowance are confirmed directly against Pearson VUE\'s official Utah Candidate Handbook and Content Outline PDFs.',
    breakdown: [['Licensee Practice (UT)', '20%'], ['Contracts & Agency (National)', '9%'], ['Licensing (UT)', '9%'], ['Real Estate Practice (National)', '7%'], ['Property Value & Appraisal (National)', '6%'], ['Property Ownership (National)', '6%'], ['Disciplinary Action (UT)', '6%'], ['Property Disclosures & Environmental (National)', '5%'], ['Additional Utah Topics', '5%'], ['Financing & Settlement (National)', '5%'], ['Real Estate Math (National)', '5%'], ['Forms of Ownership & Title (National)', '5%'], ['Closing Statements (UT)', '4%'], ['Definitions (UT)', '4%'], ['Property Management (UT)', '3%'], ['Recovery Fund (UT)', '2%']],
  },
  {
    examType: 'vt_re_salesperson',
    title: 'Vermont Real Estate Salesperson State Examination', category: 'Real Estate Licensing', route: '/real-estate-salesperson/vt',
    duration: '45 Minutes', questions: '40 Multiple Choice (Vermont-Specific Practice Set)', passScore: '30/40 Correct (75%)',
    description: 'Practice questions covering 26 V.S.A. Chapter 41 (Real Estate Brokers and Salespersons) and the Vermont Real Estate Commission\'s Administrative Rules: definitions, licensing qualifications and commission administration, applications, renewal and continuing education, agency disclosure, fiduciary duties and brokerage agreements, disciplinary grounds and unlicensed practice enforcement, trust accounts and advertising, and property condition disclosure and closing practices -- the genuinely Vermont-specific subject matter tested on the OPR-administered State Examination, distinct from PSI\'s National Examination.',
    breakdown: [['Agency Disclosure, Fiduciary Duties & Brokerage Agreements', '23%'], ['Definitions, Licensing Qualifications & Commission Administration', '21%'], ['Applications, Renewal, Continuing Education & Reciprocity', '17%'], ['Disciplinary Grounds, Investigations & Unlicensed Practice', '14%'], ['Trust Accounts & Advertising', '13%'], ['Property Condition Disclosure & Closing Practices', '12%']],
  },
  {
    examType: 'vt_re_broker',
    title: 'Vermont Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/vt',
    duration: '240 Minutes (4 Hours, Practice Benchmark)', questions: '140 Multiple Choice (90 National + 50 Vermont State-Specific)', passScore: '105/140 Correct (75%)',
    description: 'Practice questions covering PSI\'s national real estate broker content outline (property ownership, land use controls, valuation, financing, contracts, agency, property disclosures, property management, transfer of title, practice of real estate, and real estate calculations) plus the Vermont-specific portion grounded in 26 V.S.A. Chapter 41 and the Vermont Real Estate Commission\'s Administrative Rules: Commission powers and licensing (including the confirmed absence of any Recovery Fund or surety bond), trust and escrow accounts and broker-specific practice (including the real 26 V.S.A. § 2299 temporary-licensure-on-a-broker\'s-death provision), and agency, disclosure, advertising, and Vermont\'s distinctive on-premise real estate sign law under 10 V.S.A. § 493. Vermont has a genuinely unique split-vendor exam structure, unlike every other state on this site: PSI Services LLC administers only the National portion (90 scored items, 150 minutes, flat 75% pass), while the State portion (50 items) is self-administered directly by the Vermont Office of Professional Regulation as an untimed part of the online license application, not a timed proctored sitting. Vermont also recognizes no true dual agency and no facilitator/transaction-broker status at all -- only Non-Designated and Designated agency, the latter with a real confidentiality wall between designated agents at the same firm.',
    breakdown: [['Commission Powers & Licensing (VT)', '13%'], ['Agency, Disclosure, Advertising & Sign Law (VT)', '13%'], ['Contracts (National)', '12%'], ['Trust/Escrow & Broker Practice (VT)', '10%'], ['Agency (National)', '9%'], ['Practice of Real Estate (National)', '8%'], ['Financing (National)', '6%'], ['Property Ownership (National)', '6%'], ['Valuation (National)', '5%'], ['Property Disclosures (National)', '4%'], ['Property Management (National)', '4%'], ['Transfer of Title (National)', '4%'], ['Real Estate Calculations (National)', '4%'], ['Land Use Controls (National)', '4%']],
  },
  {
    examType: 'wi_re_salesperson',
    title: 'Wisconsin Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/wi',
    duration: '240 Minutes', questions: '140 Multiple Choice (State-Specific Portion)', passScore: 'Scaled Score of 75 (0-100 Scale)',
    description: 'Practice questions covering Wisconsin Statutes Chapter 452 and Wisconsin Administrative Code chs. REEB 11, 12, 15, 16, 17, 18, 23, 24, and 25 (Real Estate Examining Board rules): licensing requirements, prelicense and continuing education, duties and prohibited conduct, investigation, discipline and penalties, trust accounts, fees and commissions, agency relationships and disclosure, and board authority and firm structure. This covers the licensing and regulatory portion of the Pearson VUE-administered Salesperson exam\'s state-specific content -- not the separate national portion, and not every topic on the Examining Board\'s official 140-item state-portion content outline (which also covers financing/valuation math, land use controls, contract-form specifics, fair housing, and federal antitrust law).',
    breakdown: [['Licensing Requirements, Prelicensing & Renewal Education', '25%'], ['Duties, Prohibited Conduct & Discipline', '21%'], ['Trust Accounts, Fees & Commissions', '19%'], ['Definitions, Board Authority & Firm Structure', '19%'], ['Agency Disclosure, Property Condition & Unlicensed Practice', '16%']],
  },
  {
    examType: 'wi_re_broker',
    title: 'Wisconsin Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/wi',
    duration: '195 Minutes (3hr 15min)', questions: '100 Multiple Choice (State-Specific Portion)', passScore: 'Scaled Score of 75 (0-100 Scale)',
    description: 'Practice questions covering Pearson VUE\'s official Wisconsin Real Estate Broker exam content outline (administered on behalf of the Wisconsin Real Estate Examining Board, REEB): Real Estate Practice (licenses, trust accounts, duties of licensees, disclosure of relationships, sex offender registry and condominium disclosure), Trust Accounts (REEB 18\'s full account-structure and disbursement rules), Conduct and Ethical Practices for Real Estate Licensees (REEB 24), Approved Forms and Legal Advice (the named Wisconsin WB-series forms and the unauthorized-practice-of-law boundary under REEB 16), Drafting and Supervision Knowledge -- the largest section by far -- covering the WB forms\' individual clauses and Wis. Stat. ch. 709 real estate condition/vacant-land/new-construction disclosure reports, and Miscellaneous (Wisconsin and federal Fair Housing Law, federal lead-based-paint disclosure). Unlike every other state\'s broker exam on this site, Wisconsin\'s Broker exam is administered as a State-specific-only content outline -- Pearson VUE\'s separate National/General portion is not covered here, matching this site\'s existing wi_re_salesperson track\'s own established scope.',
    breakdown: [['Drafting & Supervision Knowledge', '37%'], ['Conduct & Ethical Practices for Licensees', '22%'], ['Real Estate Practice', '19%'], ['Trust Accounts', '12%'], ['Approved Forms & Legal Advice', '6%'], ['Miscellaneous (Fair Housing & Lead-Paint Disclosure)', '4%']],
  },
  {
    examType: 'wv_re_salesperson',
    title: 'West Virginia Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/wv',
    duration: '60 Minutes', questions: '50 Multiple Choice (State-Specific Portion)', passScore: 'Scaled Score of 70 (0-100 Scale, Not Raw Percent-Correct)',
    description: 'Practice questions covering the West Virginia Real Estate License Act (W. Va. Code Chapter 30, Article 40) and the Real Estate Commission\'s Title 174 legislative rules -- the general powers and duties of the Real Estate Commission (audits, complaints, investigations and discipline), licensing (application, renewal, transfer, continuing education and exemptions), real estate practice (scope of practice, advertising, trust funds, brokerage agreements and closing), agency relationships and disclosure, and West Virginia fair housing -- the state-specific portion of the Pearson VUE-administered Salesperson exam.',
    breakdown: [['General Powers & Duties of the Commission (Audits, Complaints & Discipline)', '18%'], ['Licensing (Renewal, Transfer, CE & Exemptions)', '34%'], ['Real Estate Practice (Scope, Advertising & Trust Funds)', '30%'], ['Agency Relationships (Notice of Agency & Types of Agency)', '8%'], ['West Virginia Fair Housing', '10%']],
  },
  {
    examType: 'wv_re_broker',
    title: 'West Virginia Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/wv',
    duration: '240 Minutes (4 Hours)', questions: '140 Multiple Choice (80 National + 60 West Virginia State-Specific)', passScore: 'Scaled Score of 75 (0-100 Scale)',
    description: 'Practice questions covering Pearson VUE\'s national real estate broker content outline (property ownership, forms of ownership and title, valuation and appraisal, contracts and agency, real estate practice, property disclosures and environmental issues, financing and settlement, and real estate math) plus the West Virginia-specific portion administered on behalf of the West Virginia Real Estate Commission: General Powers and Duties of the Commission (audits, complaints, investigations, penalties -- no WV recovery fund exists), Licensing (renewal, CE, all real statutory exemptions), Real Estate Practice (scope of practice, fees, and real advertising rules under 174 CSR 1), Agency Relationships and West Virginia Fair Housing (recodified in 2024, with protected classes that add ancestry and blindness beyond federal law), and Broker Management (real broker-only content: trust funds, place of business, brokerage operations, and human resources management). Item counts, the scaled passing score of 75, and the 4-hour time allowance are confirmed directly against Pearson VUE\'s official West Virginia Candidate Handbook and Content Outline PDFs.',
    breakdown: [['Broker Management (WV)', '13%'], ['Licensing (WV)', '10%'], ['Real Estate Practice (WV)', '8%'], ['Contracts & Agency (National)', '9%'], ['Commission Powers & Duties (WV)', '6%'], ['Real Estate Practice (National)', '7%'], ['Property Value & Appraisal (National)', '6%'], ['Property Ownership (National)', '6%'], ['Property Disclosures & Environmental (National)', '5%'], ['Financing & Settlement (National)', '5%'], ['Real Estate Math (National)', '5%'], ['Forms of Ownership & Title (National)', '5%'], ['Agency Relationships (WV)', '3%'], ['West Virginia Fair Housing (WV)', '3%']],
  },
  {
    examType: 'wy_re_salesperson',
    title: 'Wyoming Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/wy',
    duration: '90 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '75% (Scaled Score 75+)',
    description: 'Practice questions covering the Wyoming Real Estate License Act (Wyoming Statutes Title 33, Chapter 28) and the Wyoming Real Estate Commission\'s Rules (Chapters 1-8) -- the state-specific portion of the Pearson VUE-administered Salesperson exam: the Commission\'s powers, investigations and sanctions; licensing, license renewal and continuing education; advertising, broker-salesperson relationships, compensation, disclosure, trust funds and grounds for disciplinary action; and the Real Estate Recovery Fund, land descriptions, landlord-tenant relationships, foreclosure/redemption, statute of frauds, and other additional topics.',
    breakdown: [['The Commission\'s Powers, Investigations & Sanctions', '9%'], ['Licensing, Renewal & Continuing Education', '20%'], ['Licensee Conduct: Advertising, Disclosure, Trust Funds & Discipline', '41%'], ['Recovery Fund, Land Description, Landlord-Tenant & Additional Topics', '30%']],
  },
  {
    examType: 'wy_re_broker',
    title: 'Wyoming Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/wy',
    duration: '240 Minutes (4 Hours)', questions: '130 Multiple Choice (80 National + 50 Wyoming State-Specific)', passScore: 'Scaled Score of 75 (0-100 Scale, Not Raw Percent-Correct)',
    description: 'Practice questions covering Pearson VUE\'s national real estate broker content outline (real property characteristics, forms of ownership/title, property value and appraisal, contracts and agency, real estate practice, property disclosures and environmental issues, financing and settlement, and real estate math calculations) plus the Wyoming-specific portion administered on behalf of the Wyoming Real Estate Commission (WREC): the Real Estate Licensing Agency\'s Powers, Licensing, Requirements Governing the Activities of Licensees (including Wyoming\'s distinctive "designated licensee" mechanism, letting different licensees at the same firm represent opposing sides without that alone creating dual agency, and Wyoming\'s separate non-agent "intermediary" brokerage status), Additional Topics (the real Recovery Fund with a $10,000 max-per-claim cap, Wyoming\'s two-meridian PLSS land-description system, and its unusually short 3-month nonjudicial foreclosure redemption period), and Broker Responsibility and Office Management -- the largest state section, broker-only content covering trust accounts, Wyoming\'s distinctive "Funds Holder Agreement" alternative to a broker-held trust account, place of business, recordkeeping, and supervision. National and state portions are scored and passed independently, retaking only the failed portion within 6 months. Item counts, the scaled-score-75 passing rule, and the 4-hour time allowance are confirmed directly against Pearson VUE\'s official Wyoming Candidate Handbook.',
    breakdown: [['Real Estate Math Calculations (National)', '10%'], ['Forms of Ownership & Title (National)', '10%'], ['Property Value & Appraisal (National)', '9%'], ['Contracts & Agency (National)', '9%'], ['Real Estate Practice (National)', '9%'], ['Financing & Settlement (National)', '9%'], ['Requirements Governing Licensee Activities (WY)', '9%'], ['Real Property Characteristics (National)', '8%'], ['Property Disclosures & Environmental (National)', '8%'], ['Additional Topics (WY)', '6%'], ['Broker Responsibility & Office Management (WY)', '5%'], ['The Licensing Agency\'s Powers (WY)', '4%'], ['Licensing (WY)', '4%']],
  },
  {
    examType: 'fl_re_salesperson',
    title: 'Florida Real Estate Sales Associate Exam Prep (Licensing Law & Regulatory Content)', category: 'Real Estate Licensing', route: '/real-estate-salesperson/fl',
    duration: '45 Minutes', questions: '40 Multiple Choice (Licensing-Law Portion)', passScore: '30/40 Correct (75%)',
    description: 'Practice questions covering Florida Statutes Chapter 475, Part I (Real Estate Brokers, Sales Associates, and Schools) and Florida Administrative Code Chapter 61J2 -- scoped to six of DBPR\'s own officially-published Sales Associate Examination Content Outline areas (effective January 2025): License Law and Qualifications for Licensure, Real Estate License Law and Commission Rules (FREC/DBPR), Authorized Relationships/Duties/Disclosures, Real Estate Brokerage Activities and Procedures (trust/escrow accounts, advertising, brokerage offices, broker\'s commission, unlicensed personal assistants), Violations of License Law/Penalties/Procedures (including the Real Estate Recovery Fund), and Real Estate Related Computations and Closing of Transactions. Florida\'s real Sales Associate Examination is a single unified 100-question exam covering 19 official content areas blending general real estate principles with Florida-specific law (there is no separate national-portion test); this track\'s breakdown uses DBPR\'s own published percentages for just these six licensing/regulatory areas, renormalized to 100%, since the bank does not cover the exam\'s general real estate principles, mathematics, property law, financing, appraisal, market-analysis, taxation, or zoning content areas that make up the majority of the full exam.',
    breakdown: [['License Law & Qualifications for Licensure', '17%'], ['Real Estate License Law & Commission Rules (FREC/DBPR)', '6%'], ['Authorized Relationships, Duties & Disclosures', '19%'], ['Real Estate Brokerage Activities & Procedures (Trust Accounts, Advertising, Commission)', '33%'], ['Violations of License Law, Penalties & Procedures', '8%'], ['Real Estate Related Computations & Closing of Transactions', '17%']],
  },
  {
    examType: 'fl_re_broker',
    title: 'Florida Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/fl',
    duration: '3 Hours 30 Minutes', questions: '100 Multiple Choice', passScore: '75/100 Correct (75%)',
    description: 'Practice questions covering FREC\'s official 12-area broker exam content outline: real estate brokerage business (licensure, brokerage entities and office requirements, ownership/management/supervision, escrow management and trust accounts, FREC discipline and investigations), valuing real property, listing and selling real property (brokerage relationships), contracts, financing, closing transactions and disclosure, federal income tax laws, investment, zoning/planning/environmental issues, property management and landlord-tenant law, and the real estate market. Grounded in Florida Statutes Chapter 475 and Florida Administrative Code 61J2, with extra depth in escrow/trust account management and broker supervision of sales associates -- content the sales associate exam doesn\'t cover.',
    breakdown: [['Real Estate Brokerage Business (Licensure, Escrow, Supervision & Discipline)', '43%'], ['Closing Transactions & Disclosure', '12%'], ['Contracts', '11%'], ['Valuing Real Property', '9%'], ['Listing & Selling Real Property (Brokerage Relationships)', '6%'], ['Federal Income Tax Laws', '5%'], ['Financing & Investment', '8%'], ['Real Estate Market, Zoning/Environmental & Property Management', '6%']],
  },
  {
    examType: 'tx_re_salesperson',
    title: 'Texas Real Estate Sales Agent Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/tx',
    duration: '90 Minutes', questions: '40 Multiple Choice (State Law Portion)', passScore: '28/40 Correct (70%)',
    description: 'Practice questions covering the Real Estate License Act (TRELA), Texas Occupations Code Chapter 1101, and the Texas Real Estate Commission\'s (TREC) rules at 22 TAC Chapters 531, 533, 534, and 535: TREC\'s commission duties, powers and enforcement, licensing qualifications, education and renewal, standards of professional conduct and trust accounts, agency and brokerage relationships, and contracts and disclosure -- the state law portion of the Pearson VUE-administered Sales Agent exam.',
    breakdown: [['Agency/Brokerage (Disclosure, Intermediary Practice & Broker-Sales Agent Relationships)', '27.5%'], ['Standards of Conduct (Ethics, Discipline & Trust Accounts)', '22.5%'], ['Contracts (Promulgated Forms, Statute of Frauds & Seller Disclosure)', '22.5%'], ['Special Topics (Community Property, Homestead & Landlord-Tenant)', '12.5%'], ['Commission Duties & Powers (Complaints, Hearings & Penalties)', '7.5%'], ['Licensing (Requirements, Education & Renewal)', '7.5%']],
  },
  {
    examType: 'tx_re_broker',
    title: 'Texas Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/tx',
    duration: '4 Hours', questions: '145 Multiple Choice (85 National / 60 State)', passScore: 'Both Portions: 75% National, 76% State',
    description: 'Practice questions covering the Pearson VUE-administered Texas Broker exam\'s combined National and State content, weighted by Pearson VUE\'s own official Texas Real Estate Content Outlines (#094401): the National/General Broker outline (effective 3/1/2025, 80 scored items -- real property characteristics/legal descriptions, forms of ownership/title, property value/appraisal, contracts and agency, real estate practice/fair housing/risk management, disclosures/environmental issues, financing/settlement, and real estate math) plus the Texas Broker State Law outline (effective 4/15/2020, 50 scored items -- commission duties/powers, licensing, standards of conduct, agency/brokerage relationships, promulgated contracts, special TX-law topics, and 10 case-study items). Requires 900 hours of qualifying/related education (including a mandatory Broker Responsibility course) and 4 years of qualifying experience -- both verified separately at application, not tested here.',
    breakdown: [['Commission Duties, Powers & Licensing (State)', '5.4%'], ['Standards of Conduct, Trust Accounts & Advertising (State)', '6.9%'], ['Agency & Brokerage Relationships (State)', '7.7%'], ['Contracts & Promulgated Forms (State)', '6.2%'], ['Special Topics: Community Property, Homestead, Landlord-Tenant & More (State)', '4.6%'], ['Case Studies & Applied Scenarios (State)', '7.7%'], ['Property Characteristics, Ownership, Value & Appraisal (National)', '21.5%'], ['Contracts, Agency, Practice & Fair Housing (National)', '20.8%'], ['Disclosures, Environmental, Financing, Settlement & Real Estate Math (National)', '19.2%']],
  },
  {
    examType: 'ny_re_salesperson',
    title: 'New York Real Estate Salesperson Exam', category: 'Real Estate Licensing', route: '/real-estate-salesperson/ny',
    duration: '90 Minutes', questions: '75 Multiple Choice (Estimated -- NY DOS Does Not Publish an Exact Item Count)', passScore: '70% (Estimated -- Real Exam Is Pass/Fail Only, No Numeric Score Published by NY DOS)',
    description: 'Practice questions covering New York Real Property Law Article 12-A (Sections 440-443-a), the Property Condition Disclosure Act (RPL Article 14, Sections 460-467), agricultural district and utility/gas-well disclosure requirements, and Human Rights Law/federal Fair Housing protections (Executive Law Article 15 Section 296(5), 42 USC 3604): license law and licensing requirements, agency and fiduciary duties, legal issues (estates, liens, deeds and title closing), contracts, financing, land use/construction/environmental issues, valuation, fair housing, real estate math, municipal agencies/insurance/licensee safety/mortgage brokerage, taxes and income tax issues, condominiums and cooperatives, and commercial/investment real estate and property management. The New York Department of State confirms the real exam is multiple choice with a 90-minute time limit and reports a pass/fail result only, with no published item count or percentage score -- this practice exam uses a commonly-cited 75-question/70% format as a study convention, not an official DOS figure. The breakdown below is weighted directly from DOS\'s own real estate salesperson qualifying-course syllabus (the 19-subject, 77-hour outline DOS requires every approved school to teach), proportional to each subject\'s official hour allocation.',
    breakdown: [['License Law and Regulations', '4%'], ['Law of Agency', '14%'], ['Legal Issues: Estates, Liens, Deeds & Title Closing', '13%'], ['Contracts, Financing, Valuation & Real Estate Math', '16%'], ['Land Use, Construction & Environmental Issues', '10%'], ['Human Rights & Fair Housing', '8%'], ['Municipal Agencies, Property Insurance, Licensee Safety & Mortgage Brokerage', '6%'], ['Taxes, Assessments & Income Tax Issues', '8%'], ['Condominiums/Cooperatives, Commercial/Investment Properties & Property Management', '21%']],
  },
  {
    examType: 'ny_re_broker',
    title: 'New York Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ny',
    duration: '2 Hours 30 Minutes', questions: '100 Multiple Choice (Estimated -- NY DOS Does Not Publish an Exact Item Count)', passScore: '70% (Estimated -- Real Exam Is Pass/Fail Only, No Numeric Score Published by NY DOS)',
    description: 'Practice questions covering New York Real Property Law Article 12-A at broker level and 19 NYCRR Part 175 (Department of State real estate rules): broker supervision of salespersons and associate brokers, broker office management and branch offices/recordkeeping, escrow and trust fund management, commission and broker-salesperson compensation relationships, license law and DOS discipline/investigations/continuing education, plus the same agency law, fair housing, contracts, finance, valuation, property management, and disclosure content the salesperson exam covers. The New York Department of State administers the broker exam directly (no PSI/Pearson VUE), confirms a 150-minute time limit based on the 152-hour broker education syllabus (45-hour salesperson course + 75-hour broker course + 32-hour supplemental curriculum), and reports a pass/fail result only, with no published item count or percentage score -- this practice exam uses a commonly-cited 100-question/70% format as a study convention, not an official DOS figure.',
    breakdown: [['Broker Supervision, Office Management & Escrow/Trust Funds', '21%'], ['License Law, Discipline, CE & General Business Law', '17%'], ['Finance, Valuation & Real Estate Math', '16%'], ['Property Management, Construction/Zoning & Taxes', '13%'], ['Agency Law, Disclosure & Fair Housing', '12%'], ['Commission/Compensation & Contracts', '12%'], ['Closing, Property Condition Disclosure Act & Environmental', '9%']],
  },
  {
    examType: 'pa_re_broker',
    title: 'Pennsylvania Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/pa',
    duration: '3 Hours 30 Minutes (2 Portions: National 150 Min + State 60 Min)', questions: '120 Multiple Choice (80 National + 40 Pennsylvania State-Specific)', passScore: '75% on Each Portion (60/80 National, 30/40 State)',
    description: 'Practice questions covering Pennsylvania\'s Real Estate Licensing and Registration Act (RELRA, 63 P.S. Sections 455.101-455.902) and 49 Pa. Code Chapter 35 (State Real Estate Commission regulations) at broker level: broker licensure requirements and application, broker office management and branch offices/recordkeeping, broker supervision of salespersons and associate brokers, escrow and trust fund management (RELRA Section 608.5), commission and broker-salesperson compensation relationships, license law and Real Estate Commission discipline/Recovery Fund, plus the agency law, fair housing, contracts, finance, valuation, and disclosure content the salesperson exam covers at a deeper broker level. The exam is administered by Pearson VUE on behalf of the PA Real Estate Commission (Pearson VUE has been the vendor since April 1, 2023, succeeding PSI Exams): 80 scored national items (150 minutes, 75% passing) and 40 scored Pennsylvania-specific items (60 minutes, 75% passing), each portion graded independently. This breakdown is scoped directly to Pearson VUE\'s two real, official Broker Content Outlines (National/General, eff. 4/1/2025; Pennsylvania State-Specific, eff. 3/16/2026) and their exact published item counts. Broker licensure requires 3+ years as a licensed salesperson and 240 hours (16 credits) of Commission-approved education, confirmed via RELRA Section 511 and 49 Pa. Code Section 35.271.',
    breakdown: [['Property Ownership, Value & Appraisal (National)', '24%'], ['Contracts, Agency, Practice & Fair Housing (National)', '23%'], ['Disclosures, Environmental Issues, Financing & Math (National)', '21%'], ['Real Estate Commission (PA State)', '3%'], ['Licensure (PA State)', '5%'], ['Agency & Disclosure (PA State)', '8%'], ['Regulations Governing Licensee Activities (PA State)', '8%'], ['Miscellaneous: Disclosures, Condos & Rentals (PA State)', '4%'], ['Brokerage Management (PA State)', '4%']],
  },
  {
    examType: 'oh_re_broker',
    title: 'Ohio Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/oh',
    duration: '3 Hours (180 Minutes)', questions: '120 Multiple Choice (80 National + 40 Ohio-Specific)', passScore: '75% Required on Each Portion (60/80 National, 30/40 Ohio-Specific)',
    description: 'Practice questions covering the Ohio Revised Code Chapter 4735 (Real Estate Brokers, Salespersons) and Ohio Administrative Code Chapter 1301:5, scoped and weighted to PSI\'s own official Ohio Real Estate Salesperson and Broker Candidate Information Bulletin content outline: the 80-item national portion (property ownership, land use, valuation, financing, agency, property condition/disclosures, contracts, transfer of title, practice of real estate, calculations, specialty areas -- at the broker\'s higher item counts in agency, financing, property condition and contracts) plus the 40-item Ohio-specific portion (state governance/discipline/Recovery Fund, licensing requirements, license law and Commission rules including broker supervision/office management/trust funds, and brokerage relationships/agency law). Ohio\'s real estate exams (both Salesperson and Broker) are administered by PSI with an identical 3-part exam-length structure -- National-only (80 items/120 min), State-only (40 items/60 min), or Combined (120 items/180 min) -- confirmed directly from PSI\'s own official Candidate Information Bulletin, which requires 75% to pass each portion independently for the Broker exam (vs. 70% for Salesperson). Ohio does not have a separate "principal broker" license or exam -- it is a supervisory designation any licensed broker takes on to run a brokerage under ORC 4735.081, using the identical broker exam and licensure path.',
    breakdown: [['Property Ownership, Land Use & Valuation (National)', '14%'], ['Financing & Real Estate Calculations (National)', '9%'], ['Agency, Property Condition & Disclosures (National)', '17%'], ['Contracts, Transfer of Title & Specialty Areas (National)', '17%'], ['Practice of Real Estate (National)', '10%'], ['Ohio State Governance, Discipline & Recovery Fund', '3%'], ['Ohio Licensing Requirements', '5%'], ['Ohio License Law & Commission Rules (Advertising, Trust Accounts, Property Management)', '13%'], ['Ohio Brokerage Relationships & Agency Law', '12%']],
  },
  {
    examType: 'ga_re_broker',
    title: 'Georgia Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/ga',
    duration: 'Approx. 4 Hours (Estimated -- Combined National + 48-Item GA State Portions, No Official Total Time Published)', questions: '148 Multiple Choice (48 GA State Portion Confirmed + 100 National Portion Estimated by Analogy to the Salesperson Exam)', passScore: '75% on Each Portion (Confirmed via Secondary Corroboration -- GREC/PSI Bulletin Does Not Publish a Numeric Passing Score)',
    description: 'Practice questions covering O.C.G.A. Title 43, Chapter 40 (Real Estate Brokers and Salespersons) and Ga. Comp. R. & Regs. Chapter 520: broker licensure requirements and application, broker/qualifying-broker office management and advertising, broker supervision of affiliated licensees, escrow and trust fund management, commission and broker-salesperson relationships, and license law/GREC discipline/Recovery Fund, plus the agency law (including BRRETA, Georgia\'s statutory alternative to common-law fiduciary duty), fair housing, contracts, finance, valuation, and disclosure content the salesperson exam covers at a deeper broker level. PSI Services LLC is confirmed as GREC\'s exam vendor directly from the current GREC/PSI Candidate Information Bulletin: the Georgia-specific Broker Supplement is confirmed at exactly 48 items (31 State Laws & Rules, 12 Management, 5 Closing & Calculations), while the national portion\'s category weights are published as percentages, not a raw count -- this bank uses a well-corroborated 100-item estimate (by analogy to Georgia\'s confirmed salesperson national-portion count) for the combined 148-question/75%-per-portion practice format, flagged as an estimate since GREC/PSI does not publish a total item count or time limit for the Broker exam as a whole. Georgia is a confirmed attorney-required-closing state (In re UPL Advisory Opinion 2003-2, 588 S.E.2d 741 (Ga. 2003)), and uses security deeds with nonjudicial power-of-sale foreclosure rather than deeds of trust.',
    breakdown: [['GA State Laws, Rules, Fair Housing, Unfair Practices & Recovery Fund', '21%'], ['Contracts & Agency Law (BRRETA)', '22%'], ['Broker Management, Supervision & Practice of Real Estate', '20%'], ['Property Ownership, Land Use & Transfer of Title', '14%'], ['Financing & Valuation', '11%'], ['Closing & Real Estate Calculations', '7%'], ['Property Disclosures', '5%']],
  },
  {
    examType: 'mi_re_broker',
    title: 'Michigan Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/mi',
    duration: '3 Hours 30 Minutes (210 Minutes)', questions: '115 Multiple Choice (~75 National + 40 Michigan-Specific)', passScore: '75% (90 of 120 Raw Points)',
    description: 'Practice questions covering the Occupational Code Article 25 (MCL 339.2501-339.2518) and Michigan Administrative Code Real Estate Brokers and Salespersons General Rules (R 339.22101-339.22667) at broker level: broker/associate broker licensure requirements, Department and State Board of Real Estate duties and powers, statutory requirements governing licensee activities (advertising, commissions, trust accounts, branch offices, recordkeeping), Michigan\'s statutory agency-relationship types (transaction coordinator, designated agency, dual agency), and broker-only supervisory responsibilities, plus the national-portion content (property ownership, land use controls, valuation, financing, contracts, agency, property disclosures, property management, transfer of title, practice of real estate, real estate calculations) the salesperson exam covers at a deeper broker level. The exam is administered by PSI Services LLC on behalf of LARA, confirmed directly from PSI\'s official Candidate Information Bulletin (updated 10/8/2024): a single combined 115-question exam (worth up to 120 points via partial-credit scenario items), 75% passing (90/120 raw score), 210 minutes. Broker licensure requires 3 years\' equivalent full-time real estate experience (MCL 339.2505) and 90 hours of pre-licensure education including at least 9 hours of civil rights law and equal opportunity in housing (MCL 339.2504). Breakdown weighted directly from the Bulletin\'s own per-category Broker item counts across both the national portion (80 items) and the Michigan-specific portion (33 items).',
    breakdown: [['Property Ownership & Land Use Controls', '10%'], ['Valuation, Financing & Real Estate Calculations', '15%'], ['Agency', '10%'], ['Property Condition & Disclosures', '8%'], ['Contracts', '11%'], ['Practice of Real Estate & Specialty Areas', '13%'], ['Transfer of Title', '5%'], ['Department/Board Duties & Licensing Requirements (Michigan)', '6%'], ['Statutory Requirements Governing Licensee Activities (Michigan)', '13%'], ['Contractual Relationships & Michigan Agency Types (Michigan)', '4%'], ['Additional Michigan State Topics', '5%']],
  },
  {
    examType: 'nj_re_broker',
    title: 'New Jersey Real Estate Broker Exam', category: 'Real Estate Licensing', route: '/real-estate-broker/nj',
    duration: '4 Hours', questions: '115 Multiple Choice (120 Points -- Some Items Worth Up to 2 Points)', passScore: '70% (84 of 120 Points)',
    description: 'Practice questions covering PSI Services LLC\'s official New Jersey Real Estate Broker exam content outline (administered on behalf of the NJ Real Estate Commission, NJREC): a combined National portion (75 items -- property ownership, land use controls, valuation/market analysis, financing, general principles of agency, property disclosures, contracts, leasing/property management, transfer of title, practice of real estate, and real estate calculations) plus a 40-item New Jersey-specific portion (NJREC\'s duties and licensing requirements, the statutes and rules governing licensee activities -- broker-salesperson relationships, commissions, N.J.A.C. 11:5-5.1 trust-account rules, agency disclosure via the Consumer Information Statement, advertising, listings, inducements and buyer rebates -- and NJ-specific acts including the Farmland Assessment Act, Pinelands Protection Act, Freshwater Wetlands Protection Act, Municipal Land Use Law, the Mount Laurel/Fair Housing Act, the Realty Transfer Fee\'s 2025 seller-pays "mansion tax" reform, the Truth in Renting Act, the Real Estate Guaranty Fund, the Law Against Discrimination, the Real Estate Sales Full Disclosure Act, and the Real Estate Time Share Act), not separately scored or reported. PSI\'s own Candidate Information Bulletin confirms 115 scored questions worth 120 points -- national broker exams score some items up to two points each, a genuine New Jersey scoring nuance this practice exam discloses rather than silently flattening -- with a 4-hour time limit and 70% (84 of 120 points) required to pass; 5-10 unscored experimental items may also appear. Broker eligibility requires 3 years of full-time salesperson experience plus 150 hours of NJREC-approved broker prelicensure education (a 90-hour general course, then two 30-hour courses in ethics/agency and office management) and a Certificate of Examination Eligibility from NJREC before scheduling.',
    breakdown: [['Contracts (National)', '12%'], ['Practice of Real Estate (National)', '9%'], ['General Principles of Agency (National)', '7%'], ['Property Ownership (National)', '7%'], ['Financing (National)', '5%'], ['Real Estate Calculations (National)', '5%'], ['Valuation & Market Analysis (National)', '5%'], ['Property Disclosures (National)', '5%'], ['Transfer of Title (National)', '5%'], ['Land Use Controls & Regulations (National)', '3%'], ['Leasing & Property Management (National)', '3%'], ['NJ Statutes & Rules Governing Licensee Activities (NJ)', '26%'], ['NJREC Duties, Powers & Licensing Requirements (NJ)', '6%'], ['Additional NJ Requirements: Guaranty Fund, LAD, Disclosure & Time Share Acts (NJ)', '2%']],
  },
  {
    examType: 'al_notary',
    title: 'Alabama Notary Public Practice Questions', category: 'State Licensing', route: '/notary/al',
    duration: 'Untimed', questions: '40 Multiple Choice (138-Question Practice Pool)', passScore: 'Education-Only — No State Exam',
    description: 'Practice questions covering the Alabama Notary Public Act (Code of Alabama 1975, Title 36, Chapter 20), effective 9/1/2023: commissioning, qualifications and training, notarial powers and identification, seal and journal requirements, remote (two-way audio-video) notarization, and discipline and misconduct reporting. Alabama does not administer a separate graded notary exam — notaries are commissioned at the county level by the Probate Judge after completing the mandatory Alabama Probate Judges Association / Alabama Law Institute training course — so this bank is a self-study companion to that course, not a simulation of a pass/fail test.',
    breakdown: [['Commissioning, Qualifications & Training', '21%'], ['Powers, Notarial Acts & Identification', '21%'], ['Seal, Journal, Fees & Special Documents', '23%'], ['Remote (Two-Way Audio-Video) Notarization', '16%'], ['Discipline, Penalties & Misconduct Reporting', '19%']],
  },
  {
    examType: 'fl_notary',
    title: 'Florida Notary Public Practice Questions', category: 'State Licensing', route: '/notary/fl',
    duration: 'Untimed', questions: '40 Multiple Choice (224-Question Practice Pool)', passScore: 'Education-Only — No State Exam',
    description: 'Practice questions covering Florida Statutes Chapter 117 (Notaries Public), Part I general provisions (from the Governor\'s Reference Manual for Notaries Public) and Part II online notarizations (from the official statute text, which the 2019 manual predates and only briefly references), weighted by real body-text share: qualifications, application and commissioning; bond, seal, records, certificates and fees; electronic and remote online notarization (a substantial, separately-supplemented body of law); core notarial duties -- administering oaths, taking acknowledgments, and the statutory short forms of acknowledgment, together the single largest share of the underlying law; solemnizing marriages; prohibited acts and discipline; and special positions and authentication. Florida does not administer a separate graded notary exam — notaries are appointed and commissioned by the Governor after completing a 3-hour education course — so this bank is a self-study companion to that course, not a simulation of a pass/fail test.',
    breakdown: [['Qualifications, Application & Commissioning', '13%'], ['Bond, Seal, Records, Certificates & Fees', '4%'], ['Electronic & Remote Online Notarization', '27%'], ['Core Notarial Duties (Oaths, Acknowledgments & Statutory Forms)', '42%'], ['Solemnizing Marriages', '2%'], ['Prohibited Acts, Discipline & Penalties', '5%'], ['Special Positions & Authentication', '7%']],
  },
  {
    examType: 'ga_notary',
    title: 'Georgia Notary Public Practice Questions', category: 'State Licensing', route: '/notary/ga',
    duration: 'Untimed', questions: '40 Multiple Choice (201-Question Practice Pool)', passScore: 'Education-Only — No State Exam',
    description: 'Practice questions covering O.C.G.A. Title 45, Chapter 17 (Notaries Public), weighted proportional to each topic\'s real share of the statute\'s own text: notarial powers, duties, fees and limitations, definitions and qualifications, commissioning and oath, seal and certificate requirements, military ex officio notaries, changes of status and discipline, and authentication/apostille. Georgia\'s own statute is explicit that there is no separate written exam — O.C.G.A. § 45-17-8(h) requires all new and renewing notaries to complete GSCCCA-administered training instead, so this bank is a self-study companion to that training, not a simulation of a pass/fail test.',
    breakdown: [['Notarial Powers, Duties, Fees & Limitations', '29%'], ['Definitions, Qualifications & Application', '15%'], ['Commissioning, Oath, Term & Fees', '18%'], ['Seal, Signature & Certificate Requirements', '11%'], ['Military Ex Officio Notaries', '11%'], ['Change of Status, Discipline & Enforcement', '13%'], ['Authentication & Apostille', '3%']],
  },
  {
    examType: 'tx_notary',
    title: 'Texas Notary Public Practice Questions', category: 'State Licensing', route: '/notary/tx',
    duration: 'Untimed', questions: '40 Multiple Choice (206-Question Practice Pool)', passScore: 'Education-Only — No State Exam',
    description: 'Practice questions covering Texas Government Code Chapter 406 (Notary Public; Commissioner of Deeds) and Civil Practice and Remedies Code Chapter 121 (Acknowledgments and Proofs), weighted proportional to each topic\'s real share of this project\'s primary-source statute compilation: eligibility and application, bond/oath/commission/seal, recordkeeping, authority/fees/prohibited acts, status changes and administration, commissioner of deeds, online/electronic notarization, acknowledgments and proofs, and the new SB 693 education requirement. Texas\'s Senate Bill 693 (effective 9/1/2025, applying to applications from 1/1/2026) requires a Secretary of State-run education course, but no graded assessment for that course is confirmed in the enacted statute or on the Secretary of State\'s site — so this bank is a self-study companion to the education requirement, not a simulation of a pass/fail test.',
    breakdown: [['Eligibility, Application & Qualification', '7%'], ['Bond, Oath, Commission & Seal', '12%'], ['Notary Records & Recordkeeping', '5%'], ['Authority, Fees & Prohibited Acts', '18%'], ['Status Changes, Removal & Administration', '7%'], ['Commissioner of Deeds', '4%'], ['Online & Electronic Notarization', '16%'], ['Acknowledgments & Proofs', '16%'], ['SB 693 Education & CE Requirement', '15%']],
  },
  {
    examType: 'ak_notary',
    title: 'Alaska Notary Public Practice Questions', category: 'State Licensing', route: '/notary/ak',
    duration: 'Untimed', questions: '40 Multiple Choice (109-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering Alaska\'s notary law under AS 44.50 (Notaries Public) and AS 09.63 (Oath, Acknowledgment, and Other Proof): commissioning and the two commission types (notaries public without limitation vs. limited governmental notaries public), qualifications and the application/bond/oath process, notarial duties and prohibited acts, seal and journal requirements, remote and electronic (communication-technology) notarization, and acknowledgment, verification, and certificate content under the Uniform Recognition of Acknowledgments Act. Alaska requires neither a training course nor a separate graded notary exam — commissions are issued directly by the Office of the Lieutenant Governor upon a completed application, a $2,500 surety bond (AS 44.50.034), the statutory oath (AS 44.50.035), and a nonrefundable application fee set by regulation under AS 44.50.033 — so this bank is a self-study reference on real state notary law, not a simulation of a pass/fail test or a course companion.',
    breakdown: [['Commissioning, Qualifications & Application','21%'],['Duties, Prohibited Acts, Seal & Journal','23%'],['Remote & Electronic Notarization','13%'],['Acknowledgments, Verification & Certificates (AS 09.63)','18%'],['Interstate Recognition, Postmasters, Liability & Definitions','25%']],
  },
  {
    examType: 'de_notary',
    title: 'Delaware Notary Public Practice Questions', category: 'State Licensing', route: '/notary/de',
    duration: 'Untimed', questions: '40 Multiple Choice (191-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering Delaware Code Title 29, Chapter 43 (Notaries Public) — Subchapter I "Office and Duties" (§§4301-4314) and Subchapter II, the Revised Uniform Law on Notarial Acts (RULONA, §§4315-4342 plus §4322A): commissioning and qualifications, Delaware\'s several distinct notary sub-types (justices of the peace and the Secretary of Finance, one notary per bank or branch, court reporters, and veterans\'-organization, volunteer fire/ambulance, and limited governmental notaries for police agencies), term of office, oath, and fee caps, core RULONA notarial acts and identification requirements, certificates and the official stamp, remote online notarization (RON), and prohibited acts and discipline. Delaware requires neither a training course nor a separate graded exam to become a notary — its official notary FAQ states directly, "No. Training is currently not required to become a notary," and the statute imposes no exam requirement either — so this bank is a self-study reference tool grounded in the actual statute, not preparation for any state-administered test or mandatory class.',
    breakdown: [['Commissioning, Qualifications & Special Notary Types','19%'],['Identification, Certificates & Official Stamp','16%'],['RULONA Core Notarial Acts & Definitions','15%'],['Term of Office, Oath & Fees','14%'],['Stamping Device, Journal, Prohibited Acts & Regulatory Authority','13%'],['Remote Online Notarization (RON)','12%'],['Commission Execution & Grounds for Discipline','11%']],
  },
  {
    examType: 'id_notary',
    title: 'Idaho Notary Public Practice Questions', category: 'State Licensing', route: '/notary/id',
    duration: 'Untimed', questions: '40 Multiple Choice (148-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering the Idaho Revised Uniform Law on Notarial Acts (2018) (RULONA), Idaho Code Title 51, Chapter 1, Sections 51-101 through 51-133: definitions and general provisions, notarial act requirements and identification of individuals, notarial acts performed in another state, under tribal or federal authority, involving a foreign state, or by a remotely located individual (RON), certificates and statutory short forms including compound acknowledgments, official stamp and stamping-device specifications, commissioning qualifications and bonding, the Secretary of State\'s course of study, grounds to deny/revoke/suspend a commission and prohibited acts (including the notario publico restriction), and rules, fees and miscellaneous uniform-act provisions. Idaho has no state notary exam, and Idaho Code § 51-121 sets out a complete, exhaustive list of commissioning qualifications — age 18+, U.S. citizenship or permanent legal residency, Idaho residency or place of employment/practice, literacy, and a $10,000 surety bond (or, for qualifying state employees, an assurance from the Department of Administration\'s risk management office) — with no exam or course-completion requirement for applicants. Idaho Code § 51-122 does require the Secretary of State to regularly offer a course of study covering notarial laws, rules, procedures and ethics, but that obligation runs to the state, not the applicant, so this bank is a self-study reference on real Idaho notarial law, not a simulation of a pass/fail test or a substitute for any state-offered course.',
    breakdown: [['Definitions & General Provisions','10%'],['Notarial Act Requirements & Identification','14%'],['Interstate, Tribal, Federal, Foreign & Remote (RON) Notarization','17%'],['Certificates, Short Forms & Compound Acknowledgments','14%'],['Official Stamp, Stamping Device & Electronic Records','12%'],['Commissioning, Qualifications, Bonding & Course of Study','15%'],['Discipline, Prohibited Acts, Database & Validity','12%'],['Rules, Fees & Miscellaneous Uniform-Act Provisions','6%']],
  },
  {
    examType: 'ia_notary',
    title: 'Iowa Notary Public Practice Questions', category: 'State Licensing', route: '/notary/ia',
    duration: 'Untimed', questions: '40 Multiple Choice (131-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering Iowa Code Chapter 9B (Notarial Acts), Iowa\'s enactment of the Revised Uniform Law on Notarial Acts (2018): definitions, authority and requirements for performing notarial acts, notarial acts performed under out-of-state, tribal, federal, and foreign authority, remote (communication-technology) notarization, certificates and the official stamp, commissioning, qualifications and fees, discipline and prohibited acts, and general provisions. Iowa requires neither a graded exam nor a pre-commission training course for a standard notary commission — an applicant need only meet Chapter 9B\'s eligibility criteria, execute an oath of office, and pay a $30 application fee to the Secretary of State — so this bank is a self-study reference for the statute itself, not a simulation of a pass/fail test or a companion to any required course.',
    breakdown: [['Remote & Electronic Notarization (Communication Technology)','18%'],['Authority & Requirements for Notarial Acts','16%'],['Notarial Acts Across Jurisdictions (Other States, Tribal, Federal & Foreign)','14%'],['Certificates & Official Stamp','14%'],['Commissioning, Qualifications & Fees','14%'],['Discipline, Database & Prohibited Acts','12%'],['Definitions','8%'],['General Provisions & Validity','4%']],
  },
  {
    examType: 'ks_notary',
    title: 'Kansas Notary Public Practice Questions', category: 'State Licensing', route: '/notary/ks',
    duration: 'Untimed', questions: '40 Multiple Choice (151-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering the Kansas Revised Uniform Law on Notarial Acts (RULONA), K.S.A. 53-5a01 through 53-5a31, effective 1/1/2022: notarial-act definitions and authority, identification and notarial-act procedures, certificates, official stamps and journal recordkeeping, and interstate, tribal, federal and foreign notarial-act recognition, plus prohibited acts, discipline and validity. Kansas\'s base notary commission is application-only — the Secretary of State does not require a pre-commissioning exam or training course for the general (paper-record) commission; applicants qualify by submitting an oath of office, a $12,000 surety bond (or its functional equivalent), and a $10 application fee, so this bank is a self-study reference, not a simulation of a pass/fail test. Kansas is unusual, however, in codifying one real, narrow exam requirement: K.S.A. 53-5a23 requires a notary to complete a course of study and pass a Secretary-of-State-administered examination before performing their first notarial act on an electronic record — i.e., before adding the optional electronic/remote-notarization endorsement. That requirement is covered in its own dedicated topic below and applies only to that optional scope, never to the base commission.',
    breakdown: [['Definitions & Notarial Act Authority','12%'],['Commissioning, Bonding & Application Requirements','16%'],['Notarial Act Procedures & Identification','16%'],['Certificates, Official Stamps & Journal Requirements','16%'],['Interstate, Tribal, Federal & Foreign Recognition','11%'],['Prohibited Acts, Discipline & Validity','11%'],['Electronic & Remote Notarization Exam Prep (K.S.A. 53-5a23)','18%']],
  },
  {
    examType: 'ky_notary',
    title: 'Kentucky Notary Public Practice Questions', category: 'State Licensing', route: '/notary/ky',
    duration: 'Untimed', questions: '40 Multiple Choice (130-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering Kentucky Revised Statutes Chapter 423 (Notaries Public and Commissioners of Foreign Deeds): the Uniform Recognition of Acknowledgments Act (KRS 423.110-.200) plus Kentucky\'s 2019/2020 RULONA-style modern notary act (KRS 423.300-.465, 2019 Ky. Acts ch. 86) — commissioning qualifications, notarial acts and identification, certificates/stamps/journals and fees, Kentucky\'s unusually developed online-notary and electronic-notarization regime, remote notarization for individuals appearing by communication technology, and recognition of out-of-state, tribal and foreign notarial acts. Kentucky requires neither a training course nor an exam to become a notary — KRS 423.390(2) lists only qualification requirements (18+, US citizen/permanent resident, county residency or employment, English literacy), and KRS 423.415(2) gives the Secretary of State only permissive, not-yet-exercised authority to someday require training by regulation. Instead, applicants apply to the Secretary of State for the commission itself, then must personally appear before the county clerk within 30 days to take the oath of office and file a $1,000 surety bond — and may act as notary only while that bond remains on file with the clerk. This bank is a self-study companion to that application, oath and bonding process, not a simulation of a pass/fail test.',
    breakdown: [['Commissioning, Qualifications, Oath & Bond','22%'],['Notarial Acts, Powers & Identity Verification','18%'],['Online Notary Public & Electronic Notarization','16%'],['Certificates, Stamps, Journals & Fees','14%'],['Remote Notarization for Remotely Located Individuals','12%'],['Acknowledgments & Recognition of Out-of-State/Tribal/Foreign Acts','10%'],['Validity, Discipline & Miscellaneous Provisions','8%']],
  },
  {
    examType: 'ma_notary',
    title: 'Massachusetts Notary Public Practice Questions', category: 'State Licensing', route: '/notary/ma',
    duration: 'Untimed', questions: '40 Multiple Choice (182-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering Massachusetts General Laws Chapter 222 ("Justices of the Peace, Notaries Public and Commissioners"), as comprehensively rewritten by Chapter 289 of the Acts of 2016 (effective January 4, 2017): definitions and key terms, notarial acts and authority, the statutory certificate forms for acknowledgments, jurats, signature witnessing and copy certification, seals and electronic signatures, commissioning and the application process before the Governor and Governor\'s Council, prohibited acts and the duty to serve, boundaries on the practice of law, immigration assistance and real estate closings, journal-keeping requirements, discipline and penalties, notary fees, and remote (communication-technology) notarization as a separate, optional module. Massachusetts requires neither a pre-commission training course nor a state exam -- notaries are appointed directly by the Governor, with the advice and consent of the Governor\'s Council, based on a written application alone -- so this bank is a self-directed study companion to the statute, not a simulation of a pass/fail test.',
    breakdown: [['Definitions and Key Terms','15%'],['Notarial Acts and Authority','10%'],['Certificates and Notarial Forms','7%'],['Seals, Stamps and Electronic Signatures','7%'],['Commissioning, Qualifications and Application','12%'],['Prohibited Acts and Duty to Serve','9%'],['Practice of Law, Immigration and Real Estate Closings','7%'],['Journal Requirements','8%'],['Discipline, Penalties and Revocation','8%'],['Notary Fees','4%'],['Remote and Electronic Notarization','13%']],
  },
  {
    examType: 'mi_notary',
    title: 'Michigan Notary Public Practice Questions', category: 'State Licensing', route: '/notary/mi',
    duration: 'Untimed', questions: '40 Multiple Choice (127-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering Michigan\'s Law on Notarial Acts (2003 PA 238, MCL 55.261-55.315): notary qualifications and appointment by the Secretary of State, the county clerk\'s $10,000 surety bond and oath filing (plus a $10 county filing fee) required before applying, notarial acts and identity-verification standards, electronic and remote (RON) notarization systems, signature/stamp requirements and prohibited conduct, and the Secretary of State\'s misconduct investigation, discipline, and penalty process. Michigan has a genuine dual state/county structure — the Secretary of State is the sole appointing authority under MCL 55.269, but applicants must separately appear in person before their county clerk to file the bond and oath under MCL 55.271(1)(f) and 55.273 — and requires no exam or training course for individual notaries: the notary education and training fund created by MCL 55.277 pays grants to county clerks\' offices for their own staff training, not coursework for notary applicants. This bank is self-study reference content grounded in the actual statute, not exam prep or a course companion.',
    breakdown: [['Qualifications, Application & SOS Appointment','16%'],['County Clerk Filing: Bond, Oath & Fees','11%'],['Notarial Acts & Identity Verification','16%'],['Electronic & Remote (RON) Notarization','19%'],['Signature, Stamp & Prohibited Conduct','13%'],['Misconduct, Discipline & Penalties','18%'],['Commission Maintenance, Records & Fees','7%']],
  },
  {
    examType: 'mn_notary',
    title: 'Minnesota Notary Public Practice Questions', category: 'State Licensing', route: '/notary/mn',
    duration: 'Untimed', questions: '40 Multiple Choice (155-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering Minnesota Statutes Chapter 359 (Notaries Public) and Chapter 358, sections 358.51-358.76 (the Revised Uniform Law on Notarial Acts, effective 1/1/2019), plus the related general seal, oath, and acknowledgment provisions elsewhere in Chapter 358: definitions and key terms, commissioning and application requirements, the official stamp and register, notarial powers and standards of conduct, certificates and electronic recording, interstate/tribal/federal/foreign recognition, remote online notarization, discipline and misconduct, and ex officio notaries and general oath law. Minnesota\'s base notary commission is application-only — notaries are appointed and commissioned directly by the Governor, with the advice and consent of the Senate, after an application to the Secretary of State (a $120 nonrefundable fee); Minnesota requires neither a pre-commissioning training course nor a state-administered exam, and — unlike most states — imposes no surety bond and no errors-and-omissions insurance requirement for the base commission. Minnesota also maintains a distinct Remote Online Notarization program under section 358.645, requiring its own separate Secretary of State registration and technology certification (with no exam of its own), covered in its own dedicated topic below. This bank is a self-study reference grounded in the real statute, not a simulation of a pass/fail test.',
    breakdown: [['Definitions & Key Terms','8%'],['Commission, Application & Qualifications','16%'],['Official Stamp & Records','9%'],['Notarial Powers & Standards of Conduct','13%'],['Certificates & Electronic Recording','12%'],['Interstate, Tribal, Federal & Foreign Notarial Acts','8%'],['Remote Online Notarization (§358.645)','13%'],['Discipline, Prohibited Acts & Misconduct','10%'],['Ex Officio Notaries & General Oath Law','11%']],
  },
  {
    examType: 'ms_notary',
    title: 'Mississippi Notary Public Practice Questions', category: 'State Licensing', route: '/notary/ms',
    duration: 'Untimed', questions: '40 Multiple Choice (116-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering Mississippi Code Title 25, Chapter 34 — the Revised Mississippi Law on Notarial Acts (RULONA-based act effective July 1, 2021, Sections 25-34-1 through 25-34-57): commissioning, qualifications and denial of a commission, notarial acts, authority and identification, seals, stamping devices and journal recordkeeping, fees and certificates of notarial act, recognition of notarial acts performed under other states\', tribal, federal and foreign authority, electronic notarization, and validity, rules and the federal ESIGN Act\'s relation to the chapter. Mississippi requires neither a training course nor a graded exam for a standard notary commission — an applicant need only meet Section 25-34-41(2)\'s eligibility criteria (at least 18 years old, a U.S. citizen or permanent legal resident, a Mississippi resident for the 30 days immediately preceding application, able to read and write English, and not disqualified under Section 25-34-43), execute the constitutional oath of office, and file a $5,000 surety bond with the Secretary of State — so this bank is a self-study reference for the statute itself, not a simulation of a pass/fail test or a companion to any required course.',
    breakdown: [['Commissioning, Qualifications & Denial of Commission','22%'],['Notarial Acts, Authority & Identification','19%'],['Seals, Stamping Devices & Journal','17%'],['Fees & Certificates of Notarial Act','11%'],['Recognition of Notarial Acts (Other States, Tribal, Federal & Foreign)','11%'],['Prohibited Acts, Unauthorized Practice of Law & Penalties','11%'],['Validity, Rules & Federal ESIGN Relation','5%'],['Electronic Notarization','4%']],
  },
  {
    examType: 'nh_notary',
    title: 'New Hampshire Notary Public Practice Questions', category: 'State Licensing', route: '/notary/nh',
    duration: 'Untimed', questions: '40 Multiple Choice (159-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering New Hampshire\'s notary statutes: RSA Chapter 455 (Notaries Public and Commissioners) and RSA Chapter 456-B (New Hampshire\'s enactment of the Revised Uniform Law on Notarial Acts, RULONA) — gubernatorial appointment with advice and consent of the Executive Council, the application requirements including endorsement by 2 sitting notaries public and a registered voter, notarial powers and RULONA definitions, the $10-per-act notarial fee cap and the separate Commissioners of Deeds office, notarial acts performed across jurisdictions and their validity, the RSA 456-B:6-a remote online notarization framework, certificates/short forms/official stamp/journal requirements, and misconduct penalties alongside the Secretary of State\'s manual and education mandate. New Hampshire requires neither a notary exam nor a mandatory pre-commissioning training course — RSA 455:17 obligates the Secretary of State only to prepare and distribute an educational manual for notaries public and justices of the peace — so this bank is grounded, self-study reference content, not a simulation of a pass/fail test or a course companion.',
    breakdown: [['Powers, Notarial Acts & Definitions','20%'],['Certificates, Short Forms, Stamp & Journal','19%'],['Notarial Acts Across Jurisdictions & Validity','14%'],['Appointment, Application & Qualifications','12%'],['Misconduct, Manual & Education','12%'],['Remote Online Notarization','12%'],['Notarial Fees & Commissioners of Deeds','11%']],
  },
  {
    examType: 'nd_notary',
    title: 'North Dakota Notary Public Practice Questions', category: 'State Licensing', route: '/notary/nd',
    duration: 'Untimed', questions: '40 Multiple Choice (171-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering North Dakota Century Code Chapter 44-06.1, North Dakota\'s adoption of the Revised Uniform Law on Notarial Acts (RULONA), NDCC 44-06.1-01 through 44-06.1-30: definitions and key terms, notarial act requirements and identification standards, interstate/tribal/federal/foreign recognition of notarial acts, remote (audiovisual) notarization, certificates and short forms, the official stamp and stamping device, journal recordkeeping, notary vacancies and the electronic notary database, commission qualifications and application, discipline and grounds for complaints, prohibited acts and unauthorized practice of law, and fees, name changes and other administrative provisions. North Dakota requires neither a training course nor a graded exam of any kind — notaries are commissioned directly by the Secretary of State upon application, oath, and a $7,500 surety bond (NDCC 44-06.1-20) — so this bank is grounded self-study reference practice drawn directly from the statute itself, not a simulation of a pass/fail test or a companion to a required course.',
    breakdown: [['Definitions & Key Terms','8%'],['Notarial Act Requirements & Identification','8%'],['Interstate, Tribal, Federal & Foreign Recognition','7%'],['Remote Notarization','11%'],['Certificates & Short Forms','6%'],['Official Stamp & Stamping Device','7%'],['Journals & Recordkeeping','6%'],['Vacancies, Electronic Records & Database','5%'],['Commission Qualifications & Application','10%'],['Discipline, Grounds & Complaints','10%'],['Prohibited Acts & Unauthorized Practice','11%'],['Fees, Name Change & Administrative Provisions','11%']],
  },
  {
    examType: 'ok_notary',
    title: 'Oklahoma Notary Public Practice Questions', category: 'State Licensing', route: '/notary/ok',
    duration: 'Untimed', questions: '40 Multiple Choice (161-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering Oklahoma\'s notary law, spread across three separate sub-acts within Title 49 of the Oklahoma Statutes: the base Notary Public Act (49 O.S. §§ 1-12), covering appointment, application, oath/bond/seal, notarial authority, and revocation; the Uniform Law on Notarial Acts (49 O.S. §§ 111-121), Oklahoma\'s older pre-RULONA uniform act covering acknowledgments, verifications, witnessing, certified copies, certificate forms, and interstate/federal/foreign recognition; and the Remote Online Notary Act (49 O.S. §§ 201-214), covering RON registration, procedures, electronic signatures and seals, and journal/recording retention. Oklahoma is an application-only state — the Secretary of State appoints and commissions notaries directly once an applicant completes the application, passes an OSBI-run national criminal history background check, and files an oath, official seal, and a $10,000 surety bond (one of the highest notary bond amounts of any state, with total upfront cost — bond, filing fee, and background-check fee combined — landing around $220). There is no state-administered notary exam and no mandatory training course of any kind, so this bank is self-study reference content grounded directly in the statute text, not a simulation of a pass/fail test.',
    breakdown: [['Appointment, Qualifications & Application','15%'],['Oath, Bond, Seal & Fees','16%'],['Notarial Authority & Prohibited Practices','13%'],['Status Changes, Discipline & Revocation','10%'],['Notarial Acts & Certificate Forms (Uniform Law)','14%'],['Interstate, Federal & Foreign Recognition (Uniform Law)','10%'],['Remote Online Notary — Registration & Authority','11%'],['Remote Online Notary — Procedures, Records & Fees','11%']],
  },
  {
    examType: 'sc_notary',
    title: 'South Carolina Notary Public Practice Questions', category: 'State Licensing', route: '/notary/sc',
    duration: 'Untimed', questions: '40 Multiple Choice (193-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering South Carolina\'s Notaries Public Act (S.C. Code Title 26, Chapter 1, Sections 26-1-5 through 26-1-240) and the Electronic Notary Public Act (S.C. Code Title 26, Chapter 2, Sections 26-2-5 through 26-2-210, added by 2021 Act No. 85): definitions, the ten-year commission term and county-legislative-delegation application endorsement, notarial powers and procedures, fees and notarial certificates, status changes and resignation, unlawful acts and discipline, interstate recognition and Apostille, and the general electronic-notary regime (registration, certificates, journal and system security, discipline and scope limits). South Carolina\'s base paper-record notary commission is application-only — Section 26-1-15 requires only registered-voter status, English literacy, and a truthful application, with no exam and no mandatory training course — so this bank is a self-study reference on South Carolina notary law, not a simulation of a pass/fail test. One narrow, real exception is covered in its own dedicated topic: Section 26-2-30 requires notaries seeking the optional electronic-notary endorsement to complete a course of instruction and pass an examination before performing electronic notarial acts — a requirement that applies only to that optional endorsement, never to the base commission this track is fundamentally about.',
    breakdown: [['Definitions, Commissioning & Qualifications','14%'],['Notarial Powers, Procedures, Signature-by-Mark & Designee Rules','18%'],['Fees, Seals & Notarial Certificate Requirements','11%'],['Status Changes, Resignation & Death','8%'],['Unlawful Acts, Discipline & Penalties','11%'],['Interstate Recognition, Apostille & Certificate of Authority','8%'],['Electronic Notarization — Registration, Certificates, Journal & Security','20%'],['Electronic Notary Exam Requirement (§26-2-30)','10%']],
  },
  {
    examType: 'sd_notary',
    title: 'South Dakota Notary Public Practice Questions', category: 'State Licensing', route: '/notary/sd',
    duration: 'Untimed', questions: '40 Multiple Choice (123-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering South Dakota notary law across SDCL Chapter 18-1 (Notaries Public), Chapter 18-4 (Acknowledgment and Proof of Instruments), Chapter 18-5 (Uniform Acknowledgment Law), and ARSD Chapter 5:04:03 (Secretary of State administrative rules): commission application, oath and seal requirements, notarial duties, fees and misdemeanors, South Dakota\'s two distinct remote-notarization methods (video-witnessed acknowledgment of tangible documents under SDCL 18-1-11.1 and full Remote Online Notarization of electronic records under SDCL 18-1-11.2 through 18-1-11.8), acknowledgment and proof of instruments, statutory certificate forms, and the Uniform Acknowledgment Law. South Dakota requires neither a notary training course nor a state exam — commissions are issued directly by the Secretary of State upon a completed application, the statutory oath, and a filed seal, and a 2025 law (SL 2025, ch 90) eliminated the prior surety-bond requirement — so this bank is a self-study reference tool grounded in actual state law, not a simulation of a pass/fail test or course.',
    breakdown: [['Commission, Application & Seal','12%'],['Definitions & Key Terms','8%'],['Notarial Duties, Fees & Misdemeanors','14%'],['Video Communication Notarization (Tangible Documents)','12%'],['Remote Online Notarization (RON)','16%'],['Acknowledgment & Proof of Instruments','18%'],['Certificate Forms','10%'],['Uniform Acknowledgment Law','10%']],
  },
  {
    examType: 'tn_notary',
    title: 'Tennessee Notary Public Practice Questions', category: 'State Licensing', route: '/notary/tn',
    duration: 'Untimed', questions: '40 Multiple Choice (137-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering Tennessee Code Annotated Title 8, Chapter 16 (Notaries Public), Parts 1-3 (T.C.A. §§ 8-16-101 through 8-16-313), plus cross-referenced general officeholder qualifications (T.C.A. § 8-18-101), the notary fee statute (T.C.A. § 8-21-1201), and notary civil liability for acknowledgments (T.C.A. § 66-22-113): commissioning, qualifications and county-level election, bond, oath and fees, seals, signatures and certificates, depositions and interstate recognition, discipline, prohibited acts and civil liability, notario-fraud and immigration consumer protections, and the separate Online Notary Public Act governing remote online notarization. Tennessee requires neither a training course nor a separate graded notary exam — a notary is elected by the county legislative body (county commission) of their county of residence or business, approved by the governor, and commissioned through the Secretary of State\'s office after filing a $10,000 surety bond and taking the statutory oath before the county clerk — so this bank is a self-study reference on real state notary law, not a simulation of a pass/fail test or a course companion.',
    breakdown: [['Definitions & Terminology','11%'],['Commissioning, Qualifications & County Election','18%'],['Bond, Oath & Fees','10%'],['Seals, Signatures & Certificates','10%'],['Depositions & Interstate Recognition','5%'],['Discipline, Prohibited Acts & Civil Liability','6%'],['Notario Fraud & Immigration Consumer Protections','6%'],['Online Notary Public Act (Remote Online Notarization)','28%'],['Classification & Practice Notes','6%']],
  },
  {
    examType: 'va_notary',
    title: 'Virginia Notary Public Practice Questions', category: 'State Licensing', route: '/notary/va',
    duration: 'Untimed', questions: '40 Multiple Choice (185-Question Practice Pool)', passScore: 'Application-Only — No State Exam (Changing 7/1/2027)',
    description: 'Note: Virginia\'s notary commissioning requirements are changing on July 1, 2027 — a newly enacted law (HB163/SB316, creating Code of Virginia § 47.1-5.2) will require new-commission applicants to complete a 4-hour course of instruction (including one hour on real estate fraud and financial exploitation of elderly persons) and pass a written examination, and will require every recommission applicant to complete a 2-hour refresher course each time they recommission. Today, and for this practice bank, Virginia is application-only, with no exam and no pre-commission course required. Practice questions covering the Virginia Notary Act (Code of Virginia Title 47.1): general provisions and definitions, appointment and application, electronic notarization and remote online notarization (Virginia was the first state in the nation to authorize RON, in 2012), notarial powers, duties and prohibitions, certificates, fees and administrative duties, term of office, removal and discipline, civil and criminal liability, and a dedicated section previewing the incoming July 2027 course-and-exam requirement. Virginia does not currently administer a graded notary exam or require pre-commission education — a commission is obtained by submitting a complete application and fee to the Secretary of the Commonwealth and taking an oath in person before the clerk of the circuit court where the applicant elects to qualify — so this bank is a self-study companion to the current statute (and, on the July 2027 topic, a preview of the state\'s own already-enacted law), not a simulation of a pass/fail test.',
    breakdown: [['General Provisions & Definitions','10%'],['Appointment, Qualifications & Application','20%'],['Electronic Notarization & Remote Online Notarization (RON)','15%'],['Powers, Duties & Prohibitions','20%'],['Certificates, Fees & Administrative Duties','12%'],['Term of Office, Removal & Discipline','10%'],['Civil & Criminal Liability','7%'],['Coming July 2027: New Course & Exam Requirement','6%']],
  },
  {
    examType: 'wa_notary',
    title: 'Washington Notary Public Practice Questions', category: 'State Licensing', route: '/notary/wa',
    duration: 'Untimed', questions: '40 Multiple Choice (206-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering Washington Revised Code Chapter 42.45, the Uniform Law on Notarial Acts (RULONA): notarial-act authority and requirements, recognizing notarial acts performed in-state, in other states, under tribal or federal authority, and in foreign jurisdictions, certificates of notarial act and the six statutory short forms, official stamp and stamping-device security, commission qualifications, oath and surety bond, discipline and prohibited acts, the notary journal and public database, and the remote/electronic notarization framework at RCW 42.45.190 and 42.45.280. Washington notaries are commissioned by the Department of Licensing (DOL) — not the Secretary of State, as in most other states — and RCW 42.45.200 imposes no exam or training-course requirement: an applicant need only be 18 or older, a Washington resident or have a place of employment or practice in the state, able to read and write English, and willing to execute an oath of office and post a surety bond. This bank is a self-study reference grounded directly in the statute, not a simulation of a pass/fail test — Washington requires neither a course nor an exam.',
    breakdown: [['Definitions, Authority & Notarial Act Requirements','16%'],['Recognizing Notarial Acts (In-State, Other-State, Tribal, Federal & Foreign)','15%'],['Certificates, Short Forms, Stamp & Stamping Device','15%'],['Commission, Qualifications, Oath & Surety Bond','16%'],['Discipline & Prohibited Acts','16%'],['Journal, Fees & Notary Database','10%'],['Remote & Electronic Notarization (Communication Technology)','12%']],
  },
  {
    examType: 'wv_notary',
    title: 'West Virginia Notary Public Practice Questions', category: 'State Licensing', route: '/notary/wv',
    duration: 'Untimed', questions: '40 Multiple Choice (162-Question Practice Pool)', passScore: 'Application-Only — No State Exam',
    description: 'Practice questions covering the West Virginia Revised Uniform Law on Notarial Acts (W. Va. Code §39-4-1 through §39-4-38, effective 7/1/2014) and the companion Out-of-State Commissioners chapter (§39-4A-1, §39-4A-2): notarial-act definitions and authority, personal appearance and identification requirements, interstate, tribal, federal and foreign notarial-act recognition, certificates, short forms and the official stamp, commissioning and qualifications, discipline and prohibited acts, validity and rulemaking, notary liability and criminal penalties, remote online and remote ink notarization, and the separate Out-of-State Commissioner appointment (a distinct, statutorily-fixed $500 fee and 10-year term) used to acknowledge West Virginia real-property documents signed outside the state. West Virginia requires neither a training course nor a separate graded notary exam — the Secretary of State issues a five-year commission directly to applicants who meet six statutory qualifications and swear they have read the notary law — so this bank is a self-study reference on real state notary law, not a simulation of a pass/fail test or a course companion.',
    breakdown: [['Definitions & General Provisions','6%'],['Notarial Acts & Authority Requirements','15%'],['Interstate, Tribal, Federal & Foreign Recognition','13%'],['Certificates, Short Forms & Official Stamp','12%'],['Electronic Records & Technology Selection','3%'],['Commissioning, Qualifications & Fees','12%'],['Discipline, Prohibited Acts & Database','10%'],['Validity, Rules & General Provisions','6%'],['Liability, Criminal Penalties & Enforcement','7%'],['Remote Online & Remote Ink Notarization','10%'],['Out-of-State Commissioners','6%']],
  },
  {
    examType: 'vt_notary',
    title: 'Vermont Notary Public Exam Prep', category: 'State Licensing', route: '/notary/vt',
    duration: 'Untimed', questions: 'Default: 50 Multiple Choice (No Official Count Exists -- Exam Embedded in OPR\'s Online Application, Not Disclosed) -- 227-Question Practice Pool', passScore: '80% (Self-Study Benchmark -- No Official Threshold Published)',
    description: 'Practice questions covering Vermont\'s Uniform Law on Notarial Acts (26 V.S.A. Chapter 103, §§5301-5380), Vermont\'s 2019 RULONA enactment: general provisions and definitions; commissioning, qualifications and the required notary examination; notarial acts, authority and certificates; notarial acts recognized across state, tribal, federal and foreign jurisdictions; remote and electronic notarization and the separate Special Endorsement it requires; and administrative procedures, fees and continuing education. Since February 1, 2021, Vermont has required initial (non-attorney) notary applicants to pass a basic examination on the statutes, rules and ethics relevant to notarial acts (26 V.S.A. §5341(b)(5)) -- administered directly within the Office of Professional Regulation\'s own online licensing application, not by an outside vendor -- but Vermont does not publicly disclose the real exam\'s item count or passing score, so this 227-question bank and 80% benchmark are our own self-study target and practice pool, not confirmed Vermont numbers.',
    breakdown: [['Definitions & General Provisions', '12%'], ['Commissioning, Qualifications & Exam Requirement', '22%'], ['Notarial Acts, Authority & Certificates', '24%'], ['Interstate, Federal & Foreign Recognition', '14%'], ['Remote & Electronic Notarization (Special Endorsement)', '18%'], ['Administrative Procedures, Fees & Continuing Education', '10%']],
  },
  {
    examType: 'az_notary',
    title: 'Arizona Notary Public Exam Prep', category: 'State Licensing', route: '/notary/az',
    duration: 'Untimed', questions: '45 Multiple Choice (219-Question Practice Pool)', passScore: '80% (36 of 45 correct on the real Pearson VUE exam)',
    description: 'Practice questions covering the Arizona Revised Uniform Law on Notarial Acts (A.R.S. Title 41, Chapter 2, Article 1, §§ 41-251 to 41-277) and the Notaries Public Miscellaneous Provisions (Article 2, §§ 41-314 to 41-334): general provisions, commissioning and definitions; notarial acts, procedures and identification/appearance rules; electronic and remote online notarization; signature, seal and certificate forms; fees, bonds and journal recordkeeping; changes in status, enforcement and grounds for discipline; and specialized contexts such as bank/corporate notaries, court reporters, business notary access and apostilles. The real Arizona notary exam is only 45 scored questions, administered by Pearson VUE with an 80% passing score -- this 219-question bank is a much larger practice pool for deeper self-study.',
    breakdown: [['General Provisions, Commissioning & Definitions', '18%'], ['Notarial Acts, Procedures & ID/Appearance Rules', '18%'], ['Fees, Bonds & Journal Recordkeeping', '16%'], ['Changes in Status, Enforcement & Discipline', '12%'], ['Electronic & Remote Online Notarization', '10%'], ['Signature, Seal & Certificate Forms', '10%'], ['Specialized Notary Roles & Business Access', '9%'], ['Cross-Cutting Scenarios & Error Patterns', '7%']],
  },
  {
    examType: 'ar_notary',
    title: 'Arkansas Notary Public Exam Prep', category: 'State Licensing', route: '/notary/ar',
    duration: 'Untimed', questions: '30 Multiple Choice (203-Question Practice Pool)', passScore: '80% (24 of 30 correct on the real ClassMarker exam)',
    description: 'Practice questions covering Arkansas Code Annotated Title 21, Chapter 14 (Notaries Public): General Provisions and qualification/commissioning (Subchapter 1, §§ 21-14-101 et seq.), Facsimile Signatures and Seals (Subchapter 2), and the Arkansas Electronic Notary Public Act (Subchapter 3), along with related cross-references in §§ 21-6-309 and 4-109-101 et seq. Topics span general provisions, qualification, application, bond and commissioning; notarial acts, powers, limitations, fees and procedure; electronic and remote notarization; signature, seal, certificate forms and journal practice; and changes in status, enforcement and multi-state jurisdiction. The real Arkansas notary exam is a 30-question multiple-choice test delivered online through ClassMarker via the link inside the applicant\'s official Secretary of State online notary application, requiring 24 of 30 correct (80%) to pass -- this 203-question bank is a much larger practice pool for self-study.',
    breakdown: [['General Provisions, Qualification, Application & Bond', '19%'], ['Notarial Acts, Powers, Limitations, Fees & Procedure', '20%'], ['Electronic & Remote Notarization', '26%'], ['Signature, Seal, Certificate Forms & Journal Practice', '14%'], ['Changes in Status, Enforcement & Multi-State Jurisdiction', '21%']],
  },
  {
    examType: 'co_notary',
    title: 'Colorado Notary Public Exam Prep', category: 'State Licensing', route: '/notary/co',
    duration: 'Untimed', questions: '40 Multiple Choice (248-Question Practice Pool)', passScore: '80% (32 of 40 correct; per an SOS-approved training vendor, not the SOS\'s own site)',
    description: 'Practice questions covering Colorado\'s Revised Uniform Law on Notarial Acts (RULONA), C.R.S. 24-21-501 to 24-21-540: general provisions, commissioning and statutory definitions; notarial acts, powers, duties and fees; identification standards, certificates, seals and stamping devices; electronic and remote notarization (C.R.S. 24-21-514.5 and 24-21-520); the notarial journal and electronic records; discipline and prohibited acts; and interstate, tribal, federal and foreign recognition of notarial acts. The real Colorado Notary Public Examination -- RULONA is a free, open-book exam taken online through the Secretary of State\'s own eLearning portal, runs about 30 minutes, and is not proctored. Colorado\'s own site doesn\'t publish the item count, but an SOS-approved training vendor cites 40 questions at 80% to pass -- this bank is a much larger practice pool -- 248 questions across 20 statute-grounded topic areas -- for self-study well beyond what the official exam covers.',
    breakdown: [['General Provisions, Commissioning & Definitions', '21%'], ['Notarial Acts, Powers, Duties & Fees', '22%'], ['Identification, Certificates & Seal/Stamp Requirements', '17%'], ['Electronic & Remote Notarization', '14%'], ['Journal & Electronic Records', '7%'], ['Discipline & Prohibited Acts', '14%'], ['Interstate, Tribal, Federal & Foreign Recognition', '5%']],
  },
  {
    examType: 'ct_notary',
    title: 'Connecticut Notary Public Exam Prep', category: 'State Licensing', route: '/notary/ct',
    duration: 'Untimed', questions: 'Default: 35 Multiple Choice (No Official Count Exists -- Real Exam Is Embedded in the Application, No Fixed Length) -- 121-Question Practice Pool', passScore: '100% (Every Question on the Real Application-Embedded Exam Must Be Correct)',
    description: 'Practice questions covering Connecticut\'s notary statute (Conn. Gen. Stat. §§ 3-94a to 3-95b): definitions, appointment and qualifications, notarial acts, prohibited conduct and fees, electronic and remote notarization, signature/seal/certificate requirements, changes in status, and liability, discipline and enforcement (including the § 51-88 unauthorized-practice-of-law cross-reference). Connecticut has no separate proctored notary exam -- the required test is embedded directly in the online application submitted through eLicense.ct.gov, is self-administered and untimed, and requires every question answered correctly (100%) before the application can proceed. Connecticut\'s notary statute is comparatively compact (about 15 sections), so this 121-question bank, while thorough across all of it, is smaller than some other states\' banks.',
    breakdown: [['Definitions, Appointment & Qualifications', '25%'], ['Notarial Acts, Prohibited Conduct & Fees', '9%'], ['Electronic & Remote Notarization', '21%'], ['Signature, Seal & Certificate Forms', '7%'], ['Changes in Status, Discipline & Enforcement', '19%'], ['Statutory Nuances, Historical Changes & Integrated Scenarios', '19%']],
  },
  {
    examType: 'hi_notary',
    title: 'Hawaii Notary Public Exam Prep', category: 'State Licensing', route: '/notary/hi',
    duration: 'Untimed', questions: 'Default: 45 Multiple Choice (No Official Count Exists -- Not Published by Hawaii\'s AG) -- 218-Question Practice Pool', passScore: '80% (Real, Confirmed Threshold on the In-Person AG Exam)',
    description: 'Practice questions covering Hawaii Revised Statutes Chapter 456 (Notaries Public), Sections 456-1 through 456-27, and the Department of the Attorney General\'s implementing Hawaii Administrative Rules Title 5, Chapter 5-11: fees, discipline and enforcement; electronic and remote online notarization; commissioning eligibility and the application lifecycle; notarial powers, duties and practice mechanics; seal, signature and journal recordkeeping; definitions and key terms; and examination procedures and scheduling. Hawaii is unusual among states in that notaries are commissioned by the Department of the Attorney General rather than a Secretary of State. The real Hawaii notary exam is a much shorter, written, closed-book, in-person multiple-choice test of roughly 45 scored questions administered directly by the Department of the Attorney General, requiring an 80% passing score under HAR Chapter 5-11 -- this 218-question bank is a larger practice pool built for thorough self-study, not a simulation of the exact test length.',
    breakdown: [['Fees, Discipline & Enforcement', '23%'], ['Electronic & Remote Online Notarization', '20%'], ['Commissioning, Eligibility & Application Lifecycle', '17%'], ['Notarial Powers, Duties & Practice Mechanics', '16%'], ['Seal, Signature & Journal Recordkeeping', '13%'], ['Definitions & Key Terms', '7%'], ['Examination Procedures & Scheduling', '4%']],
  },
  {
    examType: 'il_notary',
    title: 'Illinois Notary Public Exam Prep', category: 'State Licensing', route: '/notary/il',
    duration: 'Untimed', questions: '50 Multiple Choice (218-Question Practice Pool)', passScore: '85% (at least 42 of 50 correct on the real course-embedded exam)',
    description: 'Practice questions covering the Illinois Notary Public Act (5 ILCS 312), including its 2023 Article/Section renumbering and substantive rewrite under P.A. 102-160: general provisions and statutory definitions, commissioning, training and bond requirements, duties, seals, fees and authority, notarial acts and certificate forms, electronic and remote notarization, liability, misconduct and revocation, and status changes and reappointment. A second, deeper pass adds scenario-based application questions, error-spotting on prohibited acts, fee and deadline computation, and true statutory gaps and edge cases. The real Illinois notary exam is a 50-question, 85%-to-pass test administered online immediately after the required 3-hour SOS-approved training course; this bank is a much larger practice pool for self-study, not a copy of that exam.',
    breakdown: [['General Provisions & Definitions', '16%'], ['Commissioning, Training, Bond, Status Changes & Reappointment', '24%'], ['Duties, Seal, Fees & Authority', '19%'], ['Notarial Acts & Forms', '13%'], ['Electronic & Remote Notarization', '10%'], ['Liability, Misconduct & Revocation', '12%'], ['Statutory Gaps & Edge Cases', '6%']],
  },
  {
    examType: 'in_notary',
    title: 'Indiana Notary Public Exam Prep', category: 'State Licensing', route: '/notary/in',
    duration: 'Untimed', questions: '30 Multiple Choice (251-Question Practice Pool)', passScore: '80% (24 of 30 correct; per industry sources, not Indiana\'s own gated portal)',
    description: 'Practice questions covering Indiana Code Title 33, Article 42 (Notaries Public) and Indiana\'s Revised Uniform Law on Notarial Acts framework: definitions, general provisions and notarial officers, commissioning and continuing education, notarial acts, certificates, seals and stamping devices, identity verification and signing scenarios, remote and electronic notarization, and discipline, fees, apostilles and validity of notarial acts. Indiana\'s real qualifying exam is bundled with a required paid online education course, delivered through the Secretary of State\'s INBiz-linked Applicant Hub and Learner Hub after a $75 application fee -- the portal itself is gated, but industry sources consistently cite 30 questions at 80% to pass -- this bank is a much larger, free-to-study practice pool grounded in the statute.',
    breakdown: [['Definitions, General Provisions & Notarial Officers', '21%'], ['Discipline, Fees, Apostilles & Validity', '20%'], ['Remote & Electronic Notarization', '19%'], ['Notarial Acts, Certificates, Seals & Stamping Devices', '16%'], ['Identity Verification & Signing Scenarios', '13%'], ['Commissioning, Application & Continuing Education', '11%']],
  },
  {
    examType: 'la_notary',
    title: 'Louisiana Notary Public Exam Prep', category: 'State Licensing', route: '/notary/la',
    duration: '4 Hours', questions: 'Default: 50 Multiple Choice (No Official Count Exists -- Undisclosed by Design, LSU Cites Item Security) -- 330-Question Practice Pool', passScore: '70/100 Scaled Score (Real 4-Hour LSU-Proctored Exam)',
    description: 'Practice questions covering Louisiana Revised Statutes Title 35 (Notaries Public and Commissioners, including the Remote Online Notarization Act) together with the Louisiana Civil Code\'s authentic-act practice areas that make Louisiana notaries unique among U.S. states -- successions and forced heirship, donations and testaments, matrimonial regimes and community property, acts of sale and mortgages, and contractual capacity and nullity of acts. Topics span commissioning and examination eligibility, general duties and prohibited acts, disciplinary grounds and liability, seal/signature/recordkeeping, and electronic and remote online notarization, alongside the civil-law succession, donation, and matrimonial-regime content a Louisiana notary must master to draft authentic acts with quasi-attorney authority no other state\'s notaries hold. The real exam is a 4-hour, computer-based test administered by the LSU Office of Testing and Evaluation Services on behalf of the Secretary of State, requiring a scaled score of 70/100, and historical pass rates have run only 15-30% (and sometimes lower) -- reflecting the exam\'s unusual depth and rigor. This 330-question bank, built across two batches, is deliberately larger than a typical state notary track to mirror that breadth and give candidates more repetitions across both the notary statute and the Civil Code material the real exam draws from.',
    breakdown: [['Donations, Testaments & Matrimonial Regimes', '20%'], ['Successions & Forced Heirship', '16%'], ['General Duties, Prohibited Acts & Disciplinary Liability', '15%'], ['Authentic Acts, Form Requirements & Contractual Capacity', '15%'], ['Acts of Sale, Mortgages & Lesion', '9%'], ['Commissioning, Eligibility & Examination', '10%'], ['Electronic & Remote Online Notarization (RON)', '8%'], ['Seal, Signature & Recordkeeping', '7%']],
  },
  {
    examType: 'md_notary',
    title: 'Maryland Notary Public Exam Prep', category: 'State Licensing', route: '/notary/md',
    duration: 'Untimed', questions: '20 Multiple Choice (215-Question Practice Pool)', passScore: '80% (the COMAR-mandated minimum across all 14 authorized exam providers)',
    description: 'Practice questions covering Maryland notary law under Md. Code, State Government Article, Title 18 (Notaries Public) and its implementing regulations at COMAR 01.02.08: appointment, qualifications and commissioning; notarial acts, powers and duties; certificates, seals and journals; remote and electronic notarization; fees, discipline and enforcement; and recognition of out-of-state, tribal, federal and foreign notarial acts. Unlike a single uniform state exam, Maryland delegates notary testing to 14 state-authorized Course of Study and Examination Providers, each required under COMAR 01.02.08.16 to administer at least 20 multiple-choice questions -- drawn from its own bank of at least 50 distinct questions -- with an 80% passing score. This 215-question bank is a much larger, unified practice pool spanning that same statutory and regulatory material, rather than any single provider\'s individual test.',
    breakdown: [['Fees, Discipline & Enforcement', '24%'], ['Certificates, Seals & Journals', '22%'], ['Notarial Acts, Powers & Duties', '16%'], ['Remote & Electronic Notarization', '15%'], ['Appointment, Qualifications & Commissioning', '13%'], ['Recognition of Other Jurisdictions\' Notarial Acts', '10%']],
  },
  {
    examType: 'me_notary',
    title: 'Maine Notary Public Exam Prep', category: 'State Licensing', route: '/notary/me',
    duration: 'Untimed', questions: '15 Multiple Choice (215-Question Practice Pool)', passScore: '80% (self-study benchmark; Maine\'s real 15-question application exam has no published passing score)',
    description: 'Practice questions covering Maine Revised Statutes Title 4, Chapter 39 (the Revised Uniform Law on Notarial Acts, or RULONA) and the Secretary of State\'s implementing rules at C.M.R. Chapter 700: general provisions and commissioning, notarial acts and procedures, certificates, stamps and journal recordkeeping, electronic and remote notarization and technology-provider standards, jurisdiction and interstate/foreign recognition, prohibited acts and conflicts of interest, and complaint/discipline procedure. Maine\'s real notary exam, by contrast, is unusually light — just 15 multiple-choice/true-false/select-all questions embedded directly in the official paper application (Form ME NOT APP), plus a separate 8-term matching exercise, completed open-book and unproctored at home with no numeric passing score published anywhere — making this 215-question bank a far deeper self-study resource than the state\'s own exam.',
    breakdown: [['Electronic & Remote Notarization', '24%'], ['General Provisions, Commissioning & Application', '18%'], ['Prohibited Acts, Conflicts of Interest & Discipline', '18%'], ['Notarial Acts & Procedures', '11%'], ['Notary Ethics, Practical Administration & Statutory Construction', '11%'], ['Certificates, Stamps & Journal Recordkeeping', '10%'], ['Jurisdiction, Interstate/Foreign Recognition & Certified Copies', '8%']],
  },
  {
    examType: 'mo_notary',
    title: 'Missouri Notary Public Exam Prep', category: 'State Licensing', route: '/notary/mo',
    duration: 'Untimed', questions: '30 Multiple Choice (249-Question Practice Pool)', passScore: '80% (24 of 30 correct, per RSMo 486.630 and the SOS\'s own registration guide)',
    description: 'Practice questions covering Missouri Revised Statutes Chapter 486, Notaries Public and Notarial Acts: general/paper notarial acts (RSMo 486.600-486.830), electronic notaries (RSMo 486.900-486.1010), and remote online notarial acts (RSMo 486.1100-486.1205), plus related criminal penalties under RSMo 578.700. Major topic areas include commissioning, application and status changes; notarial authority, prohibited acts and conduct; fees, journal and recordkeeping; seals, certificates and cross-border forms; electronic notarization; remote online notarization (RON); discipline, penalties and rulemaking; and statutory definitions. The real Missouri notary exam is a 30-question test administered directly by the Secretary of State, requiring 24 of 30 correct (80%) per RSMo 486.630 -- this bank is a much larger 249-question practice pool for deeper self-study.',
    breakdown: [['Commissioning, Application & Status Changes', '20%'], ['Fees, Journal & Recordkeeping', '15%'], ['Remote Online Notarization (RON)', '15%'], ['Electronic Notarization (Registration & Operations)', '14%'], ['Notarial Authority, Prohibited Acts & Conduct', '12%'], ['Seals, Certificates & Cross-Border Forms', '10%'], ['Definitions & Terminology', '8%'], ['Discipline, Penalties & Rulemaking', '6%']],
  },
  {
    examType: 'mt_notary',
    title: 'Montana Notary Public Exam Prep', category: 'State Licensing', route: '/notary/mt',
    duration: 'Untimed', questions: '30 Multiple Choice (202-Question Practice Pool)', passScore: '80% (real 30-question SOS-administered online exam, per ARM 44.15.101)',
    description: 'Practice questions covering Montana Code Annotated Title 1, Chapter 5, Part 6 (the Revised Uniform Law on Notarial Acts, MCA 1-5-601 to 1-5-632) and Administrative Rule 44.15.101 governing the notary exam: general provisions and definitions, commissioning qualifications and bond, notarial acts, certificates and identification, remote and electronic notarization, signature, stamp and journal recordkeeping, fees, prohibited acts and discipline, and federal, tribal and foreign notarial-act recognition. The real Montana notary exam is a free, untimed, self-administered 30-question quiz embedded directly on the Secretary of State\'s website, requiring an 80% passing score under ARM 44.15.101(4)(a)(i); this 202-question bank is a much larger practice pool for study, not a copy of the official quiz.',
    breakdown: [['General Provisions & Definitions', '15%'], ['Commissioning, Qualifications & Bond', '13%'], ['Notarial Acts, Certificates & Identification', '15%'], ['Remote & Electronic Notarization', '5%'], ['Signature, Stamp & Journal Recordkeeping', '11%'], ['Fees, Prohibited Acts & Discipline', '17%'], ['Federal, Tribal & Foreign Notarial Acts', '8%'], ['Applied Notarial Scenarios', '16%']],
  },
  {
    examType: 'ne_notary',
    title: 'Nebraska Notary Public Exam Prep', category: 'State Licensing', route: '/notary/ne',
    duration: 'Untimed', questions: '20 Multiple Choice (221-Question Practice Pool)', passScore: '85% (real 20-question Secretary of State exam via ClassMarker)',
    description: 'Practice questions covering Nebraska Revised Statutes Chapter 64 (Notaries Public), including general provisions, qualifications and commissioning; notarial acts, duties, certificates, acknowledgments and seals; discipline, removal and civil liability; identity verification and disqualifying relationships; the Electronic Notary Public Act (in-person e-notarization); the Online Notary Public Act (remote notarization); and cross-regime comparisons and practical best practices. The real Nebraska Secretary of State notary exam is only 20 scored questions, delivered online through ClassMarker, with an 85% passing score, three attempts, and a passing result valid for 90 days -- this 221-question bank is a much larger practice pool for self-study, not a copy of the official exam.',
    breakdown: [['Notarial Acts, Certificates & Acknowledgments', '28%'], ['Discipline, Removal & Civil Liability', '15%'], ['Online Notary Public Act (Remote Notarization)', '15%'], ['General Provisions, Qualifications & Commissioning', '13%'], ['Cross-Regime Comparisons & Best Practices', '10%'], ['Electronic Notary Public Act (In-Person e-Notarization)', '10%'], ['Identity Verification & Disqualification', '9%']],
  },
  {
    examType: 'nj_notary',
    title: 'New Jersey Notary Public Exam Prep', category: 'State Licensing', route: '/notary/nj',
    duration: 'Untimed', questions: 'Default: 50 Multiple Choice (No Official Count Exists -- Left to State Treasurer\'s Discretion, Undisclosed) -- 202-Question Practice Pool', passScore: '80% (Self-Study Benchmark -- No Official Threshold Published)',
    description: 'Practice questions covering New Jersey\'s Law on Notarial Acts (N.J.S.A. 52:7-10 et seq., as amended by P.L. 2021, c.179): commissioning, application, course of study and exam administration procedures; notarial acts, identification standards, certificates and notarial authority; official stamp and journal recordkeeping; discipline, prohibited acts and multi-jurisdiction recognition; electronic and remote notarization; and statutory definitions and exam-style application scenarios. Since July 2022, New Jersey has required most new non-attorney notary applicants to complete a state-approved 6-hour course and pass a state-run exam delivered through the Division of Revenue and Enterprise Services\' own online portal, but the state does not publicly disclose the real exam\'s item count or passing score -- this 202-question bank is a much larger practice pool for self-study.',
    breakdown: [['Commissioning, Application, Course of Study & Exam Procedures', '25%'], ['Notarial Acts, Identification, Certificates & Authority', '22%'], ['Official Stamp & Journal Recordkeeping', '17%'], ['Discipline, Prohibited Acts & Multi-Jurisdiction Recognition', '15%'], ['Electronic & Remote Notarization', '11%'], ['Statutory Definitions & Exam-Style Application Traps', '10%']],
  },
  {
    examType: 'nm_notary',
    title: 'New Mexico Notary Public Exam Prep', category: 'State Licensing', route: '/notary/nm',
    duration: 'Untimed', questions: '50 Multiple Choice (224-Question Practice Pool)', passScore: '80% (60-minute, 50-question real exam via the NM SOS\'s designated vendor)',
    description: 'Practice questions covering New Mexico\'s Revised Uniform Law on Notarial Acts (RULONA), NMSA 1978, Chapter 14, Article 14A (Sections 14-14A-1 to 14-14A-32): general provisions, definitions and commissioning; notarial acts, authority, identification and applied signing/refusal scenarios; certificates, official stamp and journal recordkeeping; electronic and remote online notarization (RON); discipline, ethics, prohibited acts and fees; and interstate, federal and foreign notarial acts. The real New Mexico notary exam is a 50-question, 60-minute test with an 80% passing score, delivered online by the National Notary Association as the Secretary of State\'s designated training/exam vendor -- this 224-question bank is a much larger practice pool for self-study.',
    breakdown: [['General Provisions, Definitions & Commissioning', '20%'], ['Notarial Acts, Authority, ID & Applied Scenarios', '13%'], ['Certificates, Stamp & Journal Recordkeeping', '20%'], ['Electronic & Remote Notarization', '12%'], ['Discipline, Ethics, Prohibited Acts & Fees', '26%'], ['Interstate, Federal & Foreign Notarial Acts', '9%']],
  },
  {
    examType: 'nv_notary',
    title: 'Nevada Notary Public Exam Prep', category: 'State Licensing', route: '/notary/nv',
    duration: 'Untimed', questions: 'Default: 50 Multiple Choice (No Official Count Exists -- Not Published by Nevada) -- 249-Question Practice Pool', passScore: '80% (Self-Study Benchmark -- No Official Threshold Published)',
    description: 'Practice questions covering Nevada Revised Statutes Chapter 240 (Notaries Public and Commissioned Abstracters), including the Uniform Law on Notarial Acts (NRS 240.161-240.169) and the Electronic Notarization Enabling Act (NRS 240.181-240.206), plus implementing regulations in Nevada Administrative Code Chapter 240: appointment, training and bond requirements; notarial powers, duties, prohibited acts and conflicts of interest; certificates, statutory short forms and satisfactory evidence; electronic notarization; fees, stamp and journal recordkeeping; definitions, public records and notarial acts performed by other jurisdictions; and violations, discipline and hearing procedure. Nevada notary applicants must complete a course of study of at least 3 hours that includes an examination, as required by NRS 240.018, but that course and exam are delivered by whichever Secretary of State-approved provider the applicant chooses -- no single statewide item count or passing score is published in statute.',
    breakdown: [['Appointment, Training & Bond', '20%'], ['Fees, Stamp & Journal Recordkeeping', '19%'], ['Electronic Notarization', '16%'], ['Certificates, Short Forms & Satisfactory Evidence', '14%'], ['Definitions, Public Records & Other Jurisdictions', '13%'], ['Notarial Powers, Duties, Prohibited Acts & Conflicts', '10%'], ['Violations, Discipline & Hearing Procedure', '8%']],
  },
  {
    examType: 'oh_notary',
    title: 'Ohio Notary Public Exam Prep', category: 'State Licensing', route: '/notary/oh',
    duration: 'Untimed', questions: 'Default: 50 Multiple Choice (No Official Count Exists -- Ohio Rule Bars a Single Uniform Test) -- 237-Question Practice Pool', passScore: '80% (Self-Study Benchmark -- ~15 Approved Providers Each Set Their Own Score)',
    description: 'Practice questions covering Ohio Revised Code Chapter 147 (Notaries Public), as substantially rewritten by the 2019 notary modernization act (Senate Bill 263) and subsequently amended through House Bill 315 (2025): commissioning and qualifications, notarial acts, identification and acknowledgments, certificate and short forms, electronic journals and recordkeeping security, remote online notarization (RON), seals, fees and jurisdiction, prohibited acts and advertising, term/renewal/discipline and investigations, and the mandatory adult-abuse reporting duty notaries share under R.C. 5101.63. Unlike some states, Ohio does not administer a single statewide notary exam -- education and testing are delivered directly by Secretary of State-authorized third-party providers (county bar associations, law libraries, and companies such as the National Notary Association), so there is no official statewide item count or passing score to cite; this bank uses an 80% self-study benchmark instead.',
    breakdown: [['Notarial Acts, Identification, Acknowledgments & Depositions', '27%'], ['Remote Online Notarization (RON)', '23%'], ['Electronic Journals & Recordkeeping Security', '13%'], ['Commissioning & Qualifications', '11%'], ['Seal, Fees & Jurisdiction', '9%'], ['Term, Renewal, Discipline & Investigations', '8%'], ['Prohibited Acts & Advertising', '6%'], ['Mandatory Reporting of Adult Abuse', '3%']],
  },
  {
    examType: 'or_notary',
    title: 'Oregon Notary Public Exam Prep', category: 'State Licensing', route: '/notary/or',
    duration: 'Untimed', questions: 'Default: 50 Multiple Choice (No Official Count Exists -- Real Exam Allows Unlimited Retakes, No Fixed Length) -- 199-Question Practice Pool', passScore: '80% (Self-Study Benchmark -- No Official Threshold Published)',
    description: 'Practice questions covering Oregon Revised Statutes Chapter 194 (Notaries Public and Other Officers Performing Notarial Acts), including the Uniform Law on Notarial Acts at ORS 194.215-194.410 and penalty/civil-remedy sections through 194.990, plus Oregon Administrative Rules Chapter 160, Division 100: general provisions and commissioning qualifications, notarial acts, powers, duties and the statutory short-form acts, certificates, official stamps and journal recordkeeping, identification and satisfactory-evidence standards, fees, prohibited acts and protest of commercial paper, electronic and remote (RON) notarization, and discipline, enforcement and penalty scenarios. Oregon does require applicants to pass the Secretary of State\'s own Notary Public examination after completing the mandatory "Basics" training course, but the state does not publicly disclose the real exam\'s item count or passing score, so our 80% benchmark and 199-question bank are our own self-study target and practice pool, not confirmed Oregon numbers.',
    breakdown: [['General Provisions, Commissioning & Qualifications', '16%'], ['Notarial Acts, Powers, Types & Recognition', '15%'], ['Certificates, Seals, Stamps & Journal Recordkeeping', '20%'], ['Identification & Satisfactory Evidence', '7%'], ['Fees, Prohibited Acts & Protest', '14%'], ['Electronic & Remote Notarization', '10%'], ['Discipline, Enforcement & Penalties', '10%'], ['Integrative Scenario Review', '8%']],
  },
  {
    examType: 'pa_notary',
    title: 'Pennsylvania Notary Public Exam Prep', category: 'State Licensing', route: '/notary/pa',
    duration: '60 Minutes', questions: '30 Multiple Choice (251-Question Practice Pool)', passScore: 'Scaled Score of 75 (Real 60-Minute Pearson VUE Exam)',
    description: 'Practice questions covering Pennsylvania\'s Revised Uniform Law on Notarial Acts (57 Pa.C.S. Chapter 3) and its newly effective implementing regulations (4 Pa. Code Chapters 161 and 167, adopted March 27, 2026 and effective March 28, 2026): certificates, stamps and journal recordkeeping, definitions and cross-jurisdictional notarial authority, conduct, sanctions and prohibited acts, appointment, qualifications and bonding, notarial acts and identification of signers, electronic and remote notarization, notary education requirements, fees and administration, and RULONA\'s transitional and general provisions. The real Pennsylvania notary exam is a proctored, 60-minute, computer-based test administered by Pearson VUE under Department of State contract: 30 total items (25 scored, 5 unscored pretest questions candidates can\'t identify), requiring a scaled passing score of 75, with results valid for only one year from the exam date (4 Pa. Code §167.15(d)(2)); this bank offers a much larger 251-question practice pool for deeper self-study.',
    breakdown: [['Certificates, Stamps & Journal Recordkeeping', '21%'], ['Definitions, Scope & Cross-Jurisdictional Authority', '14%'], ['Conduct, Sanctions & Prohibited Acts', '14%'], ['Appointment, Qualifications & Bond', '12%'], ['Notarial Acts & Identification Procedures', '12%'], ['Electronic & Remote Notarization', '10%'], ['Notary Education', '8%'], ['Fees & Administration', '7%'], ['Transitional & General Provisions', '2%']],
  },
  {
    examType: 'ri_notary',
    title: 'Rhode Island Notary Public Exam Prep', category: 'State Licensing', route: '/notary/ri',
    duration: 'Untimed', questions: 'Default: 50 Multiple Choice (No Official Count Exists -- RI\'s Own Manual Calls It Just \'Multi-Question\') -- 212-Question Practice Pool', passScore: '80% (Real Self-Graded Exam via the Secretary of State\'s Own Site)',
    description: 'Practice questions covering Rhode Island General Laws Chapter 42-30.1 (Uniform Law on Notarial Acts): commissioning and qualification requirements, notarial acts, authority and refusal determinations, official stamp, fees and prohibited/advertising conduct, electronic and remote notarization procedures, discipline, validity and transition provisions, key statutory definitions, and interstate/federal/foreign recognition. The real Rhode Island notary exam is a self-graded, 80%-threshold Notary Knowledge Assessment taken online (via ClassMarker) directly on the Secretary of State\'s own site, not administered by an outside testing vendor -- a lighter-weight process than many other states, while this bank offers a much larger practice pool than the real assessment for thorough self-study.',
    breakdown: [['Commissioning, Qualifications & General Provisions', '16%'], ['Official Stamp, Fees & Prohibited Acts', '19%'], ['Notarial Acts, Authority & Determinations', '16%'], ['Electronic & Remote Notarization', '15%'], ['Discipline, Validity & Transition Provisions', '15%'], ['Definitions & Key Terms', '10%'], ['Interstate, Federal & Foreign Recognition', '9%']],
  },
  {
    examType: 'ut_notary',
    title: 'Utah Notary Public Exam Prep', category: 'State Licensing', route: '/notary/ut',
    duration: 'Untimed', questions: '35 Multiple Choice (222-Question Practice Pool)', passScore: '80% (Self-Study Benchmark) -- Real Utah exam uses a different weighted-point system: 61 of 65 points (93.8%) required',
    description: 'Practice questions covering Utah\'s Notaries Public Reform Act (Utah Code Title 46, Chapter 1, Sections 46-1-2 to 46-1-23): general provisions and definitions, commissioning, qualifications and bond, notarial acts and certificates, signature, seal and journal recordkeeping, remote and electronic notarization, and fees and prohibited acts/discipline. Utah\'s real notary exam is taken online directly through notary.utah.gov and administered by the Office of the Lieutenant Governor (Utah has no Secretary of State) -- it is 35 multiple-choice questions worth 65 total points (10 questions worth 4 points, 25 worth 1 point), and candidates must score 61 points or higher to pass, per the Lt. Governor\'s official Notary Public Study Guide and Handbook. Our own 50-question mock exam format differs from that weighted structure, so we grade practice attempts against our own 80% self-study benchmark rather than replicating the real exam\'s point system; content is drawn from a broader 222-question practice pool for variety across repeated attempts.',
    breakdown: [['Signature, Seal & Journal Recordkeeping', '27%'], ['Commissioning, Qualifications & Bond', '24%'], ['Fees & Prohibited Acts/Discipline', '16%'], ['Notarial Acts & Certificates', '12%'], ['General Provisions & Definitions', '11%'], ['Remote & Electronic Notarization', '10%']],
  },
  {
    examType: 'wi_notary',
    title: 'Wisconsin Notary Public Exam Prep', category: 'State Licensing', route: '/notary/wi',
    duration: 'Untimed', questions: '30 Multiple Choice (201-Question Practice Pool)', passScore: '90% (27 of 30 correct on the real DFI online exam)',
    description: 'Practice questions covering Wisconsin\'s Notaries Public and Notarial Acts law (Wis. Stat. Chapter 140), the state\'s 2018 enactment of the Revised Uniform Law on Notarial Acts, implemented by Wis. Admin. Code ch. DFI-CCS 25: general provisions and definitions; commissioning, application, renewal and bond requirements; notarial authority, duties and act types; certificates, seals and execution mechanics; fees, confidentiality, misconduct and DFI rulemaking authority; interstate, tribal and foreign recognition of notarial acts; remote and electronic notarization, including the Remote Notary Council; and remote execution of estate planning documents under attorney supervision. The real Wisconsin notary exam is a 30-question, untimed online test administered directly by the Department of Financial Institutions (not the Secretary of State), requiring 90% or better to pass -- this 201-question bank is a much larger practice pool for deeper self-study across repeated practice attempts.',
    breakdown: [['General Provisions & Definitions', '11%'], ['Commissioning, Application, Renewal & Bond', '12%'], ['Notarial Authority, Duties & Act Types', '11%'], ['Certificates, Seals & Execution Mechanics', '11%'], ['Fees, Confidentiality, Misconduct & DFI Rulemaking', '12%'], ['Interstate, Tribal & Foreign Recognition', '10%'], ['Remote & Electronic Notarization (incl. Remote Notary Council)', '15%'], ['Remote Estate Planning Execution', '9%'], ['Scenario Application & Error Patterns', '9%']],
  },
  {
    examType: 'wy_notary',
    title: 'Wyoming Notary Public Exam Prep', category: 'State Licensing', route: '/notary/wy',
    duration: 'Untimed', questions: '20 Multiple Choice (200-Question Practice Pool)', passScore: '14/20 Correct (70%) -- REAL confirmed Wyoming statutory threshold, W.S. § 32-3-121(a)',
    description: 'Practice questions covering the Wyoming Revised Uniform Law on Notarial Acts, Wyo. Stat. §§ 32-3-101 to 32-3-131: general provisions, definitions and interstate/federal/foreign recognition; commissioning, qualifications, discipline and prohibited acts; notarial acts, certificates and short-form determinations; and signature, stamp, journal, fee and remote-notarization mechanics, plus original scenario-based questions applying these rules to fact patterns. The real Wyoming Secretary of State commissioning exam is a 20-question true/false test built directly into the Notary Public Commission Application, requiring at least 14 correct (70%) to pass under W.S. § 32-3-121(a). Our questions are multiple-choice rather than true/false and are drawn from a 200-question practice pool, so repeated practice attempts see fresh variety rather than the same 20 items every time.',
    breakdown: [['General Provisions, Definitions & Interstate Recognition', '28%'], ['Signature, Stamp, Journal, Fees & Remote Notarization', '27%'], ['Scenario-Based Application', '16%'], ['Commissioning, Qualifications & Discipline', '15%'], ['Notarial Acts, Certificates & Determinations', '14%']],
  },
  {
    examType: 'al_driver',
    title: 'Alabama Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/al',
    duration: 'Untimed', questions: '30 Multiple Choice (293-Question Practice Pool)', passScore: '80% (24/30 Correct) -- Well-Corroborated, Not ALEA-Confirmed',
    description: 'Practice questions covering the Alabama Driver Manual (Alabama Law Enforcement Agency, November 2024 edition): licensing and the graduated driver license stages, losing your license and the point system, the driving task and parking, sharing the road with bicycles, motorcycles and large vehicles, impaired and distracted driving, crashes, following distance and railroad crossings, signs, signals and road markings, traffic laws including speed, right-of-way, school buses and insurance, driving conditions and emergencies, freeway driving and interchanges, and vehicle equipment and maintenance. ALEA\'s own manual does not publish an official item count, passing score, or time limit for the knowledge test -- it states only that the test draws questions on Alabama traffic laws, road signs, and rules of safe driving from the manual. Five independent third-party DMV test-prep sites consistently and independently report a 30-question test with an 80% (24/30) passing score, so this practice exam is built to that well-corroborated -- though not ALEA-confirmed -- format, and left untimed to match the manual\'s own silence on a time limit.',
    breakdown: [['Licensing & Graduated Driver License','16%'],['Losing Your License & Point System','9%'],['The Driving Task: Turns & Parking','8%'],['Sharing the Road: Bicycles, Motorcycles & Large Vehicles','9%'],['Impaired & Distracted Driving','9%'],['Crashes, Following Distance & Railroad Crossings','7%'],['Signs, Signals & Road Markings','12%'],['Traffic Laws: Speed, Right-of-Way, School Buses & Insurance','11%'],['Driving Conditions & Emergencies','8%'],['Freeway Driving & Interchanges','5%'],['Vehicle Equipment & Maintenance','6%']],
  },
  {
    examType: 'ak_driver',
    title: 'Alaska Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ak',
    duration: '25 Minutes', questions: '20 Multiple Choice (274-Question Practice Pool)', passScore: '16/20 Correct (80%)',
    description: 'Practice questions covering the Alaska Driver Manual (REV.10/2025, Alaska Department of Administration, Division of Motor Vehicles): licensing, permits and the seven license classes, Graduated Driver Licensing, exams and testing, points, suspensions and revocations, alcohol, drugs and DUI/implied-consent law, seatbelts and child restraints, distracted driving and speed laws, right-of-way and intersections, passing, traffic signs, signals and pavement markings, railroad crossings, sharing the road with pedestrians, bicycles, motorcycles and large trucks, parking, night driving and weather -- including Alaska-specific moose, caribou and bear collision guidance and winter road conditions -- skids, emergencies and required equipment, and insurance, crash reporting and emergency vehicles. Exam mechanics are confirmed directly from the Alaska DMV\'s own Sample Knowledge Test page, which states verbatim that the General Knowledge Test allows 25 minutes, contains 20 questions, and requires 16 correct answers to pass.',
    breakdown: [['Licensing, Permits, GDL & Testing','18%'],['Points, Suspensions, DUI & Implied Consent','14%'],['Seatbelts, Distracted Driving & Speed','11%'],['Right-of-Way, Signs, Signals & Pavement Markings','25%'],['Railroad Crossings & Sharing the Road','11%'],['Parking, Night Driving, Weather & Equipment','15%'],['Insurance, Crash Reporting & Emergency Vehicles','6%']],
  },
  {
    examType: 'az_driver',
    title: 'Arizona Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/az',
    duration: 'Untimed', questions: 'Default: 40 Multiple Choice (No Official Item Count Published -- ADOT\'s Written and Verbal Tests Page Blocks Automated Access, Persistent 403) -- 265-Question Practice Pool', passScore: '80% (Confirmed -- ADOT Practice Tests Page)',
    description: 'Practice questions covering the Arizona Driver License Manual and Customer Service Guide: licensing and Graduated Driver License rules, vehicle equipment and insurance requirements, seatbelt and child-restraint law, traffic signals, signs, pavement markings and lane use, right-of-way at intersections, speed and following distance, parking, freeway and HOV driving, sharing the road with bicycles, motorcycles, trucks, school buses and light rail, distracted driving and wireless-device law, DUI and alcohol/drug law, weather and mechanical emergency procedures, crash reporting, license suspension and revocation, and law-enforcement stop procedures -- grounded in the official manual published by the Arizona Department of Transportation Motor Vehicle Division.',
    breakdown: [['Licensing & Graduated Driver License','11%'],['Vehicle Equipment, Insurance & Seatbelt/Child Restraint','10%'],['Traffic Signals, Signs, Pavement Markings & Lane Use','14%'],['Right-of-Way, Intersections, Speed & Following Distance','12%'],['Parking & Freeway Driving','9%'],['Sharing the Road & Distracted Driving','12%'],['DUI, Alcohol & Drugs','7%'],['Weather, Mechanical Emergencies & Crash Reporting','15%'],['License Suspension/Revocation & Law Enforcement Stops','10%']],
  },
  {
    examType: 'ar_driver',
    title: 'Arkansas Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ar',
    duration: 'Untimed (No Official Time Limit Published by Arkansas DPS)', questions: 'Default: 40 Multiple Choice (No Official Count, Passing Score, or Time Limit Published by Arkansas DPS) -- 233-Question Practice Pool', passScore: '80% (Self-Study Benchmark -- No Official Threshold Published)',
    description: 'Practice questions covering the Arkansas Driver License Study Guide (Volume 1, Edition 10, published by the Arkansas State Police / Department of Finance and Administration): the Graduated Driver License program and licensing procedures, seat belts and child passenger safety, littering, move-over and school bus law, traffic signals, signs and pavement markings, railroad crossings, work zones, lanes and right-of-way (including roundabouts), parking, distracted driving and other safe-driving practices, speed and following distance, sharing the road with trucks, bicycles and motorcycles, driving fitness and health, alcohol and drug law, emergencies and crash procedures, and vehicle equipment, lighting and inspection standards. Despite extensive research across the full handbook, the official DPS driver-examination page, the ASP \'Driver Knowledge Testing 1-2-3 Checklist\' documents, the Graduated Driver License page, and the governing statute (A.C.A. 27-16-802), Arkansas does not appear to publicly publish the real knowledge test\'s item count, passing score, or time limit -- this 233-question bank and 80% self-study benchmark are sized to the handbook\'s real content depth, not confirmed Arkansas DPS figures.',
    breakdown: [['Driver Licensing & Graduated Driver License Program','12%'],['Speed, Following Distance & the Safety Cushion','8%'],['Vehicle Equipment, Lighting & Inspection','8%'],['Littering, Move Over Law & School Bus Rules','8%'],['Safe Driving Practices & Distracted Driving','8%'],['Sharing the Road: Trucks, Bicycles & Motorcycles','7%'],['Emergencies & Crash Procedures','7%'],['Lanes, Right-of-Way & Roundabouts','6%'],['Alcohol, Drugs & DUI Laws','6%'],['Traffic Signals, Signs & Pavement Markings','6%'],['Parking Rules','6%'],['Work Zone Safety','5%'],['Driving Fitness & Health','5%'],['Seat Belts & Child Passenger Safety','4%'],['Railroad Crossings','4%']],
  },
  {
    examType: 'co_driver',
    title: 'Colorado Driving Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/co',
    duration: '60 Minutes', questions: 'Default: 40 Multiple Choice (No Official Item Count Published -- Not Disclosed by the Colorado DMV or Its @Home Testing Vendor) -- 320-Question Practice Pool', passScore: '80% (Self-Study Benchmark -- No Official Passing Score Published by the Colorado DMV)',
    description: 'Practice questions covering the Colorado Driver Handbook (DR 2337): basic vehicle control, fitness to drive and vehicle readiness, the licensing process and the knowledge/drive tests, traffic signs, signals, pavement markings and lane controls, right-of-way, turning and parking, speed and stopping distance, seat belt and child-restraint law, freeway driving, lane changes and passing, bicyclists and pedestrians, sharing the road with motorcycles, trucks and buses, railroad crossings and light rail, minor drivers and Graduated Driver Licensing rules, distracted, careless, reckless and aggressive driving, DUI/DWAI and impaired driving, construction zones, traffic stops and safe-driving habits, weather, night, mountain and rural driving, emergencies and crash procedures, and how you can lose your license -- grounded in the official handbook published by the Colorado Division of Motor Vehicles. The real Colorado DMV Driving Knowledge Test (also called the Class D Knowledge Test) is timed at 60 minutes, confirmed by both the DMV\'s own FAQ page and the DMV\'s official @Home online testing vendor -- but Colorado does not publicly publish a fixed item count or a numeric passing-score percentage for the test anywhere in official sources, so the 40-question default session and 80% passing score used here are our own self-study benchmarks, not confirmed Colorado figures.',
    breakdown: [['Traffic Signs, Signals, Pavement Markings & Lane Controls','12%'],['Right-of-Way, Turning, Parking & Basic Vehicle Control','15%'],['DUI, DWAI, Distracted, Careless, Reckless & Aggressive Driving','12%'],['Freeway Driving, Weather, Mountain & Rural Conditions','12%'],['Minor Drivers, GDL, Licensing Process & Losing Your License','13%'],['Emergencies, Crash Procedures, Construction Zones & Railroad/Light Rail','18%'],['Bicyclists, Pedestrians & Sharing the Road','10%'],['Seat Belt, Child Restraint, Speed & Stopping Distance','8%']],
  },
  {
    examType: 'ct_driver',
    title: 'Connecticut Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ct',
    duration: 'Untimed', questions: '25 Multiple Choice (267-Question Practice Pool)', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the Connecticut Driver\'s Manual (Connecticut Department of Motor Vehicles, Revised March 2023): licensing, testing and Graduated Driver Licensing (GDL) requirements, vehicle equipment, seatbelt, child-restraint and insurance laws, sharing the road with pedestrians, bicyclists, motorcycles and other vulnerable users, sharing the road with trucks and maintaining a safe space cushion, speed, right-of-way, parking, lights and signals, DUI, alcohol law and teen suspension penalties, driving techniques, intersections and work zones, aggressive driving, distraction and fatigue, vehicle emergencies, collision avoidance and crash response, and traffic signs, signals and pavement markings -- for the 25-question knowledge test administered by the Connecticut DMV, which requires 20 correct answers (80%) to pass, confirmed directly from both the manual\'s own text and the DMV\'s official Knowledge and Vision Test page.',
    breakdown: [['Traffic Signs, Signals & Pavement Markings','17%'],['Licensing, Testing & GDL Requirements','14%'],['Vehicle Equipment, Seatbelt & Insurance Laws','11%'],['Sharing the Road: Pedestrians, Bicyclists, Motorcycles & Others','10%'],['Sharing the Road with Trucks & Maintaining Space','10%'],['Speed, Right-of-Way, Parking, Lights & Signals','9%'],['DUI, Alcohol Law & Teen Suspension Penalties','8%'],['Driving Techniques, Intersections & Work Zones','7%'],['Aggressive Driving, Distraction & Fatigue','7%'],['Vehicle Emergencies, Collision Avoidance & Crash Response','7%']],
  },
  {
    examType: 'de_driver',
    title: 'Delaware Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/de',
    duration: 'Untimed', questions: '30 Multiple Choice (251-Question Practice Pool)', passScore: '24/30 Correct (80%)',
    description: 'Practice questions covering the Delaware Driver Manual (Delaware Division of Motor Vehicles): licensing requirements and the Graduated Driver License program, suspension/revocation and the point system, impaired driving and DUI laws, vehicle equipment/registration/insurance, traffic signs/signals/pavement markings, right-of-way/traffic control/school buses, parking/speed limits/work zones, sharing the road with pedestrians/bicycles/motorcycles/trucks, driving skills/space management/seatbelt laws, and emergencies/collisions/distracted driving -- grounded in the current Delaware Driver Manual, for the DMV\'s official 30-question knowledge test.',
    breakdown: [['Licensing Requirements & Graduated Driver License','17%'],['Suspension, Revocation, the Point System & Impaired Driving (DUI) Laws','20%'],['Vehicle Equipment, Registration & Insurance','8%'],['Traffic Signs, Signals, Pavement Markings, Right-of-Way & School Buses','18%'],['Parking, Speed Limits, Work Zones & Sharing the Road','17%'],['Driving Skills, Space Management, Seatbelt Laws & Emergencies','20%']],
  },
  {
    examType: 'hi_driver',
    title: 'Hawaii Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/hi',
    duration: '60 Minutes (Online Version)', questions: '30 Multiple Choice (267-Question Practice Pool)', passScore: '80% (Self-Study Benchmark -- No Official Threshold Published)',
    description: 'Practice questions covering the Hawaii Driver\'s Manual (State of Hawaii Department of Transportation, Highways Division): licensing requirements and the graduated driver licensing (GDL) program, traffic signs/signals/pavement markings, right-of-way and intersections, speed/following distance/passing zones, alcohol/drugs and impaired driving, seat belts and child restraints, insurance/crashes and financial responsibility, distracted and defensive driving, sharing the road with pedestrians/bicyclists/motorcyclists, school buses and work zones, parking rules, vehicle equipment/inspection/registration, and emergency driving procedures covering skids, blowouts, brake/steering failure, freeway driving and weather. Hawaii driver licensing is unusual among states in that it is administered locally by four separate County Driver Licensing offices -- Honolulu, Hawaii, Kauai, and Maui -- rather than a single statewide DMV, but all four counties share this one statewide manual and a common online testing platform. The real Category 3 (car) written knowledge test is confirmed to be 30 multiple-choice questions -- verified independently across three official honolulu.gov pages plus the shared statewide testing vendor page -- and the online version of the test carries a 60-minute time limit; the passing score is not published on any official county or state source found after real research effort, so the 80% threshold used here is our own self-study benchmark, not a confirmed county figure. This 267-question bank is a much larger practice pool built for thorough self-study, not a simulation of the exact 30-question test length.',
    breakdown: [['Licensing Requirements & GDL','13%'],['Traffic Signs, Signals & Pavement Markings','12%'],['Right-of-Way & Intersections','8%'],['Speed, Following Distance & No-Passing Zones','6%'],['Alcohol, Drugs & Impaired Driving','7%'],['Seat Belts & Child Restraints','5%'],['Insurance, Crashes & Financial Responsibility','5%'],['Distracted & Defensive Driving','6%'],['Sharing the Road: Pedestrians, Bicyclists & Motorcyclists','10%'],['School Buses & Work Zones','4%'],['Parking Rules','4%'],['Vehicle Equipment, Inspection & Registration','6%'],['Emergency Procedures, Weather & Freeway Driving','14%']],
  },
  {
    examType: 'id_driver',
    title: 'Idaho Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/id',
    duration: 'Untimed', questions: '40 Multiple Choice (261-Question Practice Pool)', passScore: '34/40 Correct (85%)',
    description: 'Practice questions covering the Idaho Driver\'s Handbook: licensing, permits, credentials and the graduated driver\'s license (GDL) program, required knowledge and skills testing, vehicle equipment and safety, traffic signs, signals and pavement markings, intersections and right-of-way, speed limits, stopping and following distance, turns, passing, parking and freeway driving, distracted, fatigued and defensive driving, sharing the road, weather, night and emergency driving, crashes, insurance and the law, DUI, drugs and alcohol, and license suspension, points and GDL penalties -- for the Idaho Transportation Department\'s Class D (non-commercial) knowledge test.',
    breakdown: [['Licensing, Permits, Testing & Credentials','24%'],['Traffic Signs, Signals & Pavement Markings','11%'],['Intersections, Speed, Turns & Freeway Driving','20%'],['Vehicle Equipment, Sharing the Road & Weather/Defensive Driving','29%'],['Crashes, Insurance, DUI & License Suspension/Points','16%']],
  },
  {
    examType: 'in_driver',
    title: 'Indiana Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/in',
    duration: 'Untimed', questions: 'Default: 40 Multiple Choice (No Official Item Count Published -- Indiana BMV Does Not State a Total Item Count or Time Limit) -- 308-Question Practice Pool', passScore: '80% on Each of 2 Components (Signs + Traffic Rules)',
    description: 'Practice questions covering the Indiana Driver\'s Manual, published by the Indiana Bureau of Motor Vehicles (BMV): licensing, permits and the knowledge/skills exam process; the Graduated Driver License (GDL) system and teen driving rules; restrictions and endorsements, including motorcycle, motor-driven cycle, autocycle and for-hire; points, suspensions, insurance and Habitual Traffic Violator rules; DUI and impaired driving; traffic signs, signals and intersections; speed limits, following distance, lane usage, turning and passing; weather, night driving and vehicle control; distracted, drowsy and aggressive driving; work zones and railroad crossings; sharing the road with trucks, motorcycles, bicycles, pedestrians and school buses; parking and reversing; seat belts and child safety; vehicle equipment; and accidents and emergencies -- grounded in the current BMV manual.',
    breakdown: [['Licensing, Permits, GDL & Restrictions/Endorsements','21%'],['Traffic Signs, Signals & Intersections','16%'],['Rules of the Road: Speed, Lanes, Turning & Parking','14%'],['Sharing the Road, Work Zones & Railroad Crossings','13%'],['Weather, Night Driving, Vehicle Control & Equipment','10%'],['Points, Suspensions, Insurance & HTV','9%'],['Seat Belts, Child Safety, Accidents & Emergencies','9%'],['Impaired, Distracted & Unsafe Driving','8%']],
  },
  {
    examType: 'ia_driver',
    title: 'Iowa Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ia',
    duration: 'Untimed', questions: 'Default: 40 Multiple Choice (No Official Item Count Published -- Iowa DOT\'s Only Published Number (25) Is the Separate Online Practice Test, Not the Real Exam) -- 245-Question Practice Pool', passScore: '80% (Confirmed by Iowa DOT)',
    description: 'Practice questions covering the Iowa Driver\'s License Manual, published by the Iowa Department of Transportation: licensing requirements and the Graduated Driver\'s License (GDL) program for minors, traffic signs, signals and pavement markings, right-of-way and modern intersections (including roundabouts, reduced-conflict intersections and diverging diamonds), school buses and emergency vehicles, speed limits and stopping-distance tables, alcohol/drugs and Iowa\'s OWI and implied-consent law, seat belts, child restraints and Iowa\'s hands-free distracted-driving law, vehicle equipment and Iowa\'s ADAS/vehicle-technology rules, basic driving skills, sharing the road with trucks, motorcycles, bicycles and pedestrians, parking and work zones, and severe weather, emergencies and crash reporting -- grounded in the official manual published by the Iowa Department of Transportation.',
    breakdown: [['Licensing Requirements & GDL','11%'],['Traffic Signs, Signals & Markings','13%'],['Right-of-Way & Intersections','9%'],['School Buses & Emergency Vehicles','7%'],['Speed Limits & Following Distance','7%'],['Alcohol, Drugs & Impaired Driving','6%'],['Seat Belts, Child Restraints & Distracted Driving','8%'],['Vehicle Equipment, Maintenance & ADAS','8%'],['Basic Driving Skills','9%'],['Sharing the Road','7%'],['Parking & Work Zones','6%'],['Weather, Emergencies & Crashes','9%']],
  },
  {
    examType: 'ks_driver',
    title: 'Kansas Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ks',
    duration: 'Untimed (Typically 15-20 Minutes)', questions: '25 Multiple Choice (268-Question Practice Pool)', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the Kansas Driving Handbook (Non-Commercial Driver\'s Manual), published by the Kansas Department of Revenue, Division of Vehicles: licensing, permits and Graduated Driver\'s License (GDL) requirements, fitness to drive and impairment, speed limits, seatbelts and general traffic laws, basic vehicle control and steering, right-of-way and traffic signals, the full catalog of road signs and pavement markings, school bus and parking law, speed and space management with stopping-distance figures, collision avoidance and emergency procedures, sharing the road with pedestrians, bicyclists and motorcyclists, emergency/commercial/slow-moving vehicles, special driving situations, and the pre-trip vehicle safety inspection -- grounded in the current Kansas Driving Handbook (AAMVA 09 Model Test format), for the Division of Vehicles\' official 25-question knowledge test.',
    breakdown: [['Traffic Laws, Right-of-Way, Signs & Pavement Markings','24%'],['Collision Avoidance, Emergencies & Special Situations','19%'],['Vehicle Control, Speed & Space Management','17%'],['Licensing, Permits, GDL & Fitness to Drive','16%'],['Sharing the Road, School Buses & Parking','13%'],['Vehicle Safety Equipment & Pre-Trip Inspection','11%']],
  },
  {
    examType: 'ky_driver',
    title: 'Kentucky Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ky',
    duration: 'Untimed', questions: 'Default: 40 Multiple Choice (Total Item Count Not Officially Published by KSP) -- 271-Question Practice Pool', passScore: '80% (Confirmed by Kentucky State Police Manual)',
    description: 'Practice questions covering the Kentucky Driver Manual (Kentucky State Police, rev. 10-11-2023): licensing requirements and the three-phase Graduated Driver License program for applicants under 18, signs, signals and pavement markings, right-of-way and intersections, speed and following distance, DUI, alcohol and drug laws, seat belts, airbags and child restraints, insurance and vehicle registration, distracted driving and driver fitness, sharing the road with pedestrians, bicyclists, motorcyclists and commercial vehicles, police stops, school buses, work zones and railroad crossings, parking, special driving situations, emergencies, collisions and vehicle malfunctions, and noncitizen licensing, medical review and CDL basics -- for the written knowledge test administered at Kentucky State Police posts. The manual states directly that a minimum score of 80% is required to pass; KSP does not publish the total number of questions on the real test or whether it is timed.',
    breakdown: [['Licensing, Graduated Driver License, Noncitizens & CDL Basics','19%'],['Sharing the Road: Pedestrians, Bicyclists, Motorcycles & Commercial Vehicles','12%'],['Right-of-Way, Intersections, Lanes, Turns & Passing','11%'],['Signs, Signals & Pavement Markings','10%'],['Safety Equipment, Restraints & Vehicle Technology','9%'],['Special Situations, Emergencies, Collisions & Malfunctions','9%'],['Speed, Following Distance & Parking','8%'],['Insurance & Vehicle Registration','6%'],['Police Stops, School Buses, Work Zones & Railroad Crossings','6%'],['DUI, Alcohol & Drug Laws','5%'],['Distracted Driving & Driver Fitness','5%']],
  },
  {
    examType: 'la_driver',
    title: 'Louisiana Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/la',
    duration: 'Untimed', questions: '40 Multiple Choice (272-Question Practice Pool)', passScore: '32/40 Correct (80%)',
    description: 'Practice questions covering the Louisiana Class D & E Driver\'s Guide: licensing requirements and the graduated driver license process, traffic signs, signals, pavement markings and right-of-way, DUI, alcohol and drug awareness, speed, following distance and hazardous driving conditions, sharing the road with bicycles, motorcycles, trucks, pedestrians, school buses and railroad crossings, safety belts, child restraints, distracted driving and vehicle equipment, and parking rules, general traffic laws and defensive driving -- for the 40-question, computer-administered knowledge test given by the Louisiana Office of Motor Vehicles.',
    breakdown: [['Signs, Signals, Markings & Right-of-Way','17%'],['Sharing the Road & Special Situations','19%'],['Licensing Requirements & Graduated Driver License','15%'],['Speed, Space Cushion & Hazardous Conditions','15%'],['Parking, General Traffic Laws & Defensive Driving','14%'],['Safety Belts, Distracted Driving & Vehicle Equipment','12%'],['DUI, Alcohol & Drugs','8%']],
  },
  {
    examType: 'me_driver',
    title: 'Maine Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/me',
    duration: 'Untimed', questions: '30 Multiple Choice (283-Question Practice Pool)', passScore: '24/30 Correct (80%) -- Confirmed, Official BMV Page',
    description: 'Practice questions covering the Maine Driver\'s License Manual (Maine Secretary of State / Bureau of Motor Vehicles, Rev. 4/24 edition): licensing and the graduated license process, state laws covering vehicle registration, insurance and inspection, fitness to drive including fatigue and distraction, alcohol/drug/OUI law with specific BAC thresholds and suspension periods, seatbelt and child safety law, vehicle operation basics, right-of-way rules and traffic signs/signals, general driving including passing, parking and school buses, speed and space management with stopping-distance guidance, avoiding crashes and emergency procedures, sharing the road with pedestrians, bicyclists, motorcyclists and large vehicles, and special driving challenges including Maine-specific moose and deer collision guidance. The real BMV knowledge test is confirmed at 30 questions with a minimum of 24 correct required to pass (80%), per the official BMV \'Drivers License Exam\' page; that page does not state a time limit for the written test, and none was found on any other official BMV page reviewed, so this practice exam is left untimed to match.',
    breakdown: [['Licensing & GDL','15%'],['Registration, Insurance & Inspection','7%'],['Fitness to Drive','4%'],['Alcohol, Drugs & OUI','10%'],['Seatbelts & Child Safety','4%'],['Vehicle Operation Basics','4%'],['Right-of-Way & Traffic Control','11%'],['General Driving','10%'],['Speed & Space Management','10%'],['Avoiding Crashes & Emergencies','9%'],['Sharing the Road','8%'],['Special Driving Challenges','8%']],
  },
  {
    examType: 'md_driver',
    title: 'Maryland Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/md',
    duration: '20 Minutes', questions: '25 Multiple Choice (253-Question Practice Pool)', passScore: '22/25 Correct (88%)',
    description: 'Practice questions covering the Maryland MVA Driver\'s Manual (DL-002): licensing requirements and the Graduated Driver Licensing (GDL) system, right-of-way and speed, following distance, lane use, passing and parking, signs, signals and pavement markings, driving situations and conditions, dangerous driving behaviors, sharing the road with pedestrians, emergency vehicles and trucks, motorcycles, bicycles, mopeds and ADAS, crashes and traffic stops, GDL restrictions, violations and penalties, and medical, insurance, seat belt and equipment rules -- grounded in Maryland\'s unusually strict 88% passing score (22 of 25 correct), confirmed directly from the manual and two independent MVA test-prep pages.',
    breakdown: [['Licensing Requirements & GDL','13%'],['Driving Situations & Conditions','12%'],['Signs, Signals & Pavement Markings','10%'],['Following, Lanes, Passing & Parking','8%'],['Motorcycles, Bicycles, Mopeds & ADAS','8%'],['Medical, Insurance, Seat Belts & Equipment','8%'],['Right-of-Way & Speed','7%'],['Dangerous Driving Behaviors','7%'],['Crashes & Traffic Stops','7%'],['GDL Restrictions, Violations & Penalties','7%'],['Parking Maneuvers & Bicycle Equipment','7%'],['Sharing the Road: Pedestrians, Emergency Vehicles & Trucks','6%']],
  },
  {
    examType: 'ma_driver',
    title: 'Massachusetts Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ma',
    duration: '25 Minutes', questions: '25 Multiple Choice (313-Question Practice Pool)', passScore: '18/25 Correct (72%)',
    description: 'Practice questions covering the Massachusetts RMV Driver\'s Manual (Revised December 2022): licensing and the Junior Operator (GDL) law, learner\'s permit and road test procedures, violations, points and license suspension, OUI/alcohol and drug law, seatbelt and child passenger safety, the state\'s hands-free/distracted-driving law, defensive driving and stopping distances, speed limits, traffic signals including Massachusetts-specific devices like Pedestrian Hybrid Beacons and Rectangular Rapid Flashing Beacons, traffic signs and railroad crossings, work zones, pavement markings and bicycle infrastructure, lanes, intersections and turns, right-of-way including Massachusetts rotaries and roundabouts, passing rules, pedestrians and school buses, bicycles, mopeds and scooters, sharing the road with motorcycles and trucks, parking rules, emergency vehicles and police-stop guidance, driving emergencies and crash reporting, and vehicle equipment, registration and insurance basics -- grounded in the RMV\'s own stated exam format: 25 multiple-choice questions, 18 correct required to pass (72%), within a 25-minute time limit.',
    breakdown: [['Licensing, Junior Operator (GDL) Law & Learner\'s Permit Testing','15%'],['Traffic Signals, Signs, Railroad Crossings & Pavement Markings','13%'],['Sharing the Road: Pedestrians, Bicycles & Motorcycles/Trucks','13%'],['Emergency Vehicles, Crash Procedures & Vehicle Equipment','12%'],['Violations, Points, Suspensions & OUI/Alcohol Law','11%'],['Defensive Driving, Speed & Night/Weather Conditions','11%'],['Lanes, Intersections, Right-of-Way & Passing','11%'],['Seatbelt/Child Passenger Safety & Distracted Driving','7%'],['Work Zones & Parking Rules','7%']],
  },
  {
    examType: 'mn_driver',
    title: 'Minnesota Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/mn',
    duration: 'Untimed', questions: 'Default: 40 Multiple Choice (Exact Item Count Not Published by DVS) -- 268-Question Practice Pool', passScore: '80% (Confirmed by Minnesota DVS Manual)',
    description: 'Practice questions covering the Minnesota Driver\'s Manual (Department of Public Safety, Driver and Vehicle Services): licensing, the written test and Graduated Driver Licensing (GDL) requirements; vehicle equipment; traffic laws, speed limits, lanes, turns and passing; sharing the road with pedestrians, bicyclists, motorcyclists and commercial vehicles; signs, signals and pavement markings; right-of-way, emergency vehicles and traffic stops; railroad crossings and work zones; school bus safety; parking and backing; distracted and aggressive driving; seatbelts, crashes and insurance; winter weather and other emergencies; SIPDE, following distance, night and freeway driving; driving privileges, suspension and revocation; and DUI, alcohol and drugs. The manual confirms you must score 80 percent to pass the written test (\'You may take only one written test per day and must score 80 percent to pass\'), delivered as multiple-choice and true-or-false questions on paper or computer -- but it does not publish the exact number of questions on the real test or any time limit, so this 268-question bank is offered as a large self-study practice pool with an untimed default session.',
    breakdown: [['Licensing, Written Test & GDL Requirements','12%'],['Signs, Signals & Pavement Markings','11%'],['DUI, Alcohol & Drugs','9%'],['Speed Limits, Lanes, Turns & Passing','8%'],['Winter Weather & Emergencies','8%'],['Seatbelts, Crashes & Insurance','6%'],['SIPDE, Following, Night & Freeway Driving','6%'],['Right-of-Way, Emergency Vehicles & Traffic Stops','5%'],['Pedestrians & Bicyclists','5%'],['Motorcyclists & Commercial Vehicles','5%'],['Vehicle Equipment','5%'],['Parking & Backing','4%'],['Distracted & Aggressive Driving','4%'],['School Bus Safety','4%'],['Driving Privileges','4%'],['Railroad Crossings & Work Zones','4%']],
  },
  {
    examType: 'ms_driver',
    title: 'Mississippi Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ms',
    duration: 'Untimed', questions: 'Default: 40 Multiple Choice (No Official Count, Passing Score, or Time Limit Published) -- 291-Question Practice Pool', passScore: '80% (Self-Study Benchmark -- No Official Threshold Published)',
    description: 'Practice questions covering the Mississippi Driver\'s License Manual (Revised December 2024 / effective January 15, 2025), published by the Driver Service Bureau, Mississippi Department of Public Safety: licensing and the Graduated Driver License / Learner\'s Permit process (minimum age 15), vehicle equipment, documentation and the Squatted Vehicle Law, pavement markings and lane use, traffic signs, traffic signals and railroad crossings, speed, following distance and braking, right-of-way and intersections, turning, lane changes and parking, school buses, pedestrians and bicycles, night driving, seat belts and child restraints, DUI, alcohol and drugs, insurance and financial responsibility, license suspension, revocation and reinstatement, hazardous conditions and accidents, emergency vehicles and traffic stops, interstate driving and large vehicles, distracted driving, general safe-driving basics, and organ donation/littering law. Mississippi calls its knowledge test the \'Computerized Exam,\' administered in person only (no cell phones, earbuds, or smartwatches allowed in the testing area). After thorough research across the fetched 91-page manual and multiple official driverservicebureau.dps.ms.gov pages (Learner\'s Permit, Driver\'s Permit, Road Test, Classes A-D, and the FAQ index), no official question count, passing score, or time limit for the Computerized Exam is published anywhere -- so this practice exam defaults to a 40-question, 80%-to-pass, untimed format as a self-study benchmark, not a confirmed Driver Service Bureau figure. This 291-question bank draws only from the standard Class R knowledge test material; the manual\'s own CDL section confirms commercial driving content is tested separately under the distinct \'Mississippi Professional Driver\'s Manual,\' so CDL/commercial questions are deliberately excluded.',
    breakdown: [['Licensing, GDL & the Exam','15%'],['Vehicle Equipment & Documentation','5%'],['Traffic Signs, Signals, Railroad Crossings & Pavement Markings','22%'],['Speed, Following Distance & Right-of-Way','9%'],['Turning, Lane Changes & Parking','9%'],['School Buses, Pedestrians & Bicycles','6%'],['Night Driving, Seat Belts & Child Restraints','5%'],['DUI, Alcohol & Drugs','6%'],['Insurance, License Suspension & Revocation','7%'],['Hazardous Conditions, Accidents & Emergency Vehicles','6%'],['Interstate Driving, Large Vehicles & Distracted Driving','6%'],['Safe Driving Basics, Organ Donation & Litter','4%']],
  },
  {
    examType: 'mo_driver',
    title: 'Missouri Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/mo',
    duration: 'Untimed', questions: '25 Multiple Choice (279-Question Practice Pool)', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the official Missouri Driver Guide (Missouri Department of Revenue, Driver License Bureau, revised August 2025): licensing, permits and the Graduated Driver License program, the four-part driver examination, rules of the road (right-of-way, intersections, roundabouts, J-turns and school buses), sharing the road with motorcycles, large trucks, pedestrians, bicycles, mopeds and e-bikes, parking, highway driving (entrance/exit ramps, diverging diamond interchanges and highway hypnosis), pavement markings, signs and signals -- including Missouri\'s speed-limit table by roadway type -- everyday and special-condition safe driving (seat belts, child restraints, following/stopping distance, night, winter and wet-weather driving, skids and ABS), alcohol, drugs and DWI law, the point system, vehicle titling and registration, mandatory insurance minimums, safety/emissions inspections and required equipment, and distracted driving/electronic device law -- for the Class F (standard operator) written knowledge test. The guide itself confirms, identically on p.1 and again in Chapter 2, \'The Driver Examination\' (p.18): a 25-question multiple-choice written test requiring 20 correct answers (80%) to pass, and states no time limit for the written test anywhere in its text. The guide also explicitly excludes Chapter 15 (Commercial Vehicles) from the Class F written test -- \'You will not be tested on the information on commercial vehicles in Chapter 15\' -- so that content is correctly excluded from this practice pool.',
    breakdown: [['Signs, Signals & Pavement Markings','14%'],['Safe Driving Tips & Special Conditions','14%'],['Alcohol, Drugs & the Point System','12%'],['Titling, Registration & Insurance','9%'],['Licensing & Permits','8%'],['Highway Driving & Parking','8%'],['Rules of the Road','7%'],['Sharing the Road','7%'],['Graduated Driver License (GDL)','6%'],['Inspections & Required Equipment','6%'],['The Driver Examination','5%'],['Distracted Driving','4%']],
  },
  {
    examType: 'mt_driver',
    title: 'Montana Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/mt',
    duration: 'Untimed (No Official Time Limit Published by Montana MVD)', questions: 'Default: 40 Multiple Choice (No Official Count, Passing Score, or Time Limit Published by Montana MVD) -- 269-Question Practice Pool', passScore: '80% (Self-Study Benchmark -- No Official Threshold Published)',
    description: 'Practice questions covering the Montana Driver Manual (Form 25-0100M), published by the Montana Department of Justice, Motor Vehicle Division (MVD): licensing and the Graduated Driver License (GDL) program, testing and documentation, vehicle equipment and lighting, safety belts and child restraints, traffic signs, signals and pavement markings, railroad crossings, intersections and right-of-way, pedestrians and crosswalks, school buses and school zones, speed limits, passing and turning, parking rules, sharing the road with bicyclists and animals, roundabouts and funeral processions (both governed by right-of-way rules unique to Montana), insurance requirements, distracted driving, space cushion and following distance, adjusting speed for weather conditions, DUI/alcohol/drug law, health, fatigue and senior drivers, emergencies, crashes and enforcement stops, penalties and driving records, and other MVD services. Montana\'s official Motor Vehicle Division site recently moved from dojmt.gov to mvdmt.gov (both are official Montana government domains; mvdmt.gov is the current live site). After a full read of the current manual plus a review of Montana Code Annotated 61-5-111, the MVD\'s official FAQ page, and the New Driver License page, Montana does not appear to publicly publish the knowledge test\'s item count, passing score, or time limit anywhere -- so the 40-question, 80%-to-pass, untimed format used here is our own self-study default, not a confirmed MVD figure. One real mechanic the manual does document: a driver license receipt is valid for one year and allows three attempts within that year to pass all required exams. This 269-question bank draws on an unusually detailed manual -- exact GDL age/hour/passenger thresholds, precise equipment visibility distances, BAC thresholds and DUI penalties, insurance minimums, and Montana-specific roundabout and funeral-procession right-of-way rules -- for thorough self-study, not a simulation of any confirmed test length.',
    breakdown: [['Licensing, GDL & Testing Documentation','12%'],['Vehicle Equipment, Lighting & Safety Restraints','11%'],['Traffic Signs, Signals & Pavement Markings','14%'],['Railroad Crossings, Intersections & Right-of-Way','7%'],['Pedestrians, School Zones, Speed, Passing & Parking','14%'],['Sharing the Road, Roundabouts, Funeral Processions & Insurance','11%'],['Distracted Driving, Space Cushion, Weather & DUI','17%'],['Health, Emergencies, Penalties & Other Services','14%']],
  },
  {
    examType: 'ne_driver',
    title: 'Nebraska Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ne',
    duration: 'Untimed', questions: 'Default: 40 Multiple Choice (No Official Count, Passing Score, or Time Limit Published) -- 252-Question Practice Pool', passScore: '80% (Self-Study Benchmark -- No Official Threshold Published)',
    description: 'Practice questions covering the Nebraska Class O Driver\'s Manual (Nebraska Department of Motor Vehicles, English edition 1-2025): licensing and the Graduated Driver Licensing (GDL) process across every permit stage, Nebraska\'s point system and license suspensions/revocations, alcohol, drugs and impaired-driving law (implied consent and BAC-impairment thresholds), vehicle safety, equipment, insurance and child-restraint requirements, traffic signs and signals, pavement markings, right-of-way, speed limits and passing rules, turning, parking and railroad-crossing procedures, special driving conditions, distracted and defensive driving, and sharing the road plus crash/accident procedures. The manual states that over 32% of first-time applicants fail the written test, underscoring how closely its rules-based content is tested, but the Nebraska DMV does not publish an official item count, passing score, or time limit for the real knowledge test anywhere in the manual, its FAQ-style pages, the learner\'s permit/operator\'s license pages, its online practice-test tool, or Nebraska Revised Statutes Chapter 60 -- so this practice exam defaults to a 40-question, 80%-to-pass, untimed format as a self-study benchmark, not a confirmed DMV figure. The manual\'s own back-of-manual practice exam (39 items, contributed by AAA Nebraska/Cornhusker Motor Club Foundation) explicitly uses different questions than the real test and is not presented as a stand-in for the actual item count or passing threshold, so it was not used to set these defaults either. This 252-question bank draws from the manual\'s substantive driving-rules content (Sections 1-7), which is unusually rich and numerically specific -- exact ages and timelines for every permit type and GDL stage, the full point-value table, precise BAC-impairment breakpoints, exact speed limits by road type, and exact distances and fines for parking, passing, move-over and railroad-crossing violations.',
    breakdown: [['Licensing & Graduated Driver Licensing (GDL)','16%'],['Point System & License Suspensions','12%'],['Alcohol, Drugs & Impaired Driving','7%'],['Vehicle Safety & Equipment','10%'],['Traffic Signs & Signals','10%'],['Pavement Markings','6%'],['Right-of-Way, Speed & Passing','10%'],['Turning, Parking & Railroad Crossings','7%'],['Special Driving Conditions','7%'],['Distracted & Defensive Driving','7%'],['Sharing the Road & Crash Procedures','8%']],
  },
  {
    examType: 'nv_driver',
    title: 'Nevada Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/nv',
    duration: 'Untimed', questions: '25 Multiple Choice (Stops Early at 20 Correct or 6 Incorrect) (275-Question Practice Pool)', passScore: '80% or Better (20 of 25 Under Standard Scoring)',
    description: 'Practice questions covering the Nevada Driver\'s Handbook (DMV 700, March 2024 edition): licensing and the Graduated Driver License (GDL)/instruction-permit process, seat belt and child-restraint law, traffic signs, signals, pavement markings and railroad crossings, right-of-way rules and speed/stopping-distance physics, freeway and HOV driving, turning, passing and parking rules, this edition\'s distinctively detailed Advanced Driver Assistance Systems (ADAS) chapter, special conditions such as night driving, weather, flash floods, work zones and the stopped-emergency-vehicle (\'Move Over\') law, sharing the road with commercial vehicles, motorcycles, mopeds, school buses, bicycles and pedestrians, towing/trailering physics, insurance and financial-responsibility law, Nevada\'s demerit-point schedule, and its DUI penalty structure. It\'s built for the real Nevada DMV Class C (non-commercial) knowledge test, which the DMV\'s own Testing page describes as an unusual early-stop format rather than a fixed-length exam: up to 25 multiple-choice questions, but the test stops the moment you reach either 20 correct answers or 6 incorrect answers, whichever comes first, with 80 percent or better (20 of 25) required to pass. No time limit is published for the real test, so it\'s untimed here as well.',
    breakdown: [['Licensing, Permits & Graduated Driver Licensing (GDL)','13%'],['Seat Belts & Child Passenger Safety','4%'],['Signs, Signals, Pavement Markings & Railroad Crossings','12%'],['Right-of-Way, Speed & Stopping Distance','9%'],['Freeway/HOV Driving, Turning, Passing & Parking','15%'],['ADAS, Special Conditions & Sharing the Road','20%'],['Towing/Trailering & Insurance (Financial Responsibility)','10%'],['Demerit Points, DUI & License Suspensions','12%'],['Testing Procedures & Miscellaneous','5%']],
  },
  {
    examType: 'nh_driver',
    title: 'New Hampshire Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/nh',
    duration: '40 Minutes', questions: '40 Multiple Choice (Auto-Ends After 8 Incorrect) (211-Question Practice Pool)', passScore: '32/40 Correct (80%, via ≤8 Incorrect Rule)',
    description: 'Practice questions covering the New Hampshire Driver Manual (DSMV 360, Rev. 07/19) -- the last full edition the DMV published on its own domain, recovered via the Internet Archive Wayback Machine after the current dmv.nh.gov site retired its state-authored manual in favor of a link to a third-party site: licensing, testing and Youth Operator "Under 20" rules; dangerous driving, distraction and impairment; vehicle preparation and safety equipment; basic driving, right-of-way and speed; roadway conditions, night driving and space management; traffic signals, signs and pavement markings; general driving, intersections and parking; accidents and financial responsibility; driving emergencies; sharing the road; and license classes, restrictions and vehicle technology. Two genuine New Hampshire quirks worth knowing before test day: the state has no mandatory auto-insurance law -- a driver may legally operate a vehicle without insurance, though remains financially responsible for any damage caused and can be required to carry an SR-22 certificate for several years after an uninsured accident or certain convictions -- and New Hampshire issues no learner\'s permit at all. Instead, state law allows an unlicensed person at least 15 1/2 years old to practice drive while accompanied by a certified driving instructor, parent, legal guardian, or another responsible licensed adult 25 or older.',
    breakdown: [['Licensing, Testing & Youth Operator Rules','14%'],['Dangerous Driving, Distraction & Impairment','11%'],['Vehicle Preparation & Safety Equipment','7%'],['Basic Driving: Right-of-Way, Speed & Signaling','9%'],['Roadway Conditions, Night Driving & Space Management','6%'],['Traffic Signals, Signs & Pavement Markings','9%'],['General Driving, Intersections & Parking','9%'],['Accidents & Financial Responsibility','4%'],['Driving Emergencies','6%'],['Sharing the Road','11%'],['License Classes, Restrictions & Vehicle Technology','9%'],['Additional Licensing & Safety Facts','5%']],
  },
  {
    examType: 'nj_driver',
    title: 'New Jersey Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/nj',
    duration: 'Untimed', questions: '50 Multiple Choice (277-Question Practice Pool)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the New Jersey MVC Driver Manual (2025 edition): license types and Graduated Driver Licensing (GDL), driver testing, driver responsibility, safe-driving and traffic rules, defensive driving, drinking/drugs and health, driver privilege and penalties (including the moving-violation point system and DUI/BAC penalty tables), sharing the road, vehicle equipment, and road signs, signals and pavement markings -- modeled directly on the real MVC knowledge test\'s 50-scored-question, 80%-to-pass format.',
    breakdown: [['Licensing & Graduated Driver Licensing (GDL)','12%'],['Driver Testing & Examination Requirements','7%'],['Driver Responsibility (Insurance, Registration & Legal Duties)','11%'],['Traffic Laws & Safe-Driving Rules','14%'],['Defensive Driving','10%'],['Drinking, Drugs & Health','9%'],['Driver Privilege, Penalties & the Point System','9%'],['Sharing the Road','10%'],['Vehicle Equipment','7%'],['Signs, Signals & Pavement Markings','11%']],
  },
  {
    examType: 'nm_driver',
    title: 'New Mexico Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/nm',
    duration: 'Untimed (No Official Time Limit Published by New Mexico MVD)', questions: 'Default: 40 Multiple Choice (No Official Count Published by New Mexico MVD) -- 349-Question Practice Pool', passScore: '70% (Confirmed -- MVD Driver Procedures Manual Ch. 11)',
    description: 'Practice questions covering the New Mexico Driver Manual (ver. 11.19.19), published by the New Mexico Motor Vehicle Division (MVD, part of the Taxation and Revenue Department): licensing, permits and Graduated Driver Licensing (GDL) requirements, seatbelt and child-restraint law, traffic signals, signs and pavement markings (including New Mexico\'s specific railroad-crossing and no-passing rules), lane controls and general driving rules, right-of-way (including the New Mexico White Cane Law, 28-7-1 NMSA 1978, and school-bus/emergency-vehicle rules), speed limits, parking rules (including New Mexico\'s specific no-parking distances and curb-color code), traffic violations and points, basic driving, scanning and headlight-use technique, sight distance and following-distance rules (the 3-second/4-second/10-second rules), communicating with other drivers, New Mexico-specific road conditions and wildlife-hazard content (deer, elk, antelope, bear and cougar by region), adjusting to traffic flow, bicycles and sharrows, sharing the road with large trucks and RVs, fitness to drive (vision, fatigue, health conditions and cell phones), DUI/DWI and drug law (including New Mexico\'s .08%/.02%-under-21 BAC thresholds and 25-year DWI record retention), vehicle emergencies and collision avoidance/skid recovery, collision protection and the Financial Responsibility Law\'s insurance minimums, and an unusually deep New Mexico motorcycle-operation section covering braking technique, lane positioning, group-riding formations, blind intersections and wobble recovery. The real per-item question count and whether the knowledge test is timed are not published anywhere in official New Mexico sources -- the driver manual, the MVD\'s Driver Procedures Manual (Chapters 1-3, 5, 9 and 11), the MVD\'s Frequently Asked Questions page, and the Apply-for-a-Learner\'s-Permit pages all describe the \'MVD Knowledge Exam\' requirement but never state a specific item count or time limit -- so the 40-question, untimed format used here is our own self-study default, not a confirmed MVD figure. One mechanic that IS officially confirmed: the MVD\'s own Driver Procedures Manual, Chapter 11 (\'Road And Written Test Requirements\', revised 12/08/2017), states verbatim that \'All class D and M written test scores must be 70% or better to pass.\' This 349-question bank draws on the manual\'s full ~40-page body, with particular depth in motorcycle operation and New Mexico\'s regional wildlife-hazard guidance -- a few thinner source sections (traffic violations/points, speed limits) were kept intentionally small rather than padded.',
    breakdown: [['Licensing, GDL & Seatbelt/Child Restraint Law','10%'],['Traffic Signals, Signs, Markings & Lane Controls','18%'],['Right-of-Way, Speed, Parking & Violations/Points','15%'],['Basic Driving Technique, Sight Distance & Communicating','17%'],['Road Conditions, Wildlife Hazards & Sharing the Road','14%'],['Fitness to Drive, DUI/DWI, Emergencies & Insurance','19%'],['Motorcycle Operation','7%']],
  },
  {
    examType: 'nd_driver',
    title: 'North Dakota Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/nd',
    duration: '60 Minutes', questions: 'Default: 40 Multiple Choice (No Official Count Exists -- Not Published by NDDOT) -- 264-Question Practice Pool', passScore: '80% (Self-Study Benchmark -- No Official Threshold Published)',
    description: 'Practice questions covering the 2025-2027 North Dakota Noncommercial Driver License Manual (Class D), published by the NDDOT Driver License Division: licensing requirements and the Graduated Driver License program for 14-17 year olds (including the required 50-hour supervised-driving log and parent-coaching/teen-risk material), signs, signals and pavement markings, right-of-way, turning and roundabouts, speed limits, passing and following distance, vehicle equipment, registration, insurance, parking, towing and crash reporting, DUI and drug law with North Dakota\'s specific suspension-day and point-system tables, seat belts, child restraints and heatstroke prevention, winter driving, skids, flooding and other driving skills/emergencies, sharing the road with trucks, motorcycles, bicycles and pedestrians, and North Dakota\'s recreational vehicles rules (motorized bicycles, off-highway vehicles and snowmobiles) -- for the Class D written knowledge test.',
    breakdown: [['Licensing & Graduated Driver License','15%'],['Signs, Signals & Pavement Markings','15%'],['Right-of-Way, Turning & Roundabouts','10%'],['Speed, Passing & Following Distance','8%'],['Equipment, Insurance, Parking & Towing','9%'],['DUI, Alcohol/Drugs & Points','10%'],['Seat Belts & Child Restraints','7%'],['Driving Skills, Weather & Emergencies','11%'],['Sharing the Road','8%'],['Recreational Vehicles','7%']],
  },
  {
    examType: 'ok_driver',
    title: 'Oklahoma Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ok',
    duration: '60 Minutes', questions: '20 Multiple Choice (247-Question Practice Pool)', passScore: '15/20 Correct (75%)',
    description: 'Practice questions covering the Oklahoma Driver Manual (Copyright 2025, Service Oklahoma -- the newly created state agency that took over driver licensing and testing from the Department of Public Safety in the mid-2020s): licensing and the Graduated Driver License system, license restriction codes and renewals, REAL ID and vehicle/insurance/seat belt requirements, signs, signals and pavement markings, right-of-way rules, lane usage and maneuvers, the full state speed-limit chart, stopping and following distance, parking rules, sharing the road (school buses, railroad crossings, the Move Over/Bernardo-Mills Law, and the 3-foot bicycle-passing law), driving tips including distracted driving and flood/crash response, DUI/alcohol/drug law and Zero Tolerance penalties, and the 10-point mandatory violation-point system. Exam mechanics are confirmed directly from Service Oklahoma\'s own official written-test FAQ page: the real Class D Written Knowledge Test has 20 questions, a 60-minute time limit for the online version, and requires 15 correct (75%) to pass; two failed online attempts require an in-person retest, with a $4 fee charged per failed attempt.',
    breakdown: [['Licensing, GDL & License Restrictions/Renewals','22%'],['Vehicle Requirements, Insurance & Seat Belts','6%'],['Signs, Signals & Pavement Markings','11%'],['Right-of-Way & Lane Usage/Maneuvers','13%'],['Speed Limits, Stopping, Following & Parking','17%'],['Sharing the Road & Driving Tips','16%'],['DUI/Alcohol/Drugs & Violations/Points','15%']],
  },
  {
    examType: 'or_driver',
    title: 'Oregon Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/or',
    duration: 'Untimed', questions: '35 Multiple Choice (285-Question Practice Pool)', passScore: '28/35 Correct (80%)',
    description: 'Practice questions covering the Oregon DMV Online Driver Manual: licensing, permits and testing procedures; road signs, traffic signals and pavement markings; speed regulations, space cushion/following distance, lane changes/passing, freeway driving/towing and turns/U-turns; intersections and roundabouts; sharing the road with pedestrians, school zones, bicycles, motorcycles, large vehicles and buses; emergency vehicles, police stops, work zones and railroad/light-rail crossings; parking; defensive driving, hazardous conditions/night driving, distracted driving and impaired driving; and insurance, collisions and loss-of-driving-privileges consequences -- grounded in Oregon-specific details such as exact posted speed limits by area, precise following-distance and U-turn-visibility rules, DUII thresholds (0.08% presumptive BAC for drivers 21 and over, zero tolerance for drivers under 21, Implied Consent and Open Container law), Oregon\'s graduated licensing rules for drivers under 18 (learner permit at 15, license eligibility at 16, a minimum 6-month permit hold, and 100 hours of supervised driving -- or 50 hours when paired with an approved driver education course), and Oregon\'s mandatory minimum liability insurance limits.',
    breakdown: [['Licensing, Permits & Testing','10%'],['Road Signs, Signals & Pavement Markings','15%'],['Speed, Space Cushion, Passing, Freeway & Turns','19%'],['Intersections & Roundabouts','5%'],['Pedestrians, Bicycles, Motorcycles & Large Vehicles','14%'],['Emergency Vehicles, Work Zones & Railroad/Light Rail','9%'],['Parking','5%'],['Defensive Driving, Hazards, Distracted & Impaired Driving','18%'],['Insurance, Collisions & Loss of Privileges','5%']],
  },
  {
    examType: 'ri_driver',
    title: 'Rhode Island Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ri',
    duration: '90 Minutes (Maximum)', questions: '40 Multiple Choice (242-Question Practice Pool)', passScore: 'Default: 80% (Self-Study Benchmark -- No Official Threshold Published)',
    description: 'Practice questions covering the Rhode Island Driver\'s Manual (April 2024 edition, RI Division of Motor Vehicles): licensing requirements and the state\'s three-tier graduated driver license system (Limited Learner Permit, Learner Provisional License, Full Operator\'s License), traffic laws and right-of-way, signs/signals/roadway markings (including roundabouts and the HAWK pedestrian signal), speed limits and following distance, DUI/DWI law with Rhode Island\'s penalty schedule by age and BAC tier, seat belt and child restraint requirements, distracted/drowsy/emotional driving, sharing the road with trucks, pedestrians, bicyclists and school buses, parking/work-zone/traffic-stop procedures, and vehicle equipment, driving emergencies and defensive-driving technique (IPDE, the Smith System, zones and lane positioning). The real RI DMV computerized knowledge exam is confirmed directly from the manual\'s own text at forty (40) multiple-choice questions with a 90-minute maximum time limit; applicants who fail must wait at least 8 days before retesting, per the DMV\'s own Knowledge Exams webpage. Rhode Island does not publish an official passing score or percentage for this exam anywhere -- not in the manual, and not on any DMV webpage checked -- so this bank uses an 80% self-study benchmark rather than a confirmed official figure. This 242-question bank is a much larger practice pool for self-study.',
    breakdown: [['Licensing Requirements & Graduated Driver License','12%'],['Traffic Laws & Right-of-Way','12%'],['Signs, Signals & Roadway Markings','10%'],['Speed Limits & Following Distance','7%'],['DUI, Drugs & Impaired Driving','10%'],['Seat Belt & Child Restraint Laws','7%'],['Distracted, Drowsy & Emotional Driving','9%'],['Sharing the Road','12%'],['Parking, Work Zones & Traffic Stops','9%'],['Vehicle Equipment, Emergencies & Defensive Driving','12%']],
  },
  {
    examType: 'sc_driver',
    title: 'South Carolina Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/sc',
    duration: 'Untimed', questions: '30 Multiple Choice (280-Question Practice Pool)', passScore: '80% (24/30 Correct) -- Well-Corroborated, Not SCDMV-Confirmed',
    description: 'Practice questions covering the South Carolina Driver\'s License Manual (South Carolina Department of Motor Vehicles, 2026 edition): licensing and the graduated driver license stages (beginner\'s permit, conditional license, special restricted license), points, suspension and reinstatement, state laws and golf carts, being in shape to drive, vehicle preparation and occupant safety, basic driving skills, signs, signals and pavement markings, general driving, safe driving tips, emergencies and vehicle malfunctions, sharing the road, and special driving situations. SCDMV\'s own manual does not publish an official item count, passing score, or time limit for the knowledge test -- it states only that the test covers South Carolina traffic laws, road signs, and rules of safe driving, and provides a 10-question, non-representative sample quiz. Three independent third-party DMV test-prep sources (dmv-written-test.com, driversprep.com, permittest.com) consistently and independently report a 30-question test with an 80% (24/30) passing score, and one source explicitly states the test has no time limit, so this practice exam is built to that well-corroborated -- though not SCDMV-confirmed -- format.',
    breakdown: [['Licensing & Graduated Driver License','12%'],['Points, Suspension & Reinstatement','8%'],['State Laws & Golf Carts','4%'],['Be in Shape to Drive','10%'],['Vehicle Prep & Occupant Safety','7%'],['Basic Driving Skills','5%'],['Signs, Signals & Pavement Markings','9%'],['General Driving','11%'],['Safe Driving Tips','8%'],['Emergencies & Vehicle Malfunctions','6%'],['Sharing the Road','11%'],['Special Driving Situations','9%']],
  },
  {
    examType: 'sd_driver',
    title: 'South Dakota Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/sd',
    duration: 'Untimed', questions: 'Default: 40 Multiple Choice (No Official Count or Time Limit Published by SD DPS) -- 217-Question Practice Pool', passScore: '80% or Higher (Confirmed by SD DPS)',
    description: 'Practice questions covering the South Dakota Driver\'s Manual (South Dakota Department of Public Safety, content revision 12/2023): licensing and the Graduated Driver Licensing (GDL) process across every permit stage, testing and documentation requirements, South Dakota\'s point system and license suspensions/revocations, insurance and vehicle registration, seat belt and child-restraint law, alcohol and drug law (implied consent and DUI), fitness to drive, traffic signs, signals and pavement markings, right-of-way and intersections (including roundabouts), speed and space management, passing and lane changes, parking, sharing the road with pedestrians, bicyclists, motorcyclists, trucks and buses, emergency vehicles and traffic stops, school buses and work zones, crash and emergency procedures, and night, winter and rural driving. South Dakota DPS\'s own "Driving Tests" and "FAQs" pages confirm that both the written knowledge test and the driving test require a score of 80% or higher to pass, and that applicants get up to 3 combined test attempts within a 6-month testing-fee window before a new fee applies (SDCL 32-12-2) -- but the real knowledge test\'s item count and whether it is timed are not published anywhere by DPS, so this practice exam defaults to a 40-question, untimed format as a self-study benchmark, not a confirmed DPS figure. This 217-question bank is smaller than this site\'s usual 250-300-question target: the source manual is a comparatively concise 66 printed pages, and rather than pad the bank with filler, invented statistics, or repetitive rewrites of the same fact, every quiz-worthy fact in the manual was covered once, well, and the count was allowed to land where the material honestly supports it -- 217 distinct, non-repetitive questions is the deliberate, honest ceiling this handbook supports, not an oversight.',
    breakdown: [['Licensing & Graduated Driver Licensing (GDL)','6%'],['Testing, Documentation, Fees & Special Provisions','10%'],['Points, Suspension, Revocation & Restrictions','8%'],['Insurance, Registration & Vehicle Preparation','6%'],['Seatbelts, Child Restraints & Fitness to Drive','8%'],['Alcohol, Drugs & DUI','5%'],['Traffic Signs, Signals, Markings & Lane Control','9%'],['Right-of-Way, Intersections, Speed & Space Management','12%'],['Passing, Parking & Sharing the Road','13%'],['Emergency Response, School Buses, Work Zones & Crashes','13%'],['Night, Weather, Rural Driving, Signaling & Defensive Techniques','10%']],
  },
  {
    examType: 'tn_driver',
    title: 'Tennessee Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/tn',
    duration: 'Untimed (No Official Time Limit Published by the Tennessee Department of Safety and Homeland Security)', questions: 'Default: 40 Multiple Choice (No Official Count, Passing Score, or Time Limit Published -- Law Mandates a 25/25/25/25 Split Across 4 Topic Areas) -- 290-Question Practice Pool', passScore: '80% (Self-Study Benchmark -- No Official Threshold Published)',
    description: 'Practice questions covering the Tennessee Comprehensive Driver License Manual (Tennessee Department of Safety and Homeland Security, current-as-of-July-1-2022 edition): licensing and the Graduated Driver License (GDL) program, traffic signs, signals and pavement markings, right-of-way and intersections, speed, following and stopping distances, turning, lanes and passing, parking rules, railroad crossings and school buses, DUI, alcohol and drug law, seatbelt and child-restraint requirements, distracted driving and vehicle equipment, interstate driving, night and weather driving, driver responsibility, points and insurance, defensive driving and collision avoidance, and sharing the road with pedestrians, bicyclists, motorcyclists, trucks, trains and farm equipment. One structural fact about the real exam IS confirmed directly in the manual (Section A-4, The Examinations, cross-referenced with Section B-7): Tennessee law mandates that the knowledge test be split into four roughly equal areas -- traffic signs and signals (25%), safe driving principles (25%), rules of the road (25%), and drugs and alcohol (25%) -- so every quarter of the real test draws from one of these four legally required areas. A 1-day mandatory wait also applies after any knowledge-test failure. What the manual does NOT publish anywhere across its 135 pages -- confirmed by a full-text search of the manual plus a check of the Department\'s Class D new-drivers and teen GDL pages -- is the real test\'s exact total item count, numeric passing score, or time limit; those three figures are therefore left as our own self-study defaults (40 questions, 80%-to-pass, untimed) rather than invented numbers. This 290-question bank draws on the manual\'s unusually deep, Tennessee-specific content -- a full DUI penalty and BAC table, the driver-responsibility/points system, and a full \'sharing the road\' chapter -- to give thorough coverage of all four legally mandated test areas, plus the licensing/GDL and driver-responsibility material the manual also covers.',
    breakdown: [['Traffic Signs & Signals (1 of 4 State-Mandated Exam Areas)','10%'],['Rules of the Road (1 of 4 State-Mandated Exam Areas)','30%'],['Safe Driving Principles (1 of 4 State-Mandated Exam Areas)','35%'],['Drugs & Alcohol (1 of 4 State-Mandated Exam Areas)','9%'],['Licensing, GDL & Driver Responsibility (Additional Manual Content)','16%']],
  },
  {
    examType: 'ut_driver',
    title: 'Utah Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/ut',
    duration: 'Untimed (Typically 30-45 Minutes)', questions: '50 Questions (New Applicants, Closed-Book) or 25 (Renewal, Open-Book) (258-Question Practice Pool)', passScore: '80% or Better',
    description: 'Practice questions covering the Utah Driver Handbook, published by the Driver License Division (DLD) -- a separate agency from the Division of Motor Vehicles (DMV), which in Utah handles only vehicle/vessel registration, not driver licensing or testing. The real written knowledge test has a two-tier structure: applicants who have never held a license take a closed-book, 50-question test, while previously licensed applicants renewing or reinstating take an open-book, 25-question test; both are untimed (typically 30-45 minutes) and require a score of 80% or better to pass. (A separate, distinct 100%-required online-only \'Traffic Safety and Trends Exam\' also applies to first-time applicants, but this pool targets the primary written knowledge test.) Topic coverage includes licensing and the Graduated Driver License (GDL) program, vision/health requirements and both exams, vehicle preparation and occupant safety, basic driving maneuvers, traffic signs/signals/markings, speed/intersections/right-of-way, alcohol and drug law -- notably Utah\'s unusually low 0.05 BAC per se limit (below the 0.08 standard used by most states), 0.04 for CDL holders, and the \'Not-a-Drop\' zero-tolerance law for drivers under 21 -- distraction and weather hazards (including Utah-specific black ice and desert-driving conditions), crashes/insurance/emergencies, suspensions and the point system, sharing the road (bicycles, motorcycles, large trucks, pedestrians, and TRAX light rail trains), vehicle equipment/towing/registration, and documents/endorsements/fees. Several questions also cover Utah-specific road features called out in the handbook, such as continuous-flow and diverging-diamond intersections, thru-U-turn lanes, and I-15 express lanes.',
    breakdown: [['Licensing Requirements, GDL & Exams (Vision/Health)','23%'],['Basic Maneuvers, Signs/Signals & Intersections','24%'],['Vehicle Prep, Equipment & Documents/Fees','17%'],['Alcohol/Drug Law (DUI) & Distractions/Weather Hazards','14%'],['Crashes, Insurance & Suspensions/Points','11%'],['Sharing the Road','11%']],
  },
  {
    examType: 'vt_driver',
    title: 'Vermont Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/vt',
    duration: 'Untimed', questions: '20 Multiple Choice (235-Question Practice Pool)', passScore: '16/20 Correct (80%)',
    description: 'Practice questions covering the Vermont Driver\'s Manual (VN-007, 2025 edition), published by the Vermont Agency of Transportation, Department of Motor Vehicles: licensing, learner\'s permit rules, the online knowledge test, and proof-of-identity/application documents; the Junior Driver\'s License and Graduated Driver\'s License (GDL) program -- the required permit-holding period, the 30-hour classroom/6-hour behind-the-wheel/6-hour observation driver-education course, supervised practice-driving hours, the nighttime-driving definition, staged passenger-carrying restrictions, and JRP/JRT/CPH/DRB recall violations -- and the point system for losing your license; right-of-way, turns, speed limits, parking and roundabouts; traffic lights, road signs and highway markings; work zones, railroad crossings and the Move Over law; sharing the road with pedestrians, school buses, bicycles, motorcycles, trucks, slow-moving vehicles and animals; hazardous conditions, night driving, interstate driving, winter driving, and impaired and distracted driving; and road test procedures, vehicle equipment, child restraints, crashes, insurance, vehicle registration, commercial licenses, disabilities and parent guidance -- for Vermont\'s online DMV knowledge test, administered at mydmv.vermont.gov.',
    breakdown: [['Licensing, Learner\'s Permit, Knowledge Test & Proof of Identity','13%'],['Junior License, GDL Program & Point System','14%'],['Right-of-Way, Speed, Parking, Roundabouts, Signs & Signals','19%'],['Work Zones, Railroad Crossings & Sharing the Road','18%'],['Hazardous Conditions, Winter Driving & Impaired/Distracted Driving','21%'],['Road Test, Vehicle Equipment, Crashes, Insurance, CDL & Disabilities','15%']],
  },
  {
    examType: 'wv_driver',
    title: 'West Virginia Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/wv',
    duration: 'Timed (Specific Limit Not Published)', questions: 'At Least 25 Multiple Choice (282-Question Practice Pool)', passScore: '19/25 Correct (76%)',
    description: 'Practice questions covering the official West Virginia Driver\'s Licensing Handbook (Rev. 07/2022), published by the WV Department of Transportation, Division of Motor Vehicles: the three-level Graduated Driver\'s License (GDL) program and other licensing requirements, driver responsibilities and the point system, DUI and impaired driving law, examination procedures, traffic signs, traffic signals and pavement markings, speed and following distance, turning/parking/right-of-way, sharing the road, interstate driving, defensive driving and weather hazards, safety equipment, and emergency situations and first aid. The handbook itself states the knowledge exam has at least 25 questions, is timed, and requires 19 of 25 correct (76%) to pass -- it does not publish the exact number of minutes allowed.',
    breakdown: [['Licensing & GDL','14%'],['Driver Responsibilities & Points','8%'],['DUI & Impaired Driving','7%'],['Examination Procedures','6%'],['Traffic Signs','9%'],['Signals & Pavement Markings','8%'],['Speed & Following Distance','4%'],['Turning, Parking & Right-of-Way','11%'],['Sharing the Road','10%'],['Interstate Driving','5%'],['Defensive Driving & Weather','7%'],['Safety Equipment','4%'],['Emergency Situations & First Aid','7%']],
  },
  {
    examType: 'wi_driver',
    title: 'Wisconsin Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/wi',
    duration: '~45 Minutes (Not a Hard Time Limit)', questions: '50 Multiple Choice (272-Question Practice Pool)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Wisconsin Motorists\' Handbook (Wisconsin Department of Transportation / Division of Motor Vehicles, 2026 edition): licensing and testing requirements, the instruction permit and supervised-driving rules, the probationary license (GDL) and sponsorship/liability requirements, regular-license renewal and out-of-state/REAL ID transfers, right-of-way, speed and following distance and space between vehicles, intersections, stopping and sight distance, turning, passing, backing and parking, vehicle communication (lights, horn and signals), warning, regulatory, construction, destination and service signs plus railroad crossings, traffic signals and pavement markings, special lanes and roundabouts, other driving situations (metered ramps, diverging diamond interchanges, traffic stops, deer and funeral processions), weather, winter and rural/farm driving, crash and roadside-emergency procedures, alcohol, drugs, distracted and drowsy driving, sharing the road, the points/habitual-offender/occupational-license system, and seat belts, insurance and other requirements -- for the Wisconsin DMV\'s 50-question Knowledge Test. (Wisconsin also requires a separate, shorter Highway Signs Test -- 15 questions, 12 correct/80% to pass -- as part of the same testing visit; this practice track is built around the primary 50-question Knowledge Test.)',
    breakdown: [['Licensing, Permits, GDL, Sponsorship & Renewal','20%'],['Signs, Signals, Pavement Markings & Railroad Crossings','18%'],['Turning, Passing, Parking, Vehicle Communication & Roundabouts','16%'],['Emergencies, Points & Other Requirements','14%'],['Right-of-Way, Speed, Following Distance & Space Between Vehicles','14%'],['Driving Situations, Weather & Sharing the Road','14%'],['Alcohol, Drugs, Distracted & Drowsy Driving','4%']],
  },
  {
    examType: 'wy_driver',
    title: 'Wyoming Driver Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', route: '/driver/wy',
    duration: 'Untimed', questions: 'Default: 40 Multiple Choice (No Official Count Exists -- Not Published by WYDOT\'s Manual, Testing Page, FAQ, or W.S. 31-7-114) -- 281-Question Practice Pool', passScore: '80% (Self-Study Benchmark -- No Official Threshold Published)',
    description: 'Practice questions covering the Wyoming Rules of the Road Driver License Manual (2021 edition, published by WYDOT\'s Driver Services Program): driver license classes and restriction codes, testing and documentation requirements, fees, renewals and the Graduated Driver License system (age-restricted \'extreme inconvenience\' licenses at 14-15, intermediate licenses at 16, full privileges at 16.5-17 with a 50-hour supervised-driving requirement including 10 night hours), vehicle equipment, seat belt and child-restraint law, traffic-sign shapes and colors, signals and pavement markings, railroad crossings, speed limits, right-of-way at intersections and roundabouts, required stops and school buses, changing lanes and turning, passing, parking, interstate driving, traffic crashes, sharing the road with motorcycles, bicycles, heavy vehicles, animals and pedestrians, defensive driving and space-cushion technique, reduced-light and night driving, weather conditions, emergency situations, DUI/alcohol/drug law, license suspensions/revocations/penalties, and health, vision and definitions. WYDOT\'s manual turned out unusually rich for a small state -- concrete, testable figures throughout include the full speed-limit table, BAC thresholds (0.08 adult / 0.02 youthful / 0.05 supporting-evidence), detailed DWUI suspension and ignition-interlock schedules by offense number, child-restraint fines ($60/$110) and the federal FMVSS 213 requirement, following-distance multipliers by condition, headlight-dimming distances, and the 20-mph Move Over Law reduction. Real exam mechanics were actively researched across four official sources -- the full manual text, WYDOT\'s own Testing Requirements page, WYDOT\'s FAQ page, and the governing statute (W.S. 31-7-114) -- and none of them publish a written-test item count, passing score, or time limit. The only related figure WYDOT does disclose concerns a separate, differently-scored driving skills test: a retest is delayed to three days if an applicant misses 13 or more items on that skills-test scoring sheet, a detail reflected in this question bank but not conflated with the unconfirmed written-test numbers. This 281-question bank is our own self-study practice pool.',
    breakdown: [['Licensing, Testing, Fees & GDL Requirements','15%'],['Vehicle Equipment, Safety Belts & Child Restraints','7%'],['Traffic Signs, Signals, Markings & Railroad Crossings','12%'],['Speed, Right-of-Way, Intersections & Required Stops','12%'],['Lane Changes, Turning, Passing, Parking & Interstate Driving','13%'],['Traffic Crashes, Sharing the Road & Defensive Driving','13%'],['Night Driving, Weather & Emergency Situations','11%'],['DUI/Alcohol/Drug Law, Suspensions, Revocations & Penalties','11%'],['Health, Vision, Hearing, Distracted Driving & Definitions','6%']],
  },
  {
    examType: 'al_cdl',
    title: 'Alabama CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/al',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Alabama Commercial Driver License Manual (ALEA Driver License Division, 2005 CDL Testing System / AAMVA, Version July 2017): CDL vehicle classes and licensing, vehicle inspection and distracted driving, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, and school bus endorsement content.',
    breakdown: [['CDL Licensing, Vehicle Inspection & Cargo/Passenger Safety', '49%'], ['Vehicle Control, Air Brakes & Combination Vehicles', '29%'], ['Hazardous Materials', '14%'], ['School Bus', '8%']],
  },
  {
    examType: 'ak_cdl',
    title: 'Alaska CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ak',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Alaska Commercial Driver License Manual (Alaska DMV, Division of Motor Vehicles): CDL licensing and vehicle inspection, basic control and on-road driving, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, and school bus endorsement content. The manual states directly that the minimum passing score for all knowledge tests is 80%.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control & Cargo/Passenger Safety', '50%'], ['Vehicle Control, Air Brakes & Combination Vehicles', '24%'], ['Hazardous Materials', '17%'], ['School Bus', '9%']],
  },
  {
    examType: 'az_cdl',
    title: 'Arizona CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/az',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by ADOT)', passScore: '40/50 Correct (80% -- Confirmed Directly in the ADOT Manual)',
    description: 'Practice questions covering the Arizona Commercial Driver License Manual (ADOT Motor Vehicle Division, Customer Service Guide for Commercial Drivers, Revised 01/2026): CDL licensing and vehicle inspection, basic control and on-road driving, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, and school bus endorsement content. The manual states directly that applicants must answer at least 80% of questions correctly to pass each knowledge test; the 50-question count follows the federally standardized AAMVA format (49 CFR 383.135(a)) used by every other state\'s CDL General Knowledge test, corroborated by multiple third-party AZ CDL prep sources, since ADOT\'s own manual text doesn\'t spell out the item count verbatim.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control & Cargo/Passenger Safety', '45%'], ['Vehicle Control, Air Brakes & Combination Vehicles', '27%'], ['Hazardous Materials', '19%'], ['School Bus', '9%']],
  },
  {
    examType: 'ar_cdl',
    title: 'Arkansas CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ar',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by Arkansas DPS)', passScore: '40/50 Correct (80% -- Federal Minimum per 49 CFR 383.135(a), Not Independently Restated by the Arkansas Manual)',
    description: 'Practice questions covering the Arkansas Commercial Driver License Manual (AAMVA 2022 Modernized CDL Testing System, Version: March 2025, with the state-specific supplement published by the Arkansas Department of Public Safety / Arkansas State Police): CDL licensing and vehicle inspection, basic control and on-road driving, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, and school bus endorsement content. Neither the Arkansas manual nor the DPS site spells out an exact knowledge-test item count or a state-specific passing percentage; this practice exam follows the federally standardized 50-question AAMVA format and the 80%-correct (40/50) minimum set by 49 CFR 383.135(a), the same convention used for other states\' CDL knowledge tests whose manuals don\'t publish their own figures.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control & Cargo/Passenger Safety', '51%'], ['Vehicle Control, Air Brakes & Combination Vehicles', '27%'], ['Hazardous Materials', '15%'], ['School Bus', '7%']],
  },
  {
    examType: 'co_cdl',
    title: 'Colorado CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/co',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by CO DMV)', passScore: '40/50 Correct (80% -- Federal AAMVA/FMCSA Minimum, Not Independently Published by CO DMV)',
    description: 'Practice questions covering the Colorado Commercial Driver License Manual (2023 CDL Testing System, DR 2251, June 2023, Colorado Department of Revenue – Division of Motor Vehicles): CDL licensing and vehicle inspection, basic control and on-road driving, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, and school bus endorsement content. Colorado issues a Commercial Learner\'s Permit that must be held at least 14 days before the skills test, offers the knowledge test in English and Spanish (the Hazmat endorsement test is English-only), and issues CDLs with a 4-year validity period; drivers aged 18-20 may qualify for an intrastate-only \'K\' restricted CDL. Neither the Colorado manual nor the state DMV site publishes a Colorado-specific passing percentage or knowledge-test item count; this practice exam follows the federally standardized 80%-correct / 50-question AAMVA General Knowledge format (49 CFR 383.135(a)) used across CDL knowledge testing nationwide.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control & Cargo/Passenger Safety', '33%'], ['Vehicle Control, Air Brakes & Combination Vehicles', '45%'], ['Hazardous Materials', '15%'], ['School Bus', '7%']],
  },
  {
    examType: 'ct_cdl',
    title: 'Connecticut CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ct',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- Confirmed Directly by the CT DMV)', passScore: '40/50 Correct (80% -- Confirmed Directly by the CT DMV)',
    description: 'Practice questions covering the Connecticut Commercial Driver License Manual (R-295 Rev. 12/2024, AAMVA 2022 Modernized CDL Testing System), published by the Connecticut Department of Motor Vehicles: CDL licensing and vehicle inspection, basic control and on-road driving, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, and school bus endorsement content. Unlike many states, Connecticut\'s exam mechanics are explicitly published by the CT DMV: the General Knowledge test is 50 questions with 40 correct (80%) required to pass; endorsement knowledge tests are shorter (Hazardous Materials: 30 questions/24 correct; Air Brakes: 25 questions/20 correct; other single endorsements: 20 questions/16 correct); testing is by appointment only at CT DMV offices, with a $16 general knowledge test fee, $5 per endorsement test, and a $30 skills test fee.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control & Cargo/Passenger Safety', '50%'], ['Vehicle Control, Air Brakes & Combination Vehicles', '27%'], ['Hazardous Materials', '16%'], ['School Bus', '7%']],
  },
{
    examType: 'de_cdl',
    title: 'Delaware CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/de',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by DE DMV)', passScore: '40/50 Correct (80% -- Federal Minimum per 49 CFR 383.135(a), Not Independently Published by DE DMV)',
    description: 'Practice questions covering the Delaware Commercial Driver\'s Manual (2022 CDL Testing System, Version 4.0, AAMVA Modernized Testing System, Release Date: February 2025), published by the Delaware Department of Transportation / Division of Motor Vehicles: CDL licensing and vehicle inspection, basic control and on-road driving, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, and school bus endorsement content. No official DE.gov source explicitly states the exact knowledge-test item count or passing score; this practice exam follows the federally standardized 50-question/80%-correct AAMVA format (49 CFR 383.135(a)) used by every other state\'s CDL knowledge test, corroborated by third-party DE CDL prep sources.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control & Cargo/Passenger Safety', '34%'], ['Vehicle Control, Air Brakes & Combination Vehicles', '44%'], ['Hazardous Materials', '15%'], ['School Bus', '7%']],
  },
  {
    examType: 'hi_cdl',
    title: 'Hawaii CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/hi',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by a Hawaii County CDL Office)', passScore: '40/50 Correct (80% -- Federally Standardized Under 49 CFR 383.135(a))',
    description: 'Practice questions covering the Hawaii Commercial Driver License Manual (2005 CDL Testing System / AAMVA, Version July 2017, Hawaii: May 2023 update), used statewide by Hawaii\'s four County Commercial Driver Licensing Offices (Honolulu, Hawaii, Maui, and Kauai counties): CDL licensing and vehicle inspection, basic control and on-road driving, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, and school bus endorsement content. The manual and the county CDL offices\' fee schedules describe the knowledge test process but don\'t spell out an exact item count for any test; the 50-question count follows the federally standardized AAMVA format (49 CFR 383.135(a)) used by every other state\'s CDL General Knowledge test, and the 80% passing threshold is set directly by that same federal regulation.',
    breakdown: [['CDL Licensing', '9%'], ['Driving Safely, Basic Control & On-Road', '24%'], ['Cargo & Passenger Transport', '14%'], ['Air Brakes, Combination Vehicles & Doubles/Triples', '21%'], ['Tank Vehicles & Hazardous Materials', '19%'], ['School Bus & Vehicle Inspection', '13%']],
  },
  {
    examType: 'id_cdl',
    title: 'Idaho CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/id',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- Confirmed Directly in the ITD Manual\'s Knowledge Test Information Table)', passScore: '40/50 Correct (80% -- Confirmed Directly in the ITD Manual)',
    description: 'Practice questions covering the Idaho Commercial Driver License Manual (Idaho Transportation Department, Division of Motor Vehicles, 2022 CDL Testing System, July 2026 Edition): CDL licensing and vehicle inspection, basic control and on-road driving, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, and school bus endorsement content. The manual\'s own Knowledge Test Information table (Section 1) states the General Knowledge test is 50 questions with 40 correct required to pass (80%), the same table that separately confirms item counts for every endorsement test (Hazmat 30/24, Air Brakes 25/20, and Combination Vehicles/Tank Vehicles/Doubles-Triples/Passenger/School Bus at 20/16 each).',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control, On-Road Driving & Cargo/Passenger Safety', '55%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '25%'], ['Hazardous Materials', '13%'], ['School Bus', '7%']],
  },
  {
    examType: 'il_cdl',
    title: 'Illinois CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/il',
    duration: '60 Minutes', questions: '30 Multiple Choice (General Knowledge -- Confirmed Directly in the Illinois CDL Guide, Section 1.4.1)', passScore: '24/30 Correct (80% -- Confirmed Directly in the Illinois Guide)',
    description: 'Practice questions covering the Illinois Commercial Driver\'s License Guide (Illinois Secretary of State, document code DSD CDL 10.30, July 2025 edition): CDL licensing and vehicle inspection, basic control and on-road driving, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, and school bus endorsement content. The guide\'s own Section 1.4.1 (Computerized Written Knowledge Testing) states directly that the General (core) Knowledge test consists of 30 standardized multiple-choice questions with an 80% minimum passing score (24 correct) -- a smaller item count than the 50-question format used by many other states. Illinois also runs its own state-authored guide with features not present in the standard AAMVA model: a distinct Class D non-CDL license category, a combined Hazardous Materials & Tank Vehicle (X) endorsement alongside the standard P/N/S/H/T letters, and an Illinois-specific Charter Bus (C) endorsement for buses transporting school children on district charter trips.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control & Cargo/Passenger Safety', '56%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '23%'], ['Hazardous Materials', '15%'], ['School Bus', '6%']],
  },
  {
    examType: 'in_cdl',
    title: 'Indiana CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/in',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by Indiana BMV)', passScore: '40/50 Correct (80% -- Federal Minimum Confirmed in the Indiana-Specific BMV Supplement)',
    description: 'Practice questions covering the Indiana Commercial Driver\'s License Manual (Indiana Bureau of Motor Vehicles (BMV), AAMVA \'Modernized Testing System\' base manual, cover-dated September 9, 2022), supplemented by the official Indiana-Specific Commercial Driver\'s License Applicant Information document (form SP 283): CDL licensing and vehicle inspection, basic control and on-road driving, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, and school bus endorsement content. Neither the base AAMVA manual nor the Indiana-specific BMV supplement states an exact knowledge-test item count or number-correct-to-pass; this practice exam follows the federally standardized 50-question AAMVA format (49 CFR 383.135(a)) used by every other state\'s CDL knowledge test, since Indiana\'s official sources confirm only the federal 80% minimum passing score and don\'t spell out the item count verbatim.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control & Cargo/Passenger Safety', '32%'], ['Driving Safely, Air Brakes, Combination, Doubles/Triples & Tank Vehicles', '43%'], ['Hazardous Materials', '17%'], ['School Bus', '8%']],
  },
  {
    examType: 'ia_cdl',
    title: 'Iowa CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ia',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- Confirmed Directly on the Iowa DOT CDL Testing Page)', passScore: '40/50 Correct (80% -- Confirmed Directly on the Iowa DOT CDL Testing Page)',
    description: 'Practice questions covering the Iowa Commercial Driver License Manual (Iowa Department of Transportation, National CDL Manual, 2005 AAMVA Testing System with Iowa Supplemental Sections 11 and 12): CDL licensing and vehicle inspection, basic control and on-road driving, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, and school bus endorsement content. Iowa\'s own official CDL Testing page publishes an explicit \'Types of CDL knowledge tests (number of questions/allowed to miss)\' table -- General Knowledge is 50 questions with 40 correct required to pass (80%, 10 allowed wrong) -- and Iowa\'s manual carries a distinctive state-specific rule that the pre-trip inspection\'s service brake check step is verbally described only, with no physical demonstration required.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control & Cargo/Passenger Safety', '31%'], ['Vehicle Control, Air Brakes & Combination Vehicles', '47%'], ['Hazardous Materials', '15%'], ['School Bus', '7%']],
  },
  {
    examType: 'ks_cdl',
    title: 'Kansas CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ks',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by KDOR)', passScore: '40/50 Correct (80% -- Federal Minimum Under 49 CFR 383.135(a); Kansas Manual Does Not State an Exact Item Count)',
    description: 'Practice questions covering the Kansas Commercial Driver\'s License Manual (Kansas Department of Revenue, Division of Vehicles, AAMVA Modernized Testing System base manual, Version: March 2025): CDL licensing and vehicle inspection, basic control and on-road driving, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, and school bus endorsement content. Kansas\'s manual and ksrevenue.gov\'s CDL pages do not publish an exact knowledge-test item count or passing score; only the 80% minimum passing score, federally standardized under 49 CFR 383.135(a), is asserted here, and this practice exam follows the same 50-question AAMVA format used by every other state\'s CDL General Knowledge test.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control & Cargo/Passenger Safety', '32%'], ['Vehicle Control, Air Brakes & Combination Vehicles', '46%'], ['Hazardous Materials', '15%'], ['School Bus', '7%']],
  },
  {
    examType: 'ky_cdl',
    title: 'Kentucky CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ky',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Kentucky Commercial Driver\'s License Manual (Kentucky State Police / Kentucky Transportation Cabinet Division of Driver Licensing, Modernized Testing System, base AAMVA content Version: September 9, 2022, Kentucky-specific sections revised 12/2024): CDL licensing, vehicle inspection, and basic control/on-road driving; transporting cargo and passengers safely; air brakes, combination vehicles, doubles/triples, and tank vehicles; hazardous materials; and school bus endorsement content. Kentucky\'s manual directly confirms real exam mechanics in its Kentucky-specific front matter: the General Knowledge test is 50 questions, the Class A Combination Vehicles test is 20 questions, Air Brakes is 25 questions, Doubles/Triples, Tankers, and Passenger Transport are each 20 questions, Hazardous Materials is 30 questions, and School Bus is 20 questions -- every test requires at least 80% correct to pass.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '32%'], ['Driving Safely (General Safe Driving Practices)', '20%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '25%'], ['Hazardous Materials', '16%'], ['School Bus', '7%']],
  },
  {
    examType: 'la_cdl',
    title: 'Louisiana CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/la',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by Louisiana OMV)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Not Independently Published by Louisiana OMV)',
    description: 'Practice questions covering the Louisiana Commercial Driver\'s License Manual (Louisiana Department of Public Safety & Corrections, Office of Motor Vehicles, 2005 CDL Testing System, Version: July 2017): CDL licensing (Class A/B/C license types, the manual\'s six knowledge-test endorsements, restrictions, and disqualification penalties), driving safely, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, school bus endorsement content, vehicle inspection, and basic control/on-road driving. Neither the base manual, the Louisiana Administrative Code Title 55 Third-Party-Tester provisions, nor the official OMV CDL Driver Education webpage states an exact knowledge-test question count or number-correct-to-pass for any Louisiana CDL test; several third-party prep sites claim 50 questions/40 correct (80%), but this could not be confirmed on any official LA.gov or dps.louisiana.gov source. What is confirmed directly from official Louisiana sources is the federally standardized 80% minimum passing score (49 CFR 383.135(a)) that applies to every state\'s CDL knowledge tests, so this practice exam follows that same 50-question/40-correct format used by every other CDL-track state.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control & Cargo/Passenger Safety', '54%'], ['Vehicle Control, Air Brakes & Combination Vehicles', '22%'], ['Hazardous Materials', '17%'], ['School Bus', '7%']],
  },
  {
    examType: 'ma_cdl',
    title: 'Massachusetts CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ma',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Massachusetts Commercial Driver\'s License Manual (Massachusetts Registry of Motor Vehicles (RMV), AAMVA Modernized Testing System base content Version: July 2017, with a Massachusetts-specific front matter/Preface revised March 2025): CDL licensing, vehicle inspection, and basic control/on-road driving; driving safely, including a dedicated seeing-hazards-and-distracted-driving section covering the federal hand-held-phone and texting disqualification rules; transporting cargo and passengers safely; air brakes, combination vehicles, doubles/triples, and tank vehicles; hazardous materials; and school bus endorsement content. Massachusetts\'s manual is unusually thorough in disclosing real exam mechanics directly in its Preface -- the General Knowledge test is 50 questions in one hour, the Passenger Transport test is 20 questions in 20 minutes, Air Brakes is 25 questions in 25 minutes, Combination Vehicles is 20 questions in 20 minutes, Hazardous Materials is 30 questions in 30 minutes, and Tankers and Doubles/Triples are each 20 questions in 20 minutes, with at least 80% correct required to pass every test -- but it notably stops short of disclosing an item count or time limit for the School Bus test, so that figure is left unconfirmed here rather than guessed or borrowed from another state.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '30%'], ['Driving Safely (General Safe Driving Practices)', '24%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '21%'], ['Hazardous Materials', '16%'], ['School Bus', '9%']],
  },
  {
    examType: 'md_cdl',
    title: 'Maryland CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/md',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by MDOT MVA)', passScore: '40/50 Correct (80% -- 80% Confirmed Directly in the Maryland CDL Manual\'s Front Matter; Item Count Follows AAMVA/Federal-Standard Format, Not Independently Published by MDOT MVA)',
    description: 'Practice questions covering the Maryland Commercial Driver\'s License Manual (DL-151, 05/26), published by the Maryland Department of Transportation Motor Vehicle Administration (MDOT MVA): CDL licensing (Class A/B/C definitions, the manual\'s six knowledge-test endorsements T/P/N/H/S/X, age minimums, and disqualification penalties), vehicle inspection, basic control and on-road driving, general safe-driving practices, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials (including the TSA background-check requirement), and school bus endorsement content. The manual\'s own front matter directly confirms an 80% passing score is required on every knowledge test, but neither the manual nor the official MVA Knowledge Tests webpage discloses an exact question count for the CDL general knowledge test or any endorsement test -- MVA publishes item counts only for non-commercial license classes. Several third-party test-prep sites converge on 50 questions/40 correct, but since that figure is not confirmed on any official Maryland source, this practice exam follows the same federally standardized AAMVA format used by every other CDL-track state in this project.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '32%'], ['Driving Safely (General Safe Driving Practices)', '22%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '23%'], ['Hazardous Materials', '15%'], ['School Bus', '8%']],
  },
  {
    examType: 'me_cdl',
    title: 'Maine CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/me',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by Maine BMV)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Item Count Not Independently Published by Maine BMV)',
    description: 'Practice questions covering the Maine Commercial Driver License Manual (Maine Department of the Secretary of State, Bureau of Motor Vehicles, 2005 CDL Testing System base AAMVA content, Maine revision dated 7/24): CDL licensing (Class A/B/C license types, Maine\'s six knowledge-test endorsements -- N, H, X, T, P, and S -- plus disqualification penalties and the TSA hazmat background-check process), driving safely, transporting cargo and passengers safely, air brakes, combination vehicles, doubles/triples (Maine allows doubles but not triples) and tank vehicles, hazardous materials, school bus endorsement content, pre-trip vehicle inspection, and basic control/on-road driving. Neither the official Maine CDL manual nor the companion Maine Commercial Driver License Skills Test Addendum discloses an exact knowledge-test question count or number-correct-to-pass for the general knowledge test; several third-party test-prep sites claim 50 questions/40 correct (80%), but this could not be confirmed on any official maine.gov or digitalmaine.com source. What is confirmed directly from official Maine sources is the federally standardized 80% minimum passing score (49 CFR 383.135(a)) that applies to CDL knowledge tests nationwide, plus a separate, distinct 80%-of-items-checked requirement for the skills-test vehicle inspection component -- so this practice exam follows the same 50-question/40-correct knowledge-test format used by every other CDL-track state.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '27%'], ['Driving Safely (General Safe Driving Practices)', '25%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '21%'], ['Hazardous Materials', '20%'], ['School Bus', '7%']],
  },
  {
    examType: 'mn_cdl',
    title: 'Minnesota CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/mn',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by Minnesota DVS)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Not Independently Published by Minnesota DVS)',
    description: 'Practice questions covering the Minnesota Commercial Driver\'s License Manual (Minnesota Department of Public Safety, Division of Driver and Vehicle Services, Modernized Testing System, AAMVA base content Version: July 2017, Minnesota-specific front matter Form Number PS30002-33, 01/2022): CDL licensing (Class A/B/C license types, Minnesota\'s six knowledge-test endorsements H/N/P/S/T/X, its unusually granular eleven-code restriction table, and state-specific exemptions), driving safely, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, both the generic AAMVA school bus content and Minnesota\'s own unusually extensive Part B School Bus Driver\'s Handbook, vehicle inspection, and basic control/on-road driving. Neither the manual\'s Minnesota-specific front matter nor any AAMVA base-manual text states an exact knowledge-test item count or number-correct-to-pass for any Minnesota CDL test; the manual\'s only explicit "80%" figure applies to the separate federal Entry-Level Driver Training (ELDT) theory-training assessment, not the CDL knowledge test itself. What is confirmed directly from the official Minnesota manual is the federally standardized 80% minimum passing score (49 CFR 383.135(a)), so this practice exam follows the same 50-question/40-correct AAMVA/FMCSA format used by every other hedged CDL-track state in this project.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control & Cargo/Passenger Safety', '25%'], ['Driving Safely, Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '37%'], ['Hazardous Materials', '20%'], ['School Bus (Generic AAMVA Content Plus Minnesota\'s Own Part B Handbook)', '18%']],
  },
  {
    examType: 'mo_cdl',
    title: 'Missouri CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/mo',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Missouri Commercial Driver License Manual (Missouri Department of Revenue, in cooperation with the Missouri State Highway Patrol, Modernized/2005 CDL Testing System, base AAMVA content Version: July 2017, with Missouri-specific front matter and Section 11/12 modernized components revised March 2025, cover revised August 2025): CDL licensing, vehicle inspection, and basic control/on-road driving; transporting cargo and passengers safely; air brakes, combination vehicles, doubles/triples, and tank vehicles; hazardous materials; and school bus endorsement content. Missouri\'s manual is unusually well-documented among this project\'s CDL-track states: its Missouri-specific Section 14 front matter fully and unambiguously discloses every written-exam item count -- General Knowledge 50 questions, Air Brakes 25, Combination Vehicles 20, Hazardous Materials 30, Doubles/Triples 20, Passenger 20, Tank 20, and School Bus 20 -- with at least 80% correct required to pass every test.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '30%'], ['Driving Safely (General Safe Driving Practices)', '21%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '22%'], ['Hazardous Materials', '18%'], ['School Bus', '9%']],
  },
  {
    examType: 'ms_cdl',
    title: 'Mississippi CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ms',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by Mississippi DPS)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Not Independently Published by Mississippi DPS)',
    description: 'Practice questions covering the Mississippi Commercial Driver\'s License Manual (AAMVA \'Modernized Testing System\' base content -- interior section footers still read \'Version: July 2017\' while the cover page reflects the Mississippi Department of Public Safety\'s most recent March 2025 republication date), published by the Mississippi DPS Driver Service Bureau: CDL licensing (Class A/B/C definitions, the manual\'s six knowledge-test endorsements, restriction codes, and disqualification rules), driving safely (including a dedicated focus on seeing hazards and managing driver distraction), transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, school bus endorsement content, vehicle inspection, and basic control/on-road driving. The word \'Mississippi\' does not appear anywhere in this manual\'s text -- it is the generic unmodified AAMVA base manual with no Mississippi-specific preface, and neither the manual\'s Section 1.1.1 list of knowledge tests nor the DPS Driver Service Bureau\'s own CDL webpage discloses an item count, time limit, or passing-score percentage for any test. What is confirmed is the federally standardized 80% minimum passing score (49 CFR 383.135(a)) that applies to every state\'s CDL knowledge tests; multiple independent third-party CDL prep sites converge on a 50-question/40-correct Mississippi General Knowledge format, so this practice exam follows that same widely-used format.',
    breakdown: [['Driving Safely, Seeing Hazards/Distraction & Basic Vehicle Control', '34%'], ['CDL Licensing & Vehicle Inspection', '16%'], ['Air Brakes & Combination Vehicles', '16%'], ['Hazardous Materials', '11%'], ['School Bus', '10%'], ['Transporting Cargo & Passengers Safely', '8%'], ['Doubles/Triples & Tank Vehicles', '5%']],
  },
  {
    examType: 'mt_cdl',
    title: 'Montana CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/mt',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by Montana MVD)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Not Independently Published by Montana MVD)',
    description: 'Practice questions covering the Montana Commercial Driver License Manual (Montana Department of Justice, Motor Vehicle Division (MVD), base AAMVA \'Modernized Testing System\' content, Version: July 2017, with Montana-specific front matter revised June 2026): CDL licensing (Class A/B/C vehicle classifications, the manual\'s six knowledge-test endorsements, restrictions, and disqualification penalties), driving safely, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, school bus endorsement content, vehicle inspection, and basic control/on-road driving. Neither the Montana-specific front matter (pages MT-1 through MT-8) nor the AAMVA base manual text states an exact knowledge-test question count or number-correct-to-pass for any Montana CDL test -- only the federally standardized 80% minimum passing score (49 CFR 383.135(a)) is confirmed. Third-party CDL test-prep aggregators converge on the same 50-question/40-correct format used by every other CDL-track state on this site, so this practice exam follows that convention.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '31%'], ['Driving Safely (General Safe Driving Practices)', '21%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '22%'], ['Hazardous Materials', '16%'], ['School Bus', '10%']],
  },
  {
    examType: 'nd_cdl',
    title: 'North Dakota CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/nd',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by NDDOT)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Not Independently Published by NDDOT)',
    description: 'Practice questions covering the North Dakota 2025-2027 Commercial Driver License Manual, Class A, B and C (AAMVA \'2005 Model Commercial Driver License Manual\', Rev. July 2014 base content, with North Dakota-specific front matter), published by the North Dakota Department of Transportation (NDDOT) Driver License Division: CDL licensing (Class A/B/C/D/M license types, H/N/P/T/S endorsements, and North Dakota\'s own E/K/L/M/N/O/P/V/X/Z restriction codes), driving safely, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, school bus endorsement content, and vehicle inspection and basic control/on-road driving -- the latter uniquely covering both North Dakota\'s legacy skills-test content and the new "Modernized Commercial Driver License Skills Test" the state began phasing in December 1, 2025, which changes the airbrake check, vehicle inspection, and basic control portions with real, distinct procedural differences (e.g. the modernized air brake check\'s low-air warning activates below 55 psi versus the legacy test\'s 60 psi threshold). North Dakota\'s own manual never discloses an exact knowledge-test item count or number-correct-to-pass anywhere in its text, so this practice exam follows the federally standardized 50-question/40-correct (80%) AAMVA/FMCSA format (49 CFR 383.135(a)) used by every other CDL-track state.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '32%'], ['Driving Safely (General Safe Driving Practices)', '18%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '24%'], ['Hazardous Materials', '16%'], ['School Bus', '10%']],
  },
  {
    examType: 'ne_cdl',
    title: 'Nebraska CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ne',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by Nebraska DMV)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Not Independently Published by Nebraska DMV)',
    description: 'Practice questions covering the Nebraska Commercial Driver\'s License Manual (Nebraska Department of Motor Vehicles, AAMVA 2005 CDL Testing System / Modernized Testing System content, base Version: September 9, 2022 for Sections 1-2, July 2017 for most other sections, with Vehicle Inspection and Basic Control Skills modernized to March 2025, cover page Version: March 2025 (March 2026)): CDL licensing (Class A/B/C license types, Nebraska\'s six endorsements and nine restriction codes, disqualification penalties, and the ELDT and CLP/CDL testing requirements laid out in the manual\'s Nebraska Specifics front matter), driving safely, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, school bus endorsement content, vehicle inspection, and basic control/on-road driving. The manual -- including its 11-page Nebraska Specifics insert -- never states an exact knowledge-test question count or number-correct-to-pass anywhere in the fetched text; only the federally standardized 80% minimum passing score (49 CFR 383.135(a)) is confirmed, so this practice exam follows the same 50-question/40-correct format used by every other CDL-track state on this site.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '30%'], ['Driving Safely, Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '46%'], ['Hazardous Materials', '17%'], ['School Bus', '7%']],
  },
  {
    examType: 'nh_cdl',
    title: 'New Hampshire CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/nh',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by New Hampshire DMV)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Not Independently Published by New Hampshire DMV)',
    description: 'Practice questions covering the New Hampshire Commercial Driver\'s License Manual (New Hampshire Division of Motor Vehicles, NH Department of Safety, AAMVA Modernized Testing System base content, cover Version: September 9, 2022) and its companion Commercial Driver\'s License Manual Supplement for Modernized Version (Version: September 9, 2022, Section 12M carrying an additional Update 2/9/2024 revision): CDL licensing (Class A/B/C license types, the manual\'s six knowledge-test endorsements, restrictions, and disqualification penalties), driving safely, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, school bus endorsement content, vehicle inspection, and basic control/on-road driving. Neither the base manual, the supplement, nor the New Hampshire DMV\'s Commercial Driver Licenses and CDL Road Test webpages state an exact knowledge-test question count or number-correct-to-pass for any New Hampshire CDL test; several third-party CDL test-prep sites converge on a 50-question/40-correct (80%) General Knowledge test, but this is not confirmed by any official New Hampshire source. What is confirmed is the federally standardized 80% minimum passing score (49 CFR 383.135(a)) that applies to every state\'s CDL knowledge tests, so this practice exam follows that same 50-question/40-correct format used by every other CDL-track state.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '28%'], ['Driving Safely (General Safe Driving Practices)', '25%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '21%'], ['Hazardous Materials', '18%'], ['School Bus', '8%']],
  },
  {
    examType: 'nj_cdl',
    title: 'New Jersey CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/nj',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the New Jersey Commercial Driver\'s License Manual (New Jersey Motor Vehicle Commission, base AAMVA \'Modernized Testing System\' content, cover Version: March 2025, most sections Version: July 2017, Section 11 Vehicle Inspection modernized to Version: March 2025): CDL licensing, vehicle inspection, and basic control/on-road driving; transporting cargo and passengers safely; air brakes, combination vehicles, doubles/triples, and tank vehicles; hazardous materials (including a dedicated loading/unloading and Do Not Load table subsection); and school bus endorsement content. Unlike most other states built in this project, New Jersey\'s own official MVC website -- not just the manual -- directly confirms real exam mechanics: the official page nj.gov/mvc/drivertopics/cdltest.htm states the knowledge test is a 50-question general test and you must answer at least 80% of the questions correctly to pass, with additional separate tests for each endorsement. Per-endorsement knowledge-test item counts (air brakes, combination, doubles/triples, hazmat, passenger, school bus, tank) are not disclosed by the official source and remain unconfirmed.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '29%'], ['Driving Safely (General Safe Driving Practices)', '26%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '22%'], ['Hazardous Materials', '16%'], ['School Bus', '7%']],
  },
  {
    examType: 'nm_cdl',
    title: 'New Mexico CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/nm',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Item Count Not Independently Published by NM MVD)', passScore: '40/50 Correct (80% -- CONFIRMED Directly in the NM CDL Manual: \'A passing score is 80% or higher\')',
    description: 'Practice questions covering the New Mexico Commercial Driver License Manual (base AAMVA \'2005 CDL Testing System\' content, Version: July 2017), published by the New Mexico Motor Vehicle Division (MVD), a division of the New Mexico Taxation and Revenue Department: CDL licensing -- including New Mexico\'s non-standard four-class A/B/C/D system, where Class D is a state-specific class covering hazmat-placarded vehicles under 26,000 lbs GVWR or vehicles designed to carry 16+ passengers, layered onto the base manual\'s federal three-class framework -- vehicle inspection, and basic control/on-road driving; driving safely; transporting cargo and passengers safely; air brakes, combination vehicles, doubles/triples, and tank vehicles; hazardous materials; and school bus endorsement content. New Mexico\'s own MVD-11196 licensing addendum directly and explicitly confirms the passing score in its front matter -- \'A passing score is 80% or higher\' -- but the exact number of items per knowledge test is not disclosed anywhere in the official New Mexico manual or addendum text, so this practice exam follows the same 50-question AAMVA/federal-standard format used by every other CDL-track state.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control & Cargo/Passenger Safety', '29%'], ['Driving Safely (General Safe Driving Practices)', '18%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '24%'], ['Hazardous Materials', '18%'], ['School Bus', '11%']],
  },
  {
    examType: 'nv_cdl',
    title: 'Nevada CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/nv',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by Nevada DMV)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Not Independently Published by Nevada DMV)',
    description: 'Practice questions covering the Nevada Commercial Driver\'s License Manual (Nevada Department of Motor Vehicles, AAMVA-authored base content, Modernized/2005 CDL Testing System, Version: July 2017 for Sections 1-10 and 12-13, with Section 11 Vehicle Inspection Test revised to AAMVA\'s newer itemized checklist format dated September 9, 2022): CDL licensing (Class A/B/C license types, the manual\'s six knowledge-test endorsements, restrictions, and disqualification penalties), driving safely, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, school bus endorsement content, vehicle inspection, and basic control/on-road driving. The Nevada DMV manual does not state an exact knowledge-test question count or number-correct-to-pass for any Nevada CDL test; what is confirmed is the federally standardized 80% minimum passing score (49 CFR 383.135(a)) that applies to every state\'s CDL knowledge tests, so this practice exam follows that same 50-question/40-correct format used by every other CDL-track state.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '25%'], ['Driving Safely (General Safe Driving Practices)', '28%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '22%'], ['Hazardous Materials', '18%'], ['School Bus', '7%']],
  },
  {
    examType: 'ok_cdl',
    title: 'Oklahoma CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ok',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Oklahoma Commercial Driver\'s License Manual (Service Oklahoma, AAMVA Modernized Testing System base content, cover-stamped Version: March 2025, with Section 11 Vehicle Inspection independently updated to Oklahoma\'s own modernized March 2025 CDL skills-test checklist): CDL licensing, vehicle inspection, and basic control/on-road driving; transporting cargo and passengers safely; air brakes, combination vehicles, doubles/triples, and tank vehicles; hazardous materials; and school bus endorsement content. Oklahoma\'s exam mechanics are confirmed directly from Oklahoma Administrative Code Section 260:135-5-166 (Written Examination): the General Knowledge test is a minimum of 50 questions, the Class A Combination Vehicles test is a minimum of 20 questions, Air Brakes is 25 questions, the Passenger, Tank, School Bus, and Doubles/Triples endorsement tests are each 20 questions, and Hazardous Materials is 30 questions -- every test requires at least 80% correct to pass. Service Oklahoma now administers CDL knowledge and skills testing statewide after CDL rulemaking transferred from the former Department of Public Safety in 2022.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '31%'], ['Driving Safely (General Safe Driving Practices)', '20%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '24%'], ['Hazardous Materials', '17%'], ['School Bus', '8%']],
  },
  {
    examType: 'or_cdl',
    title: 'Oregon CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/or',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format; Oregon\'s Real Exam Is Computer-Adaptive With No Fixed Item Count)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Not Independently Published by ODOT DMV)',
    description: 'Practice questions covering the Oregon Commercial Driver License Manual (Oregon Department of Transportation, Driver and Motor Vehicle Services Division, AAMVA Modernized Testing System base content, Version: March 2025): CDL licensing (Class A/B/C license types, Oregon\'s six knowledge-test endorsements -- H, N, P, T, X, S -- restrictions, ELDT requirements, and disqualification penalties), driving safely, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, school bus endorsement content, vehicle inspection, and basic control/on-road driving. Oregon\'s own manual states that commercial knowledge tests are given on a touch-screen and are terminated once enough questions have been answered to determine a pass or fail -- a computer-adaptive design with no fixed, officially published item count for any Oregon CDL knowledge test, general or endorsement -- and the manual never states a passing-score percentage anywhere in its text. Because of this structural absence of an official test length or score threshold, this practice exam instead follows the conventional 50-question/80%-passing AAMVA/federal-standard format used across this project\'s other CDL-track states, consistent with the federally standardized 80% minimum passing score required under 49 CFR 383.135(a).',
    breakdown: [['CDL Licensing, Vehicle Inspection & Basic Control/On-Road Driving', '23%'], ['Driving Safely (General Safe Driving Practices)', '23%'], ['Cargo & Passenger Safety', '8%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '23%'], ['Hazardous Materials', '15%'], ['School Bus', '8%']],
  },
  {
    examType: 'ri_cdl',
    title: 'Rhode Island CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ri',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Rhode Island Commercial Driver License Manual (Rhode Island Division of Motor Vehicles (RI DMV), base AAMVA 2005 CDL Testing System content, Version: July 2014): CDL licensing and eligibility, vehicle inspection, and basic control/on-road driving; driving safely; transporting cargo and passengers safely; air brakes, combination vehicles, doubles/triples, and tank vehicles; hazardous materials; and school bus endorsement content. Rhode Island\'s manual is unusually thorough in disclosing real exam mechanics -- an explicit front-matter chart titled \'Test / Total Questions / Needed to Pass / Passing Percentage\' confirms every single test type by name: the General Knowledge test is 50 questions/40 to pass, Air Brakes is 25/20, Hazardous Materials is 30/24, and Combination Vehicles, Tankers, Passenger, Doubles/Triples, and School Bus are each 20/16 -- with at least 80% correct required to pass every test, matching the federal minimum under 49 CFR 383.135(a).',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '29%'], ['Driving Safely (General Safe Driving Practices)', '18%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '23%'], ['Hazardous Materials', '20%'], ['School Bus', '10%']],
  },
  {
    examType: 'sc_cdl',
    title: 'South Carolina CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/sc',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Item Count Not Independently Published by SCDMV)', passScore: '40/50 Correct (80% -- CONFIRMED Directly in the SC CDL Manual)',
    description: 'This 681-question South Carolina CDL practice bank is built directly from the South Carolina Commercial Driver License Manual (Version: March 2025, AAMVA "2005 CDL Testing System" base content), published by the South Carolina Department of Motor Vehicles (SCDMV), and covers every core section drivers need for the General Knowledge test and all major endorsements: Licensing/Application Procedures, Driving Safely, Transporting Cargo and Passengers Safely, Air Brakes, Combination Vehicles, Doubles/Triples, Tank Vehicles, Hazardous Materials, School Bus, and both the Vehicle Inspection and Basic Control/On-Road skills tests. South Carolina\'s manual directly confirms an 80% passing score requirement for its knowledge tests, but unlike states such as Rhode Island it never publishes a specific per-test item count, so this practice exam follows the federally standardized 50-question/40-correct AAMVA/FMCSA format (49 CFR 383.135(a)) used across this project\'s other CDL-track states. Every question is grounded in a specific passage of the official SCDMV manual text, with numeric specifications such as air brake PSI thresholds and school bus danger-zone distances independently spot-checked against that source.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '32%'], ['Driving Safely (General Safe Driving Practices)', '21%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '23%'], ['Hazardous Materials', '16%'], ['School Bus', '8%']],
  },
  {
    examType: 'sd_cdl',
    title: 'South Dakota CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/sd',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the South Dakota Commercial Driver License Manual (South Dakota Department of Public Safety, base AAMVA \'2005 CDL Testing System\' content, Version: July 2014): CDL licensing, vehicle inspection, and basic control/on-road driving; transporting cargo and passengers safely; air brakes, combination vehicles, doubles/triples, and tank vehicles; hazardous materials; and school bus endorsement content. South Dakota\'s manual is unusually thorough in disclosing its own exam mechanics directly in its \'What is Considered a Passing Score?\' section: the General Knowledge test is 50 questions, Air Brakes is 25, Combination Vehicles is 20, Passenger Transport is 20, Doubles/Triples is 20, Tank Vehicles is 20, Hazardous Materials is 30, and School Bus is 20 -- every test requires a score of 80% or better to pass.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '27%'], ['Driving Safely (General Safe Driving Practices)', '24%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '25%'], ['Hazardous Materials', '15%'], ['School Bus', '9%']],
  },
  {
    examType: 'tn_cdl',
    title: 'Tennessee CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/tn',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by TN DOSHS)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Not Independently Published by TN DOSHS)',
    description: 'Practice questions covering the Tennessee Commercial Driver License Manual (Tennessee Department of Safety and Homeland Security, base AAMVA 2005 CDL Testing System content, Version: July 2017, TDOSHS reprint/authorization May 2022): CDL licensing (Class A/B/C license types, the manual\'s six knowledge-test endorsements, restrictions, and disqualification penalties), driving safely, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, school bus endorsement content, vehicle inspection, and basic control/on-road driving. Neither the fetched official Tennessee manual nor the official TN CDL Division webpage (tn.gov/safety/driver-services/commercial-driver-license.html) discloses an exact knowledge-test question count or number-correct-to-pass for any Tennessee CDL test; third-party CDL test-prep aggregators converge on a conventional 50-question/40-correct format, but that figure is not asserted as an officially confirmed Tennessee figure. What is confirmed directly from Tennessee\'s own sources is the federally standardized 80% minimum passing score (49 CFR 383.135(a)) that applies to every state\'s CDL knowledge tests, so this practice exam follows that same 50-question/40-correct format used by every other CDL-track state.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '31%'], ['Driving Safely (General Safe Driving Practices)', '20%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '24%'], ['Hazardous Materials', '15%'], ['School Bus', '10%']],
  },
  {
    examType: 'ut_cdl',
    title: 'Utah CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/ut',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Item Count Not Independently Published by Utah DLD)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Not Independently Published by Utah DLD)',
    description: 'Practice questions covering the Utah Commercial Driver\'s License Handbook (2025 Edition, base AAMVA \'Modernized Testing System\' content, cover page stamped Version: March 2025) published by the Utah Driver License Division (DLD) -- a division of the Utah Department of Public Safety, distinct from Utah\'s DMV, which handles only vehicle/vessel registration and titling. Covers CDL licensing, vehicle inspection, and basic control/on-road driving; transporting cargo and passengers safely; air brakes, combination vehicles, doubles/triples, and tank vehicles; hazardous materials; and school bus endorsement content. Two official dld.utah.gov pages independently confirm that the Hazardous Materials (H) endorsement written knowledge test is 30 questions and the Tank Vehicle (N) endorsement written knowledge test is 20 questions, but neither the manual nor the DLD website discloses a General Knowledge item count or passing percentage, so that portion of this practice exam follows the federally standardized 50-question/80%-passing AAMVA/FMCSA format.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '31%'], ['Driving Safely (General Safe Driving Practices)', '19%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '25%'], ['Hazardous Materials', '15%'], ['School Bus', '10%']],
  },
  {
    examType: 'vt_cdl',
    title: 'Vermont CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/vt',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by VT DMV)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Not Independently Published by VT DMV)',
    description: 'Practice questions covering the Vermont Commercial Driver\'s Manual (Form VN-111, AAMVA 2005 CDL Testing System base content, Version: July 2017, with Vermont-specific front matter dated January 2024), published by the Vermont Agency of Transportation, Department of Motor Vehicles: CDL licensing and fees, age requirements, exemptions and medical self-certification (Section 1), general safe driving practices and driving emergencies/hazardous materials rules for all drivers (Section 2), transporting cargo and passengers safely (Sections 3-4), air brakes, combination vehicles, doubles/triples, and tank vehicles (Sections 5-8), hazardous materials endorsement content including the TSA Security Threat Assessment process (Section 9), Vermont\'s School Bus endorsement -- including its 8-hour classroom clinic requirement (Section 10 plus Vermont-specific front matter), vehicle inspection (Section 11), and basic vehicle control and on-road driving skills (Sections 12-13). Neither the Vermont-specific front matter nor the AAMVA base manual discloses a specific number of items per knowledge test or an explicit passing-score percentage anywhere in the manual, and neither the official Vermont DMV CDL nor CLP webpages state one either; the federally standardized minimum passing score of 80% under 49 CFR 383.135(a) applies regardless, so this practice exam follows the same 50-question/40-correct format used by every other hedged-mechanics CDL state in this project.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '33%'], ['Driving Safely (General Safe Driving Practices)', '21%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '24%'], ['Hazardous Materials', '13%'], ['School Bus', '9%']],
  },
  {
    examType: 'wi_cdl',
    title: 'Wisconsin CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/wi',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Not Independently Published by WisDOT)', passScore: '40/50 Correct (80% -- Federally Standardized Minimum per 49 CFR 383.135(a), Not Independently Published by WisDOT)',
    description: 'Practice questions are drawn directly from the Wisconsin Commercial Driver\'s Manual (May 2026 edition), published by the Wisconsin Department of Transportation (WisDOT) Division of Motor Vehicles, covering General Knowledge topics -- vehicle inspection, basic vehicle control, and on-road driving, cargo and passenger safety, air brakes, combination vehicles, doubles/triples, tank vehicles, hazardous materials, and school buses -- plus Wisconsin-specific CDL classes (A, B, C), endorsements (S, P, H, N, T, F), and restriction codes. No official Wisconsin source discloses a knowledge-test item count or passing percentage for the CDL applicant exam; the only official WisDOT document stating an explicit 80% figure applies to the separate CDL instructor licensing exam, not the driver knowledge test. This practice exam therefore follows the federally standardized 50-question/80%-correct AAMVA/FMCSA format used across CDL-track states in this project.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '31%'], ['Driving Safely (General Safe Driving Practices)', '20%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '23%'], ['Hazardous Materials', '16%'], ['School Bus', '10%']],
  },
  {
    examType: 'wv_cdl',
    title: 'West Virginia CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/wv',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Item Count Not Independently Published by WV DMV)', passScore: '40/50 Correct (80% -- CONFIRMED Directly in the WV CDL Manual)',
    description: 'Practice questions covering the West Virginia Commercial Driver\'s License Manual (West Virginia Department of Transportation, Division of Motor Vehicles, WV-specific front matter Rev. 08/2023 layered onto the AAMVA-authored 2005 CDL Testing System base manual, Version: July 2017): CDL licensing (Class A/B/C/D license types -- Class D being WV\'s own non-commercial-vehicles-for-hire category -- the manual\'s six CDL knowledge-test endorsements H/N/P/T/S/X, ten WV-specific restriction codes, and disqualification penalties), driving safely, transporting cargo and passengers safely, air brakes and combination vehicles, doubles/triples and tank vehicles, hazardous materials, school bus endorsement content, vehicle inspection, and basic control/on-road driving. The WV-specific front matter\'s own Knowledge Test section states directly and unambiguously that \'the knowledge test must be taken and passed, with at least an 80% score\' -- so unlike several other CDL-track states in this project, West Virginia\'s 80% passing score is CONFIRMED directly from an official WV.gov source rather than only assumed via the federal standard. What is not stated anywhere in the WV-specific front matter or the AAMVA base manual is an exact knowledge-test question count -- the manual\'s own CDL Fee Chart describes knowledge testing only in terms of \'three (3) attempts\' per fee, never a per-attempt item count -- so this practice exam follows the same 50-question/40-correct federally standardized AAMVA/FMCSA format (49 CFR 383.135(a)) used by every other CDL-track state in this project.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '26%'], ['Driving Safely (General Safe Driving Practices)', '21%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '27%'], ['Hazardous Materials', '16%'], ['School Bus', '10%']],
  },
  {
    examType: 'wy_cdl',
    title: 'Wyoming CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', route: '/cdl/wy',
    duration: '60 Minutes', questions: '50 Multiple Choice (General Knowledge -- AAMVA/Federal-Standard Format, Item Count Not Independently Published by WYDOT)', passScore: '40/50 Correct (80% -- CONFIRMED Directly in the Wyoming CDL Manual and on WYDOT\'s Live CDL Testing Page)',
    description: 'Practice questions covering the Wyoming Commercial Driver License Manual -- "Rules of the Road: Driver License Manual, Commercial & Heavy Vehicles 2024" (base AAMVA Version 05 content adapted for Wyoming, dated October 2024), published by the Wyoming Department of Transportation (WYDOT) Driver Services Program: CDL licensing and Wyoming-specific requirements (restriction codes, ELDT, fees, traffic-stop procedures), driving safely (vehicle inspection through mountain driving, driving emergencies, and hazardous materials rules for all drivers), transporting cargo and passengers safely, air brakes, combination vehicles, doubles/triples, and tank vehicles, hazardous materials, school bus endorsement content (including citations to Wyoming Statutes W.S. 31-5-929(b) and W.S. 31-5-507(b) for warning-light and roadway-position rules), and vehicle inspection/basic control/on-road driving, drawing on both the manual\'s original AAMVA-format sections and their "Modernized" replacements. Wyoming\'s manual directly states in its Wyoming-specific front matter that "the passing score for a written test is 80 percent," and this figure was independently re-confirmed on WYDOT\'s live CDL Testing webpage -- but neither source, nor WYDOT\'s CDL Class Information page, discloses an exact per-test item count, so this practice exam follows the same 50-question/40-correct AAMVA/FMCSA-standard format used by every other CDL-track state on this site.',
    breakdown: [['CDL Licensing, Vehicle Inspection, Basic Control/On-Road & Cargo/Passenger Safety', '29%'], ['Driving Safely (General Safe Driving Practices)', '21%'], ['Air Brakes, Combination Vehicles, Doubles/Triples & Tank Vehicles', '25%'], ['Hazardous Materials', '16%'], ['School Bus', '9%']],
  },
];

// Real, DB-backed identity (examKind/stateCode/shortName/active, plus mechanics fields not
// currently rendered anywhere) merged onto HUB_EXAMS_CONTENT above -- see loadTrackRegistry() and
// boot()'s Promise.all. Starts empty; boot() populates it before the first route() call, same
// "gate first render on a small async fetch" pattern loadSiteConfig() already established for the
// inactive-track override. Object.assign order (registry first, then content) means content never
// shadows an identity field even though both objects happen to carry the same examType value.
var HUB_EXAMS = [];

function buildHubExams(registryTracks) {
  var contentByType = {};
  HUB_EXAMS_CONTENT.forEach(function (c) { contentByType[c.examType] = c; });
  return registryTracks.map(function (r) {
    return Object.assign({}, r, contentByType[r.examType] || {});
  });
}

var trackRegistryPromise = null;
function loadTrackRegistry() {
  if (!trackRegistryPromise) {
    trackRegistryPromise = apiFetch('/track-registry').then(function (res) {
      HUB_EXAMS = buildHubExams((res && res.tracks) || []);
    });
  }
  return trackRegistryPromise;
}

// Display name for each HUB_EXAMS stateCode -- 'US' covers genuinely national (non-state-specific)
// tracks like MLO, shown as its own filter option rather than lumped into "All" invisibly. Add an
// entry here whenever a new state's first track is added (e.g. TX, FL, NY).
var STATE_LABELS = { CA: 'California', TX: 'Texas', FL: 'Florida', NY: 'New York', IL: 'Illinois', PA: 'Pennsylvania', OH: 'Ohio', GA: 'Georgia', NC: 'North Carolina', VA: 'Virginia', MI: 'Michigan', WA: 'Washington', AK: "Alaska", AL: "Alabama", AR: "Arkansas", AZ: "Arizona", CO: "Colorado", CT: "Connecticut", DE: "Delaware", HI: "Hawaii", IA: "Iowa", ID: "Idaho", IN: "Indiana", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", MA: "Massachusetts", MD: "Maryland", ME: "Maine", MN: "Minnesota", MO: "Missouri", MS: "Mississippi", MT: "Montana", ND: "North Dakota", NE: "Nebraska", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NV: "Nevada", OK: "Oklahoma", OR: "Oregon", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", UT: "Utah", VT: "Vermont", WI: "Wisconsin", WV: "West Virginia", WY: "Wyoming", US: 'National' };

// URL-safe slug per examKind, for state-scoped routes like /oh/driver -- kept as an explicit map
// rather than a generic slugify() so an examKind's display text (e.g. "Commercial Driver (CDL)")
// can diverge from its URL slug ("cdl") without the URL getting ugly or the two silently drifting
// if the display label is ever reworded.
var HUB_KIND_SLUGS = {
  'Real Estate Salesperson': 'real-estate-salesperson',
  'Real Estate Broker': 'real-estate-broker',
  'Driver': 'driver',
  'Commercial Driver (CDL)': 'cdl',
  'Motorcycle': 'motorcycle',
  'Boating': 'boating',
  'Notary': 'notary',
  'Mortgage Loan Origination': 'mlo',
};
function kindSlug(kind) { return HUB_KIND_SLUGS[kind] || kind.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
function kindFromSlug(slug) {
  for (var k in HUB_KIND_SLUGS) { if (HUB_KIND_SLUGS[k] === slug) return k; }
  return '';
}

// A pathname's first segment is only ever treated as a state route if it's a stateCode that
// genuinely has at least one HUB_EXAMS entry -- guards against e.g. some future 2-letter track
// examType prefix or a stray typo'd path silently rendering as an (empty) state page.
function knownStateCode(code) {
  if (!code) return null;
  var upper = code.toUpperCase();
  return HUB_EXAMS.some(function (e) { return e.stateCode === upper; }) ? upper : null;
}

// Written by app.js only when the visitor explicitly picks a state (category page's
// pick-category-state); read server-side by _worker.js to carry the visitor's state forward
// through an old-URL redirect (see its own comment) or, for a first-time "/" visit with no cookie
// yet, geolocation-derived. Also read back client-side now (getStateCookie(), below) by the
// category landing page to pre-select the visitor's state in its hero picker -- app.js didn't read
// this back at all before category-first routing removed the old per-state hub pages that used to
// make the URL itself the source of truth. Deliberately NOT written on every track-page visit --
// see the comment at its one remaining call site (pick-category-state) for why.
function setStateCookie(value) {
  document.cookie = 'pxq_state=' + encodeURIComponent(value) + '; path=/; max-age=31536000; SameSite=Lax';
}
function getStateCookie() {
  var match = document.cookie.match(/(?:^|;\s*)pxq_state=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
}

// Given a hub route string ('/notary', etc.), returns the matching ACTIVE track's HUB_EXAMS entry,
// or null. Inactive tracks use route:'#' (shared/non-unique) so they're deliberately excluded --
// only an active track can ever be matched to a real page.
function activeTrackForPath(pathname) {
  var matches = HUB_EXAMS.filter(function (e) { return e.active && e.route !== '#' && pathname.indexOf(e.route) === 0; });
  return matches.length ? matches[0] : null;
}
// exam_type naming convention: {state}_{category}, e.g. tx_driver, fl_notary -- national
// (non-state-specific) exams like the NMLS MLO stay unprefixed.
function trackByExamType(examType) {
  var matches = HUB_EXAMS.filter(function (e) { return e.examType === examType; });
  return matches.length ? matches[0] : null;
}

// Where a successful redeem should navigate to -- pulled out as its own pure function (used by the
// redeem-submit handler below) rather than inlined, so the destination can be tested directly
// without needing a real browser navigation to occur. See that handler's own comment for why this
// has to be a real navigation (a location.href assignment) at all, not just a hash change.
function redeemDestinationUrl(examType) {
  var track = trackByExamType(examType);
  return (track ? track.route : '') + '#/quiz';
}

// Per-track compliance/legal copy -- deliberately NOT auto-genericized from one template, since the
// underlying facts differ per track (who administers the real exam, what education/training
// requirement exists, if any). Add a real entry here before flipping a new track to active:true.
// TRACK_COMPLIANCE lived here as a ~573KB object literal covering all 285 tracks. Migrated to
// D1's `track_content` table 2026-09-05 and now loaded one track at a time -- see
// loadTrackContent()/trackCompliance() below, and GET /track-content in examprep-api.

// Per-track affiliation/disclaimer prose + official-source links, loaded one track at a time from
// GET /track-content (see that handler). Was two hardcoded objects here -- TRACK_COMPLIANCE (~573KB)
// and ADDITIONAL_INFO_LINKS (~153KB) -- shipping all 285 tracks' copies to every visitor on every
// page load, despite every read being a single [examType] lookup. Migrated to D1 2026-09-05, same
// pattern as the earlier RESOURCES migration.
var TRACK_CONTENT = {};
var trackContentPromises = {};

function loadTrackContent(examType) {
  if (!examType) return Promise.resolve(null);
  if (!trackContentPromises[examType]) {
    trackContentPromises[examType] = apiFetch('/track-content?examType=' + encodeURIComponent(examType))
      .then(function (res) {
        if (res && res.content) TRACK_CONTENT[examType] = res.content;
        return TRACK_CONTENT[examType] || null;
      })
      .catch(function () { return null; }); // best-effort -- callers fall back to the generic copy
  }
  return trackContentPromises[examType];
}

// The generic, deliberately agency-name-free copy the hub itself uses for pages with no single
// track. Used while a track's own content is still in flight, and if the fetch fails outright.
// NOT a fallback to some other real track's compliance text (the old code fell back to ca_notary's,
// which would have named California's agencies on, say, a Texas page had it ever actually fired).
function genericCompliance() {
  return {
    orgLine: HUB_FOOTER_ORG_LINE,
    footerRequirement: HUB_FOOTER_REQUIREMENT,
    termsParagraph2: HUB_TERMS_PARAGRAPH2,
    examIntroDisclaimer: 'register you for, or count toward, any official state licensing exam or required training.',
    passScoreNote: 'a practice approximation of the real exam\'s passing threshold',
    infoLinks: [],
  };
}

function trackCompliance(examType) {
  return TRACK_CONTENT[examType] || genericCompliance();
}

function trackInfoLinks(examType) {
  var c = TRACK_CONTENT[examType];
  return (c && c.infoLinks) || [];
}
// Resolves to the track that's actually relevant right now. When logged in, that's the account's
// OWN track (accountExamType, from /prefs) -- not state.examType, which only tracks whatever
// route is currently being VIEWED and is untouched by navigating to the plain hub, so a logged-in
// visitor browsing "/" would otherwise still read as whatever track state.examType last happened
// to be (see the accountExamType comment near its declaration for the full "logged into A, viewing
// B" bug class this mirrors). Falls back to state.examType when logged out (no account track to
// prefer). Null when neither resolves to a real active track. Callers must handle null explicitly,
// typically by sending the visitor to the tracks picker (/#tracks) rather than falling back to any
// particular track -- no track gets default or preferential treatment anywhere on the site.
// Persists across page loads (localStorage, same pattern as examprep_theme/examprep_font) --
// state.examType itself does NOT: it's an in-memory var that only gets set while route() is
// actually resolving a track's own pathname, and resets to '' on every fresh navigation (this
// site uses real <a href> page loads, not pushState). Without this, a visitor who clicks into a
// track, looks around, then goes back to the hub and clicks Refer/Sample would land back on the
// generic tracks picker instead of the track they were just looking at, purely because it's now a
// new page load. Only meant to steer someone who HASN'T bought/redeemed yet -- currentTrackOrNull()
// below only reaches this fallback when logged out (or logged in with no real account track).
var LAST_VIEWED_TRACK_KEY = 'examprep_last_track';
function rememberLastViewedTrack(examType) {
  try { localStorage.setItem(LAST_VIEWED_TRACK_KEY, examType); } catch (ignored) { /* private browsing, etc. */ }
}
function lastViewedTrackExamType() {
  try { return localStorage.getItem(LAST_VIEWED_TRACK_KEY) || ''; } catch (ignored) { return ''; }
}

function currentTrackOrNull() {
  var examType = (getToken() && accountExamType) ? accountExamType : (state.examType || lastViewedTrackExamType());
  var current = trackByExamType(examType);
  return (current && current.active) ? current : null;
}

// hubScopedState is still meaningful (which state a currently-viewed track belongs to -- see
// route(), renderSiteFooter()) even though category-first routing removed the per-state hub page
// that originally made it a URL-derived filter, and removed the header's own state picker (the
// category landing page's own picker replaced it -- see categoryStateSelectHtml()).
var hubScopedState = null;

// Smaller catalog card (Round 2 redesign decision): category/name/state/price/CTA only -- full
// stats, breakdown, and buy details now live on the track's own page instead of duplicating them
// here, since every track now has a real detail surface to click through to.
// mode: 'normal' (default, hub grid) or 'gift' (#/gift landing page) -- gift mode is only ever
// called with already-active tracks (nothing to gift that isn't purchasable), so it skips the
// now-redundant "Active" status badge and points the CTA at that track's buy page in gift mode
// (#/buy-gift) instead of the track's own sales/landing page.
function hubTrackCards(tracks, mode) {
  var isGift = mode === 'gift';
  return (tracks || HUB_EXAMS).map(function (exam) {
    var statusBadge = exam.active
      ? '<span class="status-badge active"><span class="pulse-dot"></span>Active</span>'
      : '<span class="status-badge">Coming Soon</span>';
    var priceHtml = exam.active
      ? '<span class="exam-track-price" data-price-for="' + exam.examType + '">…</span>'
      : '<span class="exam-track-price muted">—</span>';
    var body = '<div class="exam-track-body">' +
      '<div class="exam-track-top"><span class="badge">' + exam.category + '</span>' + (isGift ? '' : statusBadge) + '</div>' +
      // shortName already leads with the state name (e.g. "Georgia Driver") -- a separate state
      // line was pure redundancy, dropped in favor of pairing the title with price on one row.
      '<div class="exam-track-title-row"><h3>' + escapeHtml(exam.shortName || exam.title) + '</h3>' + priceHtml + '</div>' +
      (exam.active ? '<div class="exam-track-resources muted">📚 ' + resourceInventorySummary(exam.examType).compact + '</div>' : '') +
      '</div><div class="exam-track-footer">' +
      (exam.active ? '<span class="exam-track-view-link">' + (isGift ? '🎁 Gift this →' : 'View details →') + '</span>' : '<span class="muted exam-track-view-link">Coming soon</span>') +
      '</div>';
    return exam.active
      ? '<a class="exam-track-card is-active" href="' + (isGift ? exam.route + '#/buy-gift' : exam.route) + '">' + body + '</a>'
      : '<div class="exam-track-card">' + body + '</div>';
  });
}

// Fills in each visible active card's real price (a per-track /pricing fetch, same pattern as the
// buy page's "other tracks" strip -- loadOtherTracksPricing). Best-effort: a failed fetch just
// leaves that one card's price blank rather than blocking or erroring the whole grid.
function fillHubPricing(tracks) {
  (tracks || []).filter(function (e) { return e.active; }).forEach(function (t) {
    apiFetch('/pricing?examType=' + encodeURIComponent(t.examType)).then(function (p) {
      var el = document.querySelector('[data-price-for="' + t.examType + '"]');
      if (el) el.textContent = '$' + (p.priceCents / 100).toFixed(2);
    }).catch(function () {
      var el = document.querySelector('[data-price-for="' + t.examType + '"]');
      if (el) el.textContent = '';
    });
  });
}

// ---- #/gift landing page: category + state picker --------------------------
// Deliberately shows nothing until both are picked, rather than a browsable grid (scoped or not)
// -- gifting is a "I already know who this is for and what they need" action, not a browse-and-
// discover one, so a category+state picker gets to checkout in two choices instead of scrolling a
// grid of up to 211 cards. This also sidesteps the whole hubScopedState-based auto-scoping this
// page used to do (state picked here is a one-off "who am I gifting to," unrelated to whichever
// state the visitor themselves last viewed -- auto-scoping to that was confusing more often than
// it helped, e.g. landing here from your OWN state's page while gifting to someone in a different
// one). Deliberately its own self-contained picker state (not shared with anything else) --
// reuses hubTrackCards/fillHubPricing for the single resulting track's card since the card/pricing
// logic itself is identical, just gift-scoped (only active tracks, gift-mode CTA/link).
var giftPickedKind = '';
var giftPickedState = '';

function giftCategoryOptions() {
  var kinds = [];
  HUB_EXAMS.forEach(function (e) { if (e.active && kinds.indexOf(e.examKind) === -1) kinds.push(e.examKind); });
  return kinds.sort(function (a, b) { return a.localeCompare(b); });
}

// Only states that actually offer the picked category -- picking a category first and then
// narrowing the state dropdown to just its real options (rather than all 50 states regardless of
// category) makes an invalid combination impossible to select in the first place.
function giftTracksForKind(kind) {
  return HUB_EXAMS.filter(function (e) { return e.active && e.examKind === kind; })
    .sort(function (a, b) { return (STATE_LABELS[a.stateCode] || a.stateCode).localeCompare(STATE_LABELS[b.stateCode] || b.stateCode); });
}

function giftPickerHtml() {
  var kindOptions = ['<option value="">Choose a category…</option>'].concat(
    giftCategoryOptions().map(function (k) {
      return '<option value="' + escapeHtml(k) + '"' + (k === giftPickedKind ? ' selected' : '') + '>' + escapeHtml(k) + '</option>';
    })
  );
  var stateTracks = giftPickedKind ? giftTracksForKind(giftPickedKind) : [];
  var stateOptions = ['<option value="">Choose a state…</option>'].concat(
    stateTracks.map(function (t) {
      return '<option value="' + t.stateCode + '"' + (t.stateCode === giftPickedState ? ' selected' : '') + '>' +
        escapeHtml(STATE_LABELS[t.stateCode] || t.stateCode) + '</option>';
    })
  );
  return '<div class="card gift-picker">' +
    '<label class="gift-picker-field">Category' +
    '<select data-act="pick-gift-kind">' + kindOptions.join('') + '</select>' +
    '</label>' +
    '<label class="gift-picker-field">State' +
    '<select data-act="pick-gift-state"' + (giftPickedKind ? '' : ' disabled') + '>' + stateOptions.join('') + '</select>' +
    '</label>' +
    '</div>';
}

function giftResultHtml() {
  if (!giftPickedKind || !giftPickedState) return '';
  var track = HUB_EXAMS.filter(function (e) {
    return e.active && e.examKind === giftPickedKind && e.stateCode === giftPickedState;
  })[0];
  if (!track) return '<p class="muted">No gift-able track found for that combination yet.</p>';
  var cardHtml = hubTrackCards([track], 'gift')[0];
  fillHubPricing([track]);
  return '<div class="exam-track-grid category-single-track-grid">' + cardHtml + '</div>';
}

// ---- Category landing page (category-first restructure, phase 4) ----------
// One page per category (e.g. /notary), aggregating every state that offers it -- replaces the
// interim reuse of the unscoped hub view. Sections: hero (headline/subhead from admin-managed
// category_content, state picker), stats strip (real computed track/state counts + sitewide pass
// rate -- no per-category pass rate exists server-side, so this never fabricates one), feature
// tiles + testimonials (admin-managed, omitted entirely if not yet configured), state tracks grid
// (reuses hubTrackCards/fillHubPricing, same cards the old hub used), an interactive sample
// question, and a curriculum breakdown -- both sourced from one representative track (the
// visitor's own state if it offers this category, else the first active one), clearly labeled as
// state-specific rather than averaged/invented across states that don't actually share one
// breakdown.

var categoryPageState = { kind: null, tracks: [], repTrack: null };

// Shows the ONE track matching the visitor's currently-selected state (repTrack) -- not a
// browsable list of every state. The state picker in the hero (categoryStateSelectHtml) is how a
// visitor sees a different state's track; this section just reflects whichever one is selected.
// Reuses hubTrackCards's own card markup (a 1-element array) rather than a bespoke layout, so it
// looks identical to every other track card on the site.
// First sentence (or ~220 chars) of a track's full `description` -- those run long (built for the
// track landing page itself), too long for a card; the full text is still one click away via the
// card's own "View details" link and the page's breakdown section below.
function trackDescExcerpt(description) {
  if (!description) return '';
  var firstSentence = description.split(/(?<=[.!?])\s+/)[0];
  if (firstSentence.length <= 260) return firstSentence;
  return description.slice(0, 220).replace(/\s+\S*$/, '') + '…';
}

// Replaces the old compact hubTrackCards()-style card (badge/title/price/resource-count only, no
// real content) with the same rich icon+content card layout as the homepage's category cards
// (.category-nav-card -- icon badge, tinted points panel, full-width CTA button), filled with
// this specific state+category's OWN real data (duration/questions/passScore/description already
// exist per-track in HUB_EXAMS -- no new content needed, this was the compact-card's gap, not a
// content gap). 2026-08-31 visual pass, mirrors the homepage cards' final look.
function categoryCurrentTrackHtml() {
  var track = categoryPageState.repTrack;
  if (!track) return '<p class="muted">No states are live for this category yet — check back soon.</p>';
  fillHubPricing([track]);
  var points = [
    track.duration ? 'Format: ' + track.duration : '',
    track.questions ? track.questions : '',
    track.passScore ? 'Passing score: ' + track.passScore : '',
  ].filter(Boolean);
  return '<div class="exam-track-grid category-card-grid category-current-track-grid">' +
    '<div class="exam-track-card is-active category-nav-card">' +
    '<a class="category-nav-card-link" href="' + track.route + '">' +
    '<div class="exam-track-body">' +
    '<div class="category-nav-card-icon">' + (CATEGORY_ICONS[track.examKind] || '📚') + '</div>' +
    '<div class="category-nav-card-content">' +
    '<h3>' + escapeHtml(track.shortName || track.title) +
    ' <span class="exam-track-price" data-price-for="' + track.examType + '">…</span></h3>' +
    '<p class="category-nav-card-desc">' + escapeHtml(trackDescExcerpt(track.description)) + '</p>' +
    (points.length ? '<ul class="category-nav-card-points">' + points.map(function (p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('') + '</ul>' : '') +
    (track.active ? '<span class="category-nav-card-statecount"><span class="pulse-dot"></span> Active — start now</span>' : '') +
    '</div></div>' +
    '</a>' +
    // Quick-buy CTA (added 2026-09-02) -- lets an already-decided visitor skip straight to
    // checkout instead of going through the track detail page first (which is still the default
    // path via the card link above, and still matters for a first-time visitor who hasn't seen
    // sample questions/the guarantee yet). Navigates to the track's own route with #/buy appended
    // rather than just setting location.hash while staying on this category pathname -- #/buy is
    // only handled by renderTrackApp()'s dispatch, which route() only reaches once the pathname
    // itself has resolved to a real track (see the delegated click handler's own comment on this).
    '<div class="exam-track-footer category-nav-card-footer">' +
    '<a class="category-nav-card-link exam-track-view-link" href="' + track.route + '">View details &amp; pricing →</a>' +
    '<button type="button" class="btn-primary btn-sm" data-act="category-quick-buy" data-track-route="' + track.route + '">Buy now</button>' +
    '</div>' +
    '</div></div>';
}

function categoryActiveTracks(kind) {
  return HUB_EXAMS.filter(function (e) { return e.examKind === kind && e.active; });
}

// Prefers the visitor's own state (cookie) if it offers this category, else the first active
// track (HUB_EXAMS order, same "first active" fallback the footer's sample-tracks logic uses).
function pickRepresentativeTrack(tracks) {
  var cookieState = getStateCookie();
  if (cookieState) {
    var match = tracks.filter(function (t) { return t.stateCode === cookieState; })[0];
    if (match) return match;
  }
  return tracks[0] || null;
}

function categoryStateSelectHtml(tracks, selectedState) {
  var options = ['<option value="">Choose your state…</option>'].concat(
    tracks.slice().sort(function (a, b) { return (STATE_LABELS[a.stateCode] || a.stateCode).localeCompare(STATE_LABELS[b.stateCode] || b.stateCode); })
      .map(function (t) {
        return '<option value="' + t.stateCode + '"' + (t.stateCode === selectedState ? ' selected' : '') + '>' + escapeHtml(STATE_LABELS[t.stateCode] || t.stateCode) + '</option>';
      })
  );
  return '<label class="category-state-select-label">Select your state' +
    '<select class="category-state-select" data-act="pick-category-state">' + options.join('') + '</select></label>';
}

// "Notify me when my state launches" -- categoryStateSelectHtml() above only ever lists ACTIVE
// tracks, so there's otherwise no UI surface at all for a visitor whose state isn't built yet for
// this category. Collapsed by default (<details>) so it doesn't compete with the main state picker.
function categoryWaitlistPromptHtml(kind, tracks) {
  var activeCodes = {};
  tracks.forEach(function (t) { activeCodes[t.stateCode] = true; });
  var missing = Object.keys(STATE_LABELS).filter(function (code) { return !activeCodes[code]; })
    .sort(function (a, b) { return STATE_LABELS[a].localeCompare(STATE_LABELS[b]); });
  if (!missing.length) return '';
  var options = missing.map(function (code) { return '<option value="' + code + '">' + escapeHtml(STATE_LABELS[code]) + '</option>'; }).join('');
  return '<details class="category-waitlist-prompt">' +
    '<summary class="muted">Don\'t see your state? Get notified when it launches</summary>' +
    '<form data-act="waitlist-join" data-kind="' + escapeHtml(kind) + '" class="card">' +
    '<select name="stateCode" required><option value="">Choose your state…</option>' + options + '</select>' +
    '<input type="email" name="email" placeholder="you@example.com" required>' +
    '<button class="btn-secondary btn-sm" type="submit">Notify me</button>' +
    '</form>' +
    '</details>';
}

// Second hero CTA button: a direct link to the visitor's selected track's own details page
// (buy button, full pricing, full breakdown) instead of just scrolling to the single track card
// further down. Falls back to the old scroll-to-tracks behavior on the rare category with zero
// active tracks, where there's no track route to link to. Kept in its own wrap (like the
// tracks/breakdown wraps) so pick-category-state can refresh it without a full page re-render.
function categoryHeroTrackLinkHtml(track) {
  if (!track) return '<button class="btn-secondary hub-hero-btn" type="button" data-act="scroll-to-tracks">View Your Track</button>';
  return '<a class="btn-secondary hub-hero-btn" href="' + track.route + '">View full ' + escapeHtml(track.shortName || '') + ' track details →</a>';
}

function categoryFeatureTilesHtml(tiles) {
  if (!tiles || !tiles.length) return '';
  return '<section class="category-feature-tiles">' + tiles.map(function (t) {
    return '<div class="card category-feature-tile"><div class="category-feature-tile-icon">' + escapeHtml(t.icon || '') + '</div>' +
      '<h3>' + escapeHtml(t.title || '') + '</h3><p class="muted">' + escapeHtml(t.body || '') + '</p></div>';
  }).join('') + '</section>';
}

function categoryTestimonialsHtml(testimonials) {
  if (!testimonials || !testimonials.length) return '';
  return '<section class="category-testimonials">' +
    '<p class="section-eyebrow">What test-takers say</p><h2 class="comparison-heading">Passed on the first try</h2>' +
    '<div class="category-testimonial-grid">' + testimonials.map(function (t) {
      return '<div class="card category-testimonial-card"><p>“' + escapeHtml(t.quote || '') + '”</p><p class="muted category-testimonial-author">' + escapeHtml(t.author || '') + '</p></div>';
    }).join('') + '</div></section>';
}

function categoryBreakdownHtml(track) {
  if (!track || !track.breakdown || !track.breakdown.length) return '';
  return '<section class="category-breakdown">' +
    '<p class="section-eyebrow">Curriculum coverage</p>' +
    '<h2 class="comparison-heading">What\'s Inside the Question Bank</h2>' +
    '<p class="muted">Shown for ' + escapeHtml(STATE_LABELS[track.stateCode] || track.stateCode) + ' — exact topics and weighting vary by state.</p>' +
    '<div class="breakdown-list">' + track.breakdown.map(function (b) {
      var pct = parseInt(b[1], 10) || 0;
      return '<div class="breakdown-row"><div class="breakdown-row-top"><span>' + escapeHtml(b[0]) + '</span><span>' + escapeHtml(b[1]) + '</span></div>' +
        '<div class="breakdown-bar"><div class="breakdown-bar-fill pct-' + pct + '"></div></div></div>';
    }).join('') + '</div>' +
    '<div class="category-breakdown-cta"><a class="btn-secondary" href="' + track.route + '">See full ' + escapeHtml(track.shortName || '') + ' track details →</a></div>' +
    '</section>';
}

// Split out so pick-category-state can refresh it in step with the question itself -- it used to
// be baked into categorySampleWidgetHtml()'s one-time render, so picking a new state changed the
// sample question underneath it but left this subhead stuck on whichever state loaded the page.
function categorySampleSubheadHtml(track) {
  return escapeHtml(STATE_LABELS[track.stateCode] || track.stateCode) + ' ' + escapeHtml(track.examKind) + ' — no access code needed.';
}

function categorySampleWidgetHtml() {
  var track = categoryPageState.repTrack;
  if (!track) return '';
  // "Live" badge (added 2026-09-02) for consistency with the track landing page's identical
  // widget (trackLandingSampleWidgetHtml()) -- this page has no competing locked-mockup nearby to
  // disambiguate from, but the same real, answerable widget should look the same everywhere it
  // appears rather than only being labeled on one of its two surfaces.
  return '<section class="category-sample" id="category-sample">' +
    '<p class="section-eyebrow">Try before you buy</p>' +
    '<h2 class="comparison-heading">Interactive Sample Question <span class="badge locked-preview-badge-live">Live</span></h2>' +
    '<p class="muted" id="category-sample-subhead">' + categorySampleSubheadHtml(track) + '</p>' +
    '<div id="category-sample-question-wrap"><p class="muted">Loading…</p></div>' +
    '</section>';
}

async function loadCategorySampleQuestion() {
  var track = categoryPageState.repTrack;
  var wrap = document.getElementById('category-sample-question-wrap');
  if (!track || !wrap) return;
  try {
    var res = await apiFetch('/sample?examType=' + encodeURIComponent(track.examType));
    var q = (res.questions || [])[0];
    if (!q) { wrap.innerHTML = '<p class="muted">No sample available for this track yet.</p>'; return; }
    categoryPageState.sampleQuestion = q;
    categoryPageState.sampleSelected = null;
    categoryPageState.sampleAnswered = null;
    drawCategorySampleQuestion();
    var qNode = questionJsonLd(q);
    qNode['@context'] = 'https://schema.org';
    injectJsonLd('category-sample-jsonld', qNode);
  } catch (e) {
    wrap.innerHTML = '<p class="muted">Could not load a sample question. Try again shortly.</p>';
  }
}

function drawCategorySampleQuestion() {
  var wrap = document.getElementById('category-sample-question-wrap');
  var q = categoryPageState.sampleQuestion;
  var track = categoryPageState.repTrack;
  if (!wrap || !q) return;
  var answered = categoryPageState.sampleAnswered;
  var selected = categoryPageState.sampleSelected;
  var prefixes = ['A', 'B', 'C', 'D'];
  var choiceHtml = prefixes.map(function (k) {
    var cls = 'option-btn';
    if (answered) {
      if (k === q.correctChoice) cls += ' correct';
      else if (k === answered) cls += ' wrong';
    } else if (k === selected) {
      cls += ' selected';
    }
    return optionButtonHtml(k, q.choices[k], cls, 'data-act="category-sample-answer" data-choice="' + k + '"' + (answered ? ' disabled' : ''));
  }).join('');
  // Select-then-submit, not instant-reveal-on-click -- see drawSampleQuestion()'s own comment
  // (this is the same first-touch, anonymous-visitor reasoning, just for the category page's
  // inline widget instead of the standalone #/sample page). The button itself is always visible
  // once a question's up (disabled until a choice is selected) rather than only appearing after
  // selecting -- a button that doesn't exist yet gives no signal there's a submit step at all.
  var submitControl = !answered
    ? '<div class="nav-controls"><button class="btn-primary" type="button" data-act="category-sample-submit"' + (selected ? '' : ' disabled') + '>Submit Answer</button></div>'
    : '';
  var explanation = answered
    ? '<div class="explanation-box"><strong class="' + (answered === q.correctChoice ? 'result-correct' : 'result-incorrect') + '">' +
      (answered === q.correctChoice ? 'Correct.' : 'Incorrect.') + '</strong> ' + q.explanation + '</div>' +
      '<div class="nav-controls"><a class="btn-primary" href="' + track.route + '#/sample">Try more free questions →</a></div>'
    : '';
  // Card wraps only the question stem (topic/text/audio button), same as the real paid quiz
  // (drawQuestion()) and the standalone #/sample page (drawSampleQuestion()) -- choices/submit/
  // explanation sit outside it on the bare page background. Previously this widget (and the track
  // landing page's identical one) wrapped the WHOLE question including the answer choices in one
  // card, which was the actual site-wide inconsistency a user flagged: this widget was the outlier
  // against the two real quiz-taking surfaces, not the other way around.
  wrap.innerHTML = '<div class="card">' +
    '<div class="question-topic">' + escapeHtml(q.topic) + '</div><div class="question-text">' + escapeHtml(q.question) + '</div>' +
    '<div class="audio-actions"><button class="btn-secondary btn-sm" type="button" data-act="category-sample-listen">🔊 Read aloud</button></div>' +
    '</div>' +
    '<div class="options-grid">' + choiceHtml + '</div>' + submitControl + explanation;
}

function categoryStatsHtml(activeCount, stateCount, resourceStats) {
  var tiles = [
    { value: activeCount, label: 'State Tracks' },
    { value: stateCount, label: 'States Covered' },
  ];
  // Same "only show if real" rule as the homepage's own resource tiles (fillReadinessCard) -- many
  // categories (Driver/CDL/Motorcycle/Boating) have no Key Facts Digest content yet, and a bare
  // "0 Quick-Fact Tables" would read as a broken page, not an honest gap.
  if (resourceStats && (resourceStats.tables || resourceStats.decks)) {
    tiles.push({ value: resourceStats.tables, label: 'Quick-Fact Tables' });
    tiles.push({ value: resourceStats.decks, label: 'Flashcard Decks' });
  }
  return '<div class="hub-readiness-card">' +
    '<p class="hub-readiness-label"><span class="hub-hero-highlight">Real Coverage</span>, Not Marketing Copy</p>' +
    '<div class="hub-readiness-top-row">' +
    '<div class="outcome-tile hub-readiness-question-count" id="category-question-count-tile"></div>' +
    '<div class="hub-readiness-radial-wrap" id="category-stats-radial-wrap"></div>' +
    '</div>' +
    '<div class="hub-readiness-tiles">' + tiles.map(function (t) {
      return '<div class="outcome-tile"><div class="outcome-tile-value">' + Number(t.value || 0).toLocaleString() + '</div><div class="outcome-tile-label">' + t.label + '</div></div>';
    }).join('') +
    '</div></div>';
}

// Rendered separately from categoryStatsHtml() and only after loadSiteConfig() resolves (not at
// first paint) -- refundFailurePercent defaults to a placeholder 50 until then, and unlike the
// .js-refund-pct text spans elsewhere, an SVG arc's shape can't be live-patched after the fact, so
// painting it early risks silently freezing on a stale default for the rest of the pageview.
function fillCategoryStatsRadial() {
  var wrap = document.getElementById('category-stats-radial-wrap');
  if (wrap) wrap.innerHTML = radialProgressSvg(refundFailurePercent, { size: 108, strokeWidth: 10, label: 'Refund If You Fail', color: 'var(--highlight)' });
}

// Real per-category question-bank size, summed from the public /questions/counts endpoint (a
// per-exam_type breakdown) -- never a fabricated/estimated figure. Best-effort: the tile just
// stays empty (not a fake number) if the fetch fails.
async function fillCategoryQuestionCount(tracks) {
  var tile = document.getElementById('category-question-count-tile');
  if (!tile || !tracks.length) return;
  try {
    var res = await apiFetch('/questions/counts');
    var countByExamType = {};
    (res.counts || []).forEach(function (row) { countByExamType[row.exam_type] = row.count; });
    var total = tracks.reduce(function (sum, t) { return sum + (countByExamType[t.examType] || 0); }, 0);
    tile.innerHTML = '<div class="outcome-tile-value">' + total.toLocaleString() + '</div><div class="outcome-tile-label">Practice Questions<br>(across all states)</div>';
  } catch (e) { /* best-effort -- tile just stays empty */ }
}

async function renderCategoryPage(kind) {
  var slug = kindSlug(kind);
  var tracks = categoryActiveTracks(kind);
  var repTrack = pickRepresentativeTrack(tracks);
  categoryPageState = { kind: kind, tracks: tracks, repTrack: repTrack, sampleQuestion: null, sampleSelected: null, sampleAnswered: null, tracksExpanded: false };
  // hubScopedState drives the footer's "top state tracks" links (and the #/gift page) -- previously
  // forced null here unconditionally (see route()'s old comment), which meant the footer kept
  // showing its unscoped fallback (first-3-active-overall, in practice always California) no matter
  // what state the visitor had picked or was viewing on the category page itself. Sync it to the
  // page's own current track instead, same as a real track page already does.
  hubScopedState = repTrack ? repTrack.stateCode : null;
  renderSiteFooter();

  appEl.innerHTML = '<p>Loading…</p>';
  var content = null;
  try {
    var res = await apiFetch('/category-content?slug=' + encodeURIComponent(slug));
    content = (res.categories || [])[0] || null;
  } catch (e) { /* best-effort -- page still works with fallback copy */ }

  var headline = (content && content.hero_headline) || (kind + ' Exam Prep');
  var subhead = (content && content.hero_subhead) ||
    ('Practice questions for your state\'s ' + kind.toLowerCase() + ' exam, built from official handbooks. Instant access, no subscription.');
  var selectedState = repTrack ? repTrack.stateCode : '';

  appEl.innerHTML =
    renderNewsBanner() +
    '<div class="hub-hero">' +
    '<div class="hub-hero-copy">' +
    '<span class="section-eyebrow">' + escapeHtml(kind) + '</span>' +
    '<h1>' + escapeHtml(headline) + '</h1>' +
    '<p>' + escapeHtml(subhead) + '</p>' +
    '<div class="hub-trust-badges">' +
    '<span class="hub-trust-badge">✓ 2026 Handbook Aligned</span>' +
    '<span class="hub-trust-badge">✓ Voice-Enabled Practice</span>' +
    '<span class="hub-trust-badge">✓ Instant Access</span>' +
    // Reassurance early, ahead of asking the visitor to engage with the sample question below --
    // not a replacement for the full guaranteeCtaBandHtml() band, which stays at the bottom of the
    // page as the closing note. .js-refund-pct is patched by the loadSiteConfig() sweep already
    // running at the end of this function, same as every other refund-percent mention on the site.
    '<span class="hub-trust-badge">✓ <span class="js-refund-pct">' + refundFailurePercent + '</span>% Refund If You Fail</span>' +
    '</div>' +
    (tracks.length ? categoryStateSelectHtml(tracks, selectedState) : '') +
    categoryWaitlistPromptHtml(kind, tracks) +
    '<div class="hub-hero-cta">' +
    '<button class="btn-primary hub-hero-btn" type="button" data-act="scroll-to-category-sample">Try Free Sample</button>' +
    '<div id="category-hero-track-link-wrap">' + categoryHeroTrackLinkHtml(repTrack) + '</div>' +
    '</div>' +
    '</div>' +
    '<div id="category-stats-wrap">' + categoryStatsHtml(tracks.length, new Set(tracks.map(function (t) { return t.stateCode; })).size, aggregateResourceStats(tracks.map(function (t) { return t.examType; }))) + '</div>' +
    '</div>' +
    trustStripHtml() +
    categoryFeatureTilesHtml(content && content.featureTiles) +
    '<div class="hub-section-header" id="tracks"><h2>Your ' + escapeHtml(kind) + ' Track</h2></div>' +
    '<div id="category-tracks-grid-wrap">' + categoryCurrentTrackHtml() + '</div>' +
    categorySampleWidgetHtml() +
    '<div id="category-breakdown-wrap">' + categoryBreakdownHtml(repTrack) + '</div>' +
    '<p class="category-guide-link"><a href="/guides/' + kindSlug(kind) + '-requirements-by-state">See ' + escapeHtml(kind) + ' exam requirements for every state →</a></p>' +
    categoryTestimonialsHtml(content && content.testimonials) +
    guaranteeCtaBandHtml();

  if (repTrack) loadCategorySampleQuestion();
  fillCategoryQuestionCount(tracks);
  loadSiteConfig().then(function () {
    document.querySelectorAll('.js-refund-pct').forEach(function (el) { el.textContent = refundFailurePercent; });
    fillCategoryStatsRadial();
  });
}

var CATEGORY_ICONS = {
  'Notary': '📝', 'Driver': '🚗', 'Commercial Driver (CDL)': '🚛', 'Motorcycle': '🏍️',
  'Boating': '⛵', 'Real Estate Salesperson': '🏠', 'Real Estate Broker': '🏢',
  'Mortgage Loan Origination': '💰',
};

// Expanded description of who each category's practice tracks are for, shown on the homepage
// category card beneath the title. Falls back to a generic line for any future category added
// here without bespoke copy. Kept as general, broadly-true statements about the category rather
// than state-specific numbers (those live in each state's own track content) -- deliberately
// hedged ("often", "typically", "in most states") where the specifics genuinely vary by state.
var CATEGORY_DESCRIPTIONS = {
  'Notary': 'Prepare for your state’s notary public commissioning exam or application requirements -- the credential that lets you witness signatures and certify documents.',
  'Real Estate Salesperson': 'Study for your state’s entry-level real estate license -- the credential required before you can represent buyers and sellers in a transaction.',
  'Real Estate Broker': 'Study for your state’s broker-level licensing exam -- the upgrade credential needed to supervise agents or open your own brokerage.',
  'Driver': 'Practice your state’s learner’s permit or driver’s license knowledge test -- the written portion required before you can get behind the wheel on your own.',
  'Commercial Driver (CDL)': 'Prepare for your Commercial Driver’s License knowledge tests and endorsements -- the credential required to legally operate trucks and buses.',
  'Motorcycle': 'Study for your state’s motorcycle license or endorsement knowledge test -- the credential required to legally ride on public roads.',
  'Boating': 'Prepare for your state’s boating safety education exam or card requirement -- often mandatory before operating a powered vessel or PWC.',
};

// A few salient, generally-true points shown as a short bullet list on each homepage category
// card, underneath the description. Deliberately hedged/general (not state-specific numeric
// claims) since these render for every state at once -- exact numbers live in each state's own
// track content, verified per-state.
var CATEGORY_POINTS = {
  'Notary': [
    'Typically requires an application, exam or course, and often a background check',
    'Commission periods and renewal cycles vary by state',
    'Covers acknowledgments, jurats, oaths, and proper recordkeeping',
  ],
  'Real Estate Salesperson': [
    'Pre-licensing coursework is usually required before you can sit the exam',
    'Most states test national real estate principles plus state-specific law',
    'A first step before eventually qualifying for a broker license',
  ],
  'Real Estate Broker': [
    'Usually requires prior salesperson experience plus extra coursework',
    'Adds topics like trust accounting, agency supervision, and office management',
    'Lets you operate independently or manage other agents',
  ],
  'Driver': [
    'Covers traffic laws, road signs, and safe-driving fundamentals',
    'Usually the written test taken before a behind-the-wheel road test',
    'A required step toward a learner’s permit or full license',
  ],
  'Commercial Driver (CDL)': [
    'Built on federal FMCSA standards layered on top of state rules',
    'General knowledge plus endorsement-specific tests (e.g. air brakes, tankers, hazmat)',
    'Required before operating most trucks and buses for hire',
  ],
  'Motorcycle': [
    'Covers motorcycle-specific traffic laws, operation, and safety gear',
    'Often paired with a separate on-bike skills or riding test',
    'Required for a standalone license or an endorsement on an existing license',
  ],
  'Boating': [
    'Covers navigation rules, required safety equipment, and boating-under-the-influence laws',
    'Many states waive the requirement for boaters born before a certain date',
    'Often required specifically for personal watercraft (PWC) operation',
  ],
};

// States a category deliberately does NOT cover, and a short public-facing reason why -- shown as
// a second, muted pill next to the state-count pill on each homepage category card. Counts/reasons
// summarized from this project's own landscape research (kept intentionally brief here; the admin
// panel has the full per-state breakdown). A category not listed here (e.g. Notary, Driver, CDL,
// Real Estate Salesperson) has no deliberate exclusions -- every state is covered -- so it gets no
// second pill at all.
var CATEGORY_EXCLUDED_INFO = {
  'Real Estate Broker': { count: 6, note: 'no separate broker-level exam in these states, or the entry-level license already covers it' },
  'Motorcycle': { count: 34, note: 'exam is waived in most of these states, or this track isn’t offered here yet' },
  'Boating': { count: 25, note: 'no mandatory boating-education requirement in these states, or this track isn’t offered here yet' },
};

// Homepage category-card display order, grouped with a visual break between the licensing-exam
// categories (Notary, Real Estate) and the knowledge-test categories (Driver/CDL/Motorcycle/
// Boating) -- explicit user-specified order (2026-08-31), not alphabetical. Any active category
// not named here (e.g. a newly-launched one) falls into a third, unlabeled trailing group so it
// still appears rather than silently vanishing from the homepage.
var CATEGORY_ORDER_GROUPS = [
  ['Notary', 'Real Estate Salesperson', 'Real Estate Broker'],
  ['Driver', 'Commercial Driver (CDL)', 'Motorcycle', 'Boating'],
];

// One card per category with at least one active track, each linking straight to that category's
// landing page -- browsing by category, not by a flat list of every state x category track, is
// the whole point of the category-first restructure (2026-08-24), so the homepage leads with this
// instead of the old full state x category grid.
function categoryCardsHtml() {
  var activeKinds = [];
  HUB_EXAMS.forEach(function (e) { if (e.active && activeKinds.indexOf(e.examKind) === -1) activeKinds.push(e.examKind); });

  var ordered = [];
  CATEGORY_ORDER_GROUPS.forEach(function (group) {
    var groupKinds = group.filter(function (k) { return activeKinds.indexOf(k) !== -1; });
    if (groupKinds.length) ordered.push(groupKinds);
  });
  var named = CATEGORY_ORDER_GROUPS.reduce(function (acc, g) { return acc.concat(g); }, []);
  var leftover = activeKinds.filter(function (k) { return named.indexOf(k) === -1; }).sort(function (a, b) { return a.localeCompare(b); });
  if (leftover.length) ordered.push(leftover);

  function cardHtml(kind) {
    var stateCount = new Set(HUB_EXAMS.filter(function (e) { return e.examKind === kind && e.active; }).map(function (t) { return t.stateCode; })).size;
    var points = CATEGORY_POINTS[kind] || [];
    var excluded = CATEGORY_EXCLUDED_INFO[kind];
    var excludedPill = excluded ? '<span class="category-nav-card-excludedcount" title="' + escapeHtml(excluded.note) + '">' +
      excluded.count + ' N/A</span>' : '';
    return '<a class="exam-track-card is-active category-nav-card" href="/' + kindSlug(kind) + '">' +
      '<div class="exam-track-body">' +
      '<div class="category-nav-card-icon">' + (CATEGORY_ICONS[kind] || '📚') + '</div>' +
      '<div class="category-nav-card-content">' +
      '<h3>' + escapeHtml(kind) + '</h3>' +
      '<p class="category-nav-card-desc">' + escapeHtml(CATEGORY_DESCRIPTIONS[kind] || 'Practice tracks for ' + kind + ' licensing.') + '</p>' +
      (points.length ? '<ul class="category-nav-card-points">' + points.map(function (p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="category-nav-card-counts"><span class="category-nav-card-statecount">' + stateCount + ' state' + (stateCount === 1 ? '' : 's') + '</span>' + excludedPill + '</div>' +
      '</div>' +
      '</div><div class="exam-track-footer"><span class="exam-track-view-link">Browse tracks →</span></div>' +
      '</a>';
  }

  return ordered.map(function (group) {
    return '<div class="exam-track-grid category-card-grid">' + group.map(cardHtml).join('') + '</div>';
  }).join('<div class="category-card-group-break"></div>');
}

function renderHub() {
  var tracksHeaderHtml = '<div class="hub-section-header" id="tracks"><h2>Browse by Category</h2></div>';
  // Reuses the exact same widget/state/dispatcher (categorySampleWidgetHtml/loadCategorySampleQuestion/
  // drawCategorySampleQuestion, all keyed off categoryPageState.repTrack) that category pages already
  // use -- no new sample-question UI or handlers needed, just point repTrack at a representative
  // track for a zero-click "try before you buy" moment right on the homepage. Prefers the visitor's
  // own state (cookie) if it's live for ANY category, else just the first active track overall --
  // there's no single "the" category on the homepage to scope this to.
  categoryPageState.repTrack = pickRepresentativeTrack(HUB_EXAMS.filter(function (e) { return e.active; }));
  // Organization + WebSite JSON-LD on the homepage -- the page Google looks to first for a site's
  // identity/brand data. location.origin so this works under whatever domain actually serves the
  // page, not a hardcoded one.
  injectJsonLd('org-jsonld', {
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'Organization', name: 'PassExamHQ', url: location.origin },
      { '@type': 'WebSite', name: 'PassExamHQ', url: location.origin },
    ],
  });

  appEl.innerHTML =
    renderNewsBanner() +
    '<div id="home-promotions-wrap" class="promotions-wrap"></div>' +
    '<div class="hub-hero">' +
    '<div class="hub-hero-copy">' +
    '<h1>Pass Your Licensing Exams on the <span class="hub-hero-highlight">First Try</span></h1>' +
    '<p>Practice question sets modeled after official state and national licensing standards, with ' +
    'voice-enabled practice and instant online access.</p>' +
    '<div class="hub-trust-badges">' +
    '<span class="hub-trust-badge">✓ 2026 Handbook Aligned</span>' +
    '<span class="hub-trust-badge">✓ Voice-Enabled Practice</span>' +
    '<span class="hub-trust-badge">✓ Instant Access</span>' +
    '</div>' +
    '<div class="hub-hero-cta">' +
    '<button class="btn-primary hub-hero-btn" type="button" data-act="scroll-to-tracks">Browse by Category</button>' +
    '</div>' +
    '<p class="muted hub-hero-subtext">Already have a code? <a href="#/redeem">Enter it here</a></p>' +
    '<div id="recent-activity-ticker" class="hub-activity-ticker"></div>' +
    '</div>' +
    '<div id="hub-readiness-wrap"></div>' +
    '</div>' +
    trustStripHtml() +
    categorySampleWidgetHtml() +
    howItWorksHtml() +
    tracksHeaderHtml +
    categoryCardsHtml() +
    comparisonTableHtml();

  // "#tracks" links (tracksHomeHref(), category state picker changes, etc.) are all real
  // navigations to a fresh page load -- the browser's own fragment auto-scroll fires (if at all)
  // before #app has any content, since this is a client-rendered page, so it can't be relied on.
  // #tracks itself is set synchronously just above, so it's safe to scroll to right here. Instant,
  // not smooth -- this is a landing position on page load, not an in-page action like the
  // scroll-to-tracks button's click-triggered smooth scroll.
  if (location.hash === '#tracks') {
    var tracksAnchorEl = document.getElementById('tracks');
    if (tracksAnchorEl) tracksAnchorEl.scrollIntoView({ block: 'start' });
  }

  // Rendered above synchronously so the page itself never waits on this -- promos fill in a
  // moment later once fetched, same "progressive enhancement" idea as the admin Stats page's
  // accuracy table.
  Promise.all([apiFetch('/promotions?placement=home'), loadSiteConfig()]).then(function (results) {
    var r = results[0];
    var wrap = document.getElementById('home-promotions-wrap');
    if (!wrap) return;
    // The site header's promo ribbon (persistent across every page) already surfaces the first
    // active promo in condensed form -- showing it again here as a full card would repeat the
    // same message twice before any hero content. Only show promos beyond that one. Same
    // dismissed-id filtering as fillPromoRibbon() so both agree on which promo is "first".
    var dismissedIds = getDismissedPromoIds();
    var active = (r.promotions || []).filter(function (p) { return dismissedIds.indexOf(p.id) === -1; });
    wrap.innerHTML = promoBannersHtml(active.slice(1), true, false);
  }).catch(function () { /* best-effort -- a promo banner failing to load shouldn't break the hub page */ });
  fillReadinessCard();
  if (categoryPageState.repTrack) loadCategorySampleQuestion();
  // No guarantee band here (moved to category/track pages only, closer to an actual purchase
  // decision -- the homepage's job is routing to a category, not closing a sale, and most
  // category-page visitors arrive there directly via search without ever seeing this page first).
  loadSiteConfig();
  loadRecentActivity();
}

// Real, anonymized "recent passes" ticker -- rotates through GET /activity/recent's items every
// few seconds. Self-cleaning: the interval checks the wrap element still exists on every tick and
// clears itself once the visitor navigates away from the homepage, rather than needing an
// explicit teardown hook wired into route().
var recentActivityItems = [];
var recentActivityIndex = 0;
var recentActivityTimer = null;
function relativeTimeAgo(unixSec) {
  var diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return 'just now';
  if (diff < 3600) { var m = Math.floor(diff / 60); return m + ' minute' + (m === 1 ? '' : 's') + ' ago'; }
  if (diff < 86400) { var h = Math.floor(diff / 3600); return h + ' hour' + (h === 1 ? '' : 's') + ' ago'; }
  var d = Math.floor(diff / 86400); return d + ' day' + (d === 1 ? '' : 's') + ' ago';
}
function drawRecentActivityTicker() {
  var wrap = document.getElementById('recent-activity-ticker');
  if (!wrap || !recentActivityItems.length) return;
  var item = recentActivityItems[recentActivityIndex];
  var stateLabel = item.stateCode ? (STATE_LABELS[item.stateCode] || item.stateCode) + ' ' : '';
  wrap.textContent = '✓ A ' + stateLabel + item.kind + ' student passed ' + relativeTimeAgo(item.submittedAt);
}
function loadRecentActivity() {
  apiFetch('/activity/recent').then(function (res) {
    var cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
    recentActivityItems = (res.items || []).filter(function (item) { return item.submittedAt >= cutoff; });
    if (!recentActivityItems.length) return;
    recentActivityIndex = 0;
    drawRecentActivityTicker();
    clearInterval(recentActivityTimer);
    recentActivityTimer = setInterval(function () {
      if (!document.getElementById('recent-activity-ticker')) { clearInterval(recentActivityTimer); return; }
      recentActivityIndex = (recentActivityIndex + 1) % recentActivityItems.length;
      drawRecentActivityTicker();
    }, 4000);
  }).catch(function () { /* best-effort -- ticker just stays empty */ });
}

// ---- Home page: trust strip, how it works, guarantee band (ported from v0's page.tsx) ----

function trustStripHtml() {
  var items = [
    ['📘', 'Built on current official handbooks'],
    ['⏱️', 'Timed mocks that mirror the real format'],
    ['🔄', '7-day no-questions-asked refund'],
    ['🔑', 'One code in — no passwords to manage'],
  ];
  return '<section class="trust-strip">' + items.map(function (i) {
    return '<div class="trust-strip-item"><span class="trust-strip-icon">' + i[0] + '</span><span>' + i[1] + '</span></div>';
  }).join('') + '</section>';
}

var HOW_IT_WORKS_STEPS = [
  ['📘', 'Try it free', 'Answer real practice questions before you pay a cent — no account needed.'],
  ['📄', 'Buy one track', 'A single one-time payment unlocks a full exam track. No subscription, ever.'],
  ['🔑', 'Your code is your login', 'We email you an access code. That code is the entire front door — no passwords.'],
  ['🏆', 'Walk in confident', 'Drill the bank, sit a timed mock, and track readiness until you\'re ready to pass.'],
];
function howItWorksHtml() {
  return '<section class="how-it-works-section">' +
    '<p class="section-eyebrow">How it works</p>' +
    '<h2 class="comparison-heading how-it-works-heading">From nervous to ready in four steps</h2>' +
    '<ol class="how-it-works-grid">' +
    HOW_IT_WORKS_STEPS.map(function (s, i) {
      return '<li class="how-it-works-card">' +
        '<div class="how-it-works-icon">' + s[0] + '</div>' +
        '<p class="how-it-works-step-label">Step ' + (i + 1) + '</p>' +
        '<h3>' + s[1] + '</h3>' +
        '<p class="muted">' + s[2] + '</p>' +
        '</li>';
    }).join('') +
    '</ol>' +
    '</section>';
}

// Only called from renderCategoryPage() (not the homepage, not individual track pages -- shown
// here since that's the page closest to an actual purchase decision most category-page visitors
// will see). refundFailurePercent shows its pre-fetch default (50) at first paint, then gets
// patched by a .js-refund-pct sweep once real config loads -- see renderCategoryPage()'s own
// loadSiteConfig().then() callback.
function guaranteeCtaBandHtml() {
  return '<section class="guarantee-band">' +
    '<div class="guarantee-band-copy">' +
    '<span class="badge guarantee-band-badge">🛡️ Two guarantees, in plain language</span>' +
    '<h2>If you don\'t pass, you don\'t pay.</h2>' +
    '<p>Study the track, sit your real exam, and if you don\'t pass we refund <span class="js-refund-pct">' + refundFailurePercent + '</span>% of your purchase. ' +
    'Changed your mind early? A 7-day, no-questions-asked refund covers that too.</p>' +
    '<a class="guarantee-band-cta" href="#/guarantee">Read the guarantee →</a>' +
    '</div>' +
    '<div class="guarantee-band-cards">' +
    '<div class="guarantee-band-card"><h3>Pass or money back</h3><p>Fail the real exam after completing your track? Get <span class="js-refund-pct">' + refundFailurePercent + '</span>% of your purchase refunded.</p></div>' +
    '<div class="guarantee-band-card"><h3>7-day refund</h3><p>Not what you expected? Get a full refund within 7 days of purchase, no questions asked.</p></div>' +
    '</div>' +
    '</section>';
}

// ---- Home page: comparison table (Round 2 redesign decision) --------------
// PassExamHQ's own checkmarks are all real, confirmed features (mic/voice answering,
// difficulty-filtered practice, timed exam mode, per-topic progress, guarantee). The "Other Paid
// Apps" column is NOT verified against any specific competitor's current listing -- it's a
// generic-category estimate, deliberately hedged toward 'varies' rather than a flat checkmark
// wherever a feature isn't something every paid app in this space can be assumed to have. Same
// deliberately generic-category treatment as "Free Practice Sites" -- neither column names or
// claims something about one specific product, and both use 'varies' rather than a flat yes/no
// wherever there's genuine spread across the category. Re-review before reusing this table if it's
// ever pointed at a genuinely researched/named competitor instead.
var COMPARISON_FEATURES = [
  // [feature, "Free Practice Sites", "Other Paid Apps", "PassExamHQ"]
  ['State-specific, 2026-current content', 'varies', 'varies', true],
  ['Unlimited practice questions', 'varies', 'varies', true],
  ['Full timed mock exam simulator', 'varies', 'varies', true],
  ['Voice-enabled answering & read-aloud', false, false, true],
  ['Weak-topic progress tracking', false, 'varies', true],
  ['Explanation on every question', 'varies', 'varies', true],
  ['Pass-or-money-back guarantee', false, false, true],
];
function comparisonCell(v, highlight) {
  var cls = v === true ? 'comparison-yes' : v === 'varies' ? 'comparison-varies' : 'comparison-no';
  var mark = v === true ? '✓' : v === 'varies' ? '~' : '✗';
  return '<td class="' + cls + (highlight ? ' comparison-us-col' : '') + '">' + mark + '</td>';
}
function comparisonTableHtml() {
  return '<section class="comparison-section">' +
    '<h2 class="comparison-heading">A Better Way to Pass Your Exam</h2>' +
    '<p class="muted comparison-subheading">How PassExamHQ stacks up against typical licensing-exam prep options.</p>' +
    '<div class="comparison-table-scroll"><table class="comparison-table">' +
    '<thead><tr><th></th><th class="comparison-us-col">PassExamHQ</th><th>Free Practice Sites</th><th>Other Paid Apps</th></tr></thead>' +
    '<tbody>' +
    COMPARISON_FEATURES.map(function (f) {
      return '<tr><td class="comparison-feature">' + f[0] + '</td>' +
        comparisonCell(f[3], true) + comparisonCell(f[1]) + comparisonCell(f[2]) + '</tr>';
    }).join('') +
    '</tbody></table></div>' +
    '<p class="comparison-footnote muted">Comparison based on publicly available information as of August 2026.</p>' +
    '</section>';
}

// Hero "Real Results" card (ported from v0's page.tsx "Your readiness" card, then repointed at
// real data -- v0's version showed fabricated per-visitor numbers, 91% ready/82% accuracy, on a
// page nobody's logged into yet). Used to show "Community Readiness" (accuracy/mock-exams-passed
// averages) with a near-duplicate "Real Results" numbers section further down the page -- the two
// sections' radial rings were literally showing the same s.passRate value twice under different
// labels. Merged into one: this card now IS "Real Results, Not Marketing Copy", and the standalone
// bottom section is gone. Real numbers pulled from /stats/public (see examprep-api), not invented
// -- deliberately omits the raw "students served" count for now: at this site's current scale
// that number reads as thin rather than reassuring, same reasoning as dropping per-user Accuracy/
// Coverage averages. Not fabrication either way -- just an editorial choice of which real numbers
// to feature.
function fillReadinessCard() {
  var wrap = document.getElementById('hub-readiness-wrap');
  if (!wrap) return;
  loadPublicStats().then(function (s) {
    if (s.passRate == null && s.totalQuestions == null && s.tracksLive == null) return; // nothing real to show
    var radial = radialProgressSvg(s.passRate != null ? s.passRate : 0, {
      size: 108, strokeWidth: 10, label: 'Pass Rate', color: 'var(--highlight)',
    });
    // Question count paired with the radial in its own top row, same layout as the category
    // pages' stats card (categoryStatsHtml) -- left blank (not a fabricated "0+") if the count
    // didn't come back, same best-effort posture as that card's own question-count tile.
    var questionCountHtml = s.totalQuestions != null
      ? '<div class="outcome-tile-value">' + Number(s.totalQuestions).toLocaleString() + '+</div>' +
        '<div class="outcome-tile-label">Practice Questions<br>Across All Tracks</div>'
      : '';
    var tiles = [
      { value: s.tracksLive, label: 'Live Tracks' },
      { value: s.examsCompleted, label: 'Mock Exams' },
    ];
    // Site-wide Key Facts Digest coverage (Quick-Fact tables + flashcard decks), added as a second
    // tile pair only once real content exists to show -- an all-zero pair would look like a broken
    // page rather than an honest "not built yet," so this is genuinely additive, never a fabricated
    // placeholder. See aggregateResourceStats().
    var siteResourceStats = aggregateResourceStats(HUB_EXAMS.filter(function (e) { return e.active; }).map(function (e) { return e.examType; }));
    if (siteResourceStats.tables || siteResourceStats.decks) {
      tiles.push({ value: siteResourceStats.tables, label: 'Quick-Fact Tables' });
      tiles.push({ value: siteResourceStats.decks, label: 'Flashcard Decks' });
    }
    wrap.innerHTML = '<div class="hub-readiness-card">' +
      '<p class="hub-readiness-label"><span class="hub-hero-highlight">Real Results</span>, Not Marketing Copy</p>' +
      '<div class="hub-readiness-top-row">' +
      '<div class="outcome-tile hub-readiness-question-count">' + questionCountHtml + '</div>' +
      '<div class="hub-readiness-radial-wrap">' + radial + '</div>' +
      '</div>' +
      '<div class="hub-readiness-tiles">' + tiles.map(function (t) {
        return '<div class="outcome-tile"><div class="outcome-tile-value">' + Number(t.value || 0).toLocaleString() +
          '</div><div class="outcome-tile-label">' + t.label + '</div></div>';
      }).join('') + '</div>' +
      '</div>';
  }).catch(function () { /* best-effort -- card just doesn't appear */ });
}

function renderRedeem(error) {
  // Redeem is a global route (reachable regardless of pathname, see route()), so unlike the
  // form itself (track-agnostic by design), these "no code yet" links can't just assume whichever
  // track's pathname they might historically have inherited -- deep-link into the current track if
  // there is one, otherwise send to the tracks picker rather than guessing.
  var currentTrack = currentTrackOrNull();
  var sampleHref = currentTrack ? (currentTrack.route + '#/sample') : tracksHomeHref();
  var buyHref = currentTrack ? (currentTrack.route + '#/buy') : tracksHomeHref();
  appEl.innerHTML =
    '<div class="redeem-page">' +
    '<div class="redeem-icon">🔐</div>' +
    '<h1>Enter your access code</h1>' +
    (error ? '<p class="error-text">' + error + '</p>' : '') +
    '<form data-act="redeem-submit" class="card redeem-card">' +
    '<input type="text" name="code" class="redeem-code-input" placeholder="XXXXX-XXXXX" autocapitalize="characters" required>' +
    '<div id="turnstile-container"></div>' +
    '<button class="btn-primary" type="submit">Unlock</button>' +
    '</form>' +
    '<p class="muted redeem-sample-hint">No code yet? <a href="' + sampleHref + '">Try a free sample</a> or ' +
    '<a href="' + buyHref + '">buy one instantly →</a></p>' +
    '<button class="btn-secondary btn-sm" type="button" data-act="go-back">← Back</button>' +
    '</div>';
  renderTurnstileWidget();
}

// Turnstile's script loads async — window.turnstile may not exist yet the first time
// renderRedeem() runs. We only render once window.onTurnstileLoad has actually fired
// (turnstileReady, set in index.html's callback), and retry shortly if it hasn't yet,
// since the redeem view can be shown before that callback lands.
function renderTurnstileWidget(attemptsLeft) {
  if (TURNSTILE_SITE_KEY.indexOf('REPLACE') !== -1) return;
  attemptsLeft = attemptsLeft === undefined ? 50 : attemptsLeft; // ~10s of retrying, then give up quietly
  if (window.turnstileReady && window.turnstile) {
    var el = document.querySelector('#turnstile-container');
    if (el) window.turnstile.render(el, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: resolvedColorScheme(),
      // Buy page only: waitForTurnstileToken gives up after ~10s and fails the payment element
      // closed ("Could not load payment options") if the challenge hasn't resolved by then --
      // without this, a slow/late Turnstile success never gets picked back up. Re-mounting here
      // the moment the token actually lands fixes that without touching the other pages that
      // share this same widget (redeem/refer/refund/contact all poll fresh on their own submit).
      callback: function () {
        if (document.getElementById('stripe-payment-element')) mountStripePaymentElement();
      },
    });
  } else if (attemptsLeft > 0 && document.querySelector('#turnstile-container')) {
    setTimeout(function () { renderTurnstileWidget(attemptsLeft - 1); }, 200);
  }
}

function renderTabs(active) {
  // Quiz/Exam/Progress are shown to everyone (with a 🔒 marker when logged out, or logged in for a
  // DIFFERENT track) so a visitor gets a sense of the layout -- clicking one still only lands on
  // the track landing/sales page, never the real content/data (see renderTrackLanding and the
  // guard in renderTrackApp). Deliberately isLoggedInForCurrentTrack(), not just getToken() -- see
  // its definition for why (an account bound to one track viewing a different track's route).
  var loggedIn = isLoggedInForCurrentTrack();
  var gated = { quiz: true, exam: true, toughest45: true, progress: true };
  var tabs = [['resources', 'Resources'], ['quiz', 'Quiz'], ['exam', 'Exam'], ['toughest45', 'Weak Spots'], ['progress', 'Progress'], ['info', 'Info']];
  var trackHeading = loggedIn ? '<div class="track-heading">' + escapeHtml((trackByExamType(state.examType) || {}).shortName || '') + '</div>' : '';
  return renderNewsBanner() + trackHeading + '<nav class="tabs">' + tabs.map(function (t) {
    var locked = gated[t[0]] && !loggedIn;
    return '<a href="#/' + t[0] + '"' + (active === t[0] ? ' aria-current="page"' : '') + '>' +
      (locked ? '🔒 ' : '') + t[1] + '</a>';
  }).join('') + '</nav>';
}

// ---- Study resources (audio/video/pdf/image guides, per exam type) --------

// Real, DB-backed per-track Resources content (tables/flashcards/audio/pdf/etc.). Was previously
// ~4,700 lines of hardcoded table/flashcard const literals plus this object's own entries for all
// 262 tracks -- migrated 2026-09-03 to the `resources` table in D1 (examprep-api), which is now the
// single source of truth. A content-only change (new track, edited fact, new audio file) is a plain
// D1 write -- no app.js edit, no site-repo commit, no API redeploy required.
//
// Filled ONE TRACK AT A TIME by loadTrackResources() rather than all at once at boot (changed
// 2026-09-05). The full catalog is ~2.4MB raw across 285 tracks, 80% of it table rows and flashcard
// arrays -- and boot() used to fetch all of it and block the first paint on it, on every page load,
// to render pages that never read more than one track's worth. Per-track counts (which IS what the
// homepage/category/track-landing stat tiles need) now come from the tiny RESOURCE_COUNTS map below.
var RESOURCES = {};

// examType -> in-flight-or-settled promise, so repeat renders of the same track (or two callers on
// one page, e.g. the landing preview and the stat strip) share a single request.
var trackResourcesPromises = {};
function loadTrackResources(examType) {
  if (!examType) return Promise.resolve();
  if (!trackResourcesPromises[examType]) {
    trackResourcesPromises[examType] = apiFetch('/resources/catalog?examType=' + encodeURIComponent(examType))
      .then(function (res) {
        var byTrack = (res && res.resources) || {};
        // Keyed response, so this works unchanged whether the API returned just this track or (as
        // the test fixtures and the no-params mode do) a whole catalog keyed by exam type.
        RESOURCES[examType] = byTrack[examType] || [];
      })
      .catch(function () { RESOURCES[examType] = RESOURCES[examType] || []; });
  }
  return trackResourcesPromises[examType];
}

// Per-track resource COUNTS for every track (~11KB, vs ~2.4MB for the full catalog) -- enough for
// every pre-purchase surface that just needs "how much material is in here": the homepage and
// category stat tiles, the track landing stat strip, and resourceInventorySummary(). Deliberately
// NOT part of boot()'s blocking Promise.all: nothing on any page needs to wait on it to render,
// so it loads alongside the first paint and the tiles fill in when it lands.
var RESOURCE_COUNTS = {};

// Set when a stat surface renders before the counts arrive, so we know a re-fill is worth doing.
// In the common case counts (1KB, CDN-cached) beat the three blocking boot fetches and the first
// render already has them, so nothing below runs at all.
var resourceCountsNeedRepaint = false;

// Deliberately re-fills only the three stat surfaces rather than re-running route(). A full
// re-render would also reset live page state a visitor may already have touched in those first few
// hundred milliseconds -- a picked state in the category dropdown, an answered sample question --
// which is a bad trade for filling in a few numbers.
function fillResourceCountSurfaces() {
  if (!resourceCountsNeedRepaint) return;
  resourceCountsNeedRepaint = false;

  if (document.getElementById('hub-readiness-wrap')) fillReadinessCard();

  var catWrap = document.getElementById('category-stats-wrap');
  if (catWrap && categoryPageState && categoryPageState.tracks) {
    var tracks = categoryPageState.tracks;
    catWrap.innerHTML = categoryStatsHtml(
      tracks.length,
      new Set(tracks.map(function (t) { return t.stateCode; })).size,
      aggregateResourceStats(tracks.map(function (t) { return t.examType; }))
    );
    fillCategoryQuestionCount(tracks);
    loadSiteConfig().then(fillCategoryStatsRadial);
  }

  // Track landing: the strip renders nothing at all for a track with no digest content, so this
  // has to handle "wasn't there before, should be now" as well as replacing an existing strip.
  var exam = state.examType && trackByExamType(state.examType);
  if (exam && document.querySelector('.track-landing')) {
    var stripHtml = trackResourceStatsHtml(exam.examType);
    var existing = document.querySelector('.track-resource-stats');
    if (existing) existing.outerHTML = stripHtml;
    else if (stripHtml) {
      // Anchor on the breakdown block, which is what directly follows the strip in the first
      // render -- .exam-specs isn't the right anchor, since the official-source link and freshness
      // line sit between it and the strip.
      var breakdown = document.querySelector('.buy-value-col .breakdown-label');
      if (breakdown) breakdown.insertAdjacentHTML('beforebegin', stripHtml);
    }
  }
}

var resourceCountsPromise = null;
function loadResourceCounts() {
  if (!resourceCountsPromise) {
    resourceCountsPromise = apiFetch('/resources/catalog?counts=1').then(function (res) {
      RESOURCE_COUNTS = (res && res.counts) || {};
    }).catch(function () { RESOURCE_COUNTS = {}; });
  }
  return resourceCountsPromise;
}


var RESOURCE_TYPE_LABEL = {
  audio: { icon: '🎧', label: 'Audio' }, video: { icon: '🎥', label: 'Video' },
  pdf: { icon: '📄', label: 'PDF Guide' }, image: { icon: '🖼️', label: 'Quick Reference' },
  table: { icon: '📊', label: 'Reference Table' }, flashcards: { icon: '🗂️', label: 'Flashcards' },
  // 'link'/'web'/'webpage' are external (non-file) reference URLs -- distinct historical type
  // names for the same underlying resource shape (a plain external link), all still present in
  // the D1 resources table across ~42 tracks (notary/driver/boating/motorcycle/RE-broker
  // official-site links). Previously MISSING from this map entirely, which crashed
  // resourceTypeCellHtml() (t.icon on undefined) for every track containing one of these rows --
  // a real, live bug predating the 2026-09-03 D1 migration, just carried forward unnoticed.
  link: { icon: '🔗', label: 'Official Link' }, web: { icon: '🔗', label: 'Official Link' },
  webpage: { icon: '🔗', label: 'Official Link' },
};
function resourceTypeCellHtml(type) {
  var t = RESOURCE_TYPE_LABEL[type];
  return '<span class="resource-type-cell"><span>' + t.icon + '</span><span>' + t.label + '</span></span>';
}

// Real per-track resource inventory, shown pre-purchase (hub cards + track landing page) so a
// visitor knows what they're actually getting -- most tracks currently have just the one official
// handbook link, ca_notary has a full audio/video library. Computed live from RESOURCES itself
// (never a separately-maintained count), so it can't drift out of sync with what's really there,
// and it updates automatically as more tracks grow their own resource libraries over time.
function resourceInventorySummary(examType) {
  // Reads the tiny counts map, not the full per-track items -- this renders on hub cards and the
  // track landing page, neither of which should pull a track's whole content payload just to say
  // "3 audio lessons". Falls back to counting already-loaded items (the Resources tab has them) if
  // the counts map hasn't landed yet, so this never renders a wrong/empty summary mid-load.
  var s = aggregateResourceStats([examType]);
  var mediaCount = s.audio + s.video;
  if (!mediaCount) return { compact: 'Official handbook', full: 'Official handbook (external link)' };
  var parts = [];
  if (s.audio) parts.push(s.audio + ' audio lesson' + (s.audio === 1 ? '' : 's'));
  if (s.video) parts.push(s.video + ' video' + (s.video === 1 ? '' : 's'));
  if (s.tables) parts.push(s.tables + ' reference guide' + (s.tables === 1 ? '' : 's'));
  return { compact: mediaCount + ' audio/video lessons', full: parts.join(' · ') + ', plus the official handbook' };
}

// Aggregates real per-track resource counts (Quick-Fact tables, flashcard decks + their card
// count, audio/video lessons) across one or more exam types -- powers the "N tables · N decks"
// style stat tiles on the homepage, category pages, and track landing pages. Excludes pdf/link
// entries (those are just official-handbook links, not content this site authored). Computed live
// from RESOURCES itself, same never-drifts-out-of-sync property as resourceInventorySummary above.
function aggregateResourceStats(examTypes) {
  var tables = 0, decks = 0, cards = 0, audio = 0, video = 0;
  // Counts not in yet -- whatever this render produces is provisional, so ask boot() to repaint
  // once they land. (Empty map only ever means "still loading" or "endpoint failed"; a site with
  // genuinely zero resources everywhere would still return a row per track.)
  if (!Object.keys(RESOURCE_COUNTS).length) resourceCountsNeedRepaint = true;
  (examTypes || []).forEach(function (examType) {
    // Prefer the ~11KB counts map (loaded for every track at boot). Only fall back to counting a
    // track's actual items when that track happens to be fully loaded but counts aren't -- which
    // is what the test fixtures do, and what a counts-endpoint failure would leave us with.
    var c = RESOURCE_COUNTS[examType];
    if (c) {
      tables += c.tables || 0; decks += c.decks || 0; cards += c.cards || 0;
      audio += c.audio || 0; video += c.video || 0;
      return;
    }
    (RESOURCES[examType] || []).forEach(function (r) {
      if (r.type === 'table') tables++;
      else if (r.type === 'flashcards') { decks++; cards += (r.flashcards || []).length; }
      else if (r.type === 'audio') audio++;
      else if (r.type === 'video') video++;
    });
  });
  return { tables: tables, decks: decks, cards: cards, audio: audio, video: video, total: tables + decks + audio + video };
}

// Per-track "what's actually in the Resources tab" stat strip for the track landing page --
// reuses the same .outcome-tile styling as the homepage/category stats cards so the number
// treatment reads consistently across all three levels. Renders nothing (not a zero-filled row)
// for the ~194 tracks that don't have Key Facts Digest content yet -- resourceInventorySummary's
// existing "Official handbook" text line already covers that case on its own.
function trackResourceStatsHtml(examType) {
  var s = aggregateResourceStats([examType]);
  if (!s.tables && !s.decks && !s.audio && !s.video) return '';
  var tiles = [];
  if (s.tables) tiles.push({ value: s.tables, label: 'Quick-Fact Table' + (s.tables === 1 ? '' : 's') });
  if (s.decks) tiles.push({ value: s.decks, label: 'Flashcard Deck' + (s.decks === 1 ? '' : 's') + (s.cards ? '<br>(' + s.cards + ' cards)' : '') });
  if (s.audio) tiles.push({ value: s.audio, label: 'Audio Lesson' + (s.audio === 1 ? '' : 's') });
  if (s.video) tiles.push({ value: s.video, label: 'Video' + (s.video === 1 ? '' : 's') });
  return '<div class="track-resource-stats">' + tiles.map(function (t) {
    return '<div class="outcome-tile"><div class="outcome-tile-value">' + t.value + '</div><div class="outcome-tile-label">' + t.label + '</div></div>';
  }).join('') + '</div>';
}

// Native <audio controls>/<video controls> has a draggable scrubber but no dedicated skip
// buttons in any browser -- these fill that gap for long lecture-style recordings.
function resourcePlayerSkipControlsHtml() {
  return '<div class="resource-player-skip">' +
    '<button type="button" class="btn-secondary btn-sm" data-act="skip-resource-player" data-seek="-15">⏪ 15s</button>' +
    '<button type="button" class="btn-secondary btn-sm" data-act="skip-resource-player" data-seek="15">15s ⏩</button>' +
    '</div>';
}

function resourceTableInnerHtml(t) {
  var headerRow = '<tr>' + t.headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr>';
  var bodyRows = t.rows.map(function (row) {
    return '<tr>' + row.map(function (cell) { return '<td>' + cell + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<div class="resource-table-scroll"><table class="resource-table">' +
    '<thead>' + headerRow + '</thead><tbody>' + bodyRows + '</tbody></table></div>' +
    (t.journalNote ? '<p class="muted resource-table-note">' + t.journalNote + '</p>' : '') +
    (t.sourceNote ? '<p class="muted resource-table-note">' + t.sourceNote + '</p>' : '');
}

// New resource type (2026-09-03): an interactive flip-card deck, one card visible at a time.
// `cards` is a plain [{front, back, source}] array -- deliberately simpler than the table shape
// (no headers/columns needed) since each card is a single question/term -> answer pair. State
// (which card, flipped or not) lives in the module-level `flashcardState` var, re-initialized
// here whenever it's stale for the currently-open row (e.g. first open, or after a page reload
// left it pointing at a different resource's card count).
function flashcardDeckHtml(cards, resourceIndex) {
  if (!cards || !cards.length) return '<p class="muted">No cards yet.</p>';
  if (!flashcardState || flashcardState.resourceIndex !== resourceIndex || flashcardState.index >= cards.length) {
    flashcardState = { resourceIndex: resourceIndex, index: 0, flipped: false };
  }
  var card = cards[flashcardState.index];
  var isFirst = flashcardState.index === 0;
  var isLast = flashcardState.index === cards.length - 1;
  return '<div class="flashcard-deck">' +
    '<p class="muted flashcard-progress">Card ' + (flashcardState.index + 1) + ' of ' + cards.length + ' — tap the card to flip it</p>' +
    '<div class="flashcard' + (flashcardState.flipped ? ' is-flipped' : '') + '" data-act="flip-flashcard" role="button" tabindex="0" aria-label="Flip card">' +
    '<div class="flashcard-inner">' +
    '<div class="flashcard-face flashcard-front">' + escapeHtml(card.front) + '</div>' +
    '<div class="flashcard-face flashcard-back">' + escapeHtml(card.back) +
    (card.source ? '<div class="flashcard-source muted">' + escapeHtml(card.source) + '</div>' : '') + '</div>' +
    '</div></div>' +
    '<div class="flashcard-nav">' +
    '<button class="btn-secondary btn-sm" type="button" data-act="prev-flashcard"' + (isFirst ? ' disabled' : '') + '>← Prev</button>' +
    '<button class="btn-secondary btn-sm" type="button" data-act="shuffle-flashcards" title="Shuffle the deck">🔀 Shuffle</button>' +
    '<button class="btn-secondary btn-sm" type="button" data-act="next-flashcard"' + (isLast ? ' disabled' : '') + '>Next →</button>' +
    '</div></div>';
}

function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  seconds = Math.round(seconds);
  var m = Math.floor(seconds / 60);
  var s = seconds % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// Rough estimate from file size alone (assumed bitrate per type) so Length has *something* to
// show/sort by even for locked resources, where we deliberately never hand out a playable URL
// to probe the real duration (that would double as a way to bypass the lock). Once a real,
// exact duration is known (see the metadata probe for unlocked items), it replaces this estimate.
var ASSUMED_BITRATE_BYTES_PER_SEC = { audio: 24000, video: 187500 }; // ~192kbps audio, ~1.5Mbps video
function estimateDurationSeconds(type, sizeBytes) {
  var rate = ASSUMED_BITRATE_BYTES_PER_SEC[type];
  if (!rate || !sizeBytes) return null;
  return sizeBytes / rate;
}
function formatApproxMinutes(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  var m = Math.max(1, Math.round(seconds / 60));
  return '~' + m + ' min';
}

var RESOURCES_PROMO_BANNER =
  '<div class="card resources-promo-banner">' +
  '<strong>🎓 You\'re previewing a sample of what\'s included</strong>' +
  '<p class="muted">Unlock the full resource library plus the complete practice question bank — buy instant ' +
  'access, or refer friends and earn it for free.</p>' +
  '<div class="resources-promo-cta">' +
  '<a class="btn-primary btn-sm" href="#/buy">Unlock everything →</a>' +
  '<a class="btn-secondary btn-sm" href="#/refer">Refer & earn free access →</a>' +
  '<a class="btn-secondary btn-sm" href="#/sample">Try 10 sample questions →</a>' +
  '</div></div>';

// Resources are listed as one sortable table (not a card grid) — Type/Name/Topic/Length/Status,
// with an expandable row for whichever item is currently open. Module-level so the sort/expand
// click handlers (delegated, see the document click listener) can re-render without re-fetching.
var resourcesRowsCache = [];
var resourcesSort = { key: 'status', dir: -1 }; // dir:-1 so unlocked/free rows (higher value) sort first
var resourcesOpenIndex = null;
// Which flashcard deck is open + current position/flip state within it -- reset to null whenever
// the owning resource row closes or a different topic tab is selected (mirrors resourcesOpenIndex's
// own reset discipline), and self-heals in flashcardDeckHtml if it's ever stale for the open row.
var flashcardState = null;
var currentResourcesTopic = null; // null = "All"
var resourceProgressCache = {}; // resourceKey -> {percent, timesOpened}, logged-in users only

// Best-effort -- a tracking hiccup should never block the resource itself from playing.
function postResourceProgress(resourceKey, type, percent, isNewOpen) {
  if (!getToken() || !resourceKey) return;
  apiFetch('/resources/progress', {
    method: 'POST', body: { file: resourceKey, type: type, percent: percent, isNewOpen: !!isNewOpen },
  }).catch(function () {});
}

async function renderResources() {
  // This is the ONE surface that needs a track's full content (table rows, flashcard arrays), so
  // it's the one that pays to fetch it -- for this track alone, not all 285. Paint the tab chrome
  // first so the fetch doesn't leave a blank screen; loadTrackResources() de-dupes if the landing
  // page already kicked off the same request.
  if (!RESOURCES[state.examType]) {
    appEl.innerHTML = renderTabs('resources') + '<p class="muted">Loading…</p>';
    await loadTrackResources(state.examType);
  }
  var items = RESOURCES[state.examType] || [];
  if (!items.length) {
    appEl.innerHTML = renderTabs('resources') +
      '<p class="muted">No study resources yet for this exam track.</p>';
    return;
  }

  var loggedIn = isLoggedInForCurrentTrack();
  appEl.innerHTML = renderTabs('resources') + '<p class="muted">Loading…</p>';

  // Logged-in sessions get everything signed; anonymous visitors only get the server's own
  // free-sample allowlist signed (see FREE_RESOURCES in examprep-api) — nothing client-side
  // decides what's actually unlockable.
  var signedUrls = {};
  try {
    if (loggedIn) {
      var filesToSign = items.filter(function (r) { return !r.url && r.file; }).map(function (r) { return r.file; });
      if (filesToSign.length) {
        var signRes = await apiFetch('/resources/sign-batch', { method: 'POST', body: { files: filesToSign } });
        signedUrls = signRes.urls;
      }
      // Best-effort -- a failed progress fetch just means "no progress shown yet", not a
      // blocker for the resources list itself.
      try {
        var progressRes = await apiFetch('/resources/progress');
        resourceProgressCache = {};
        progressRes.items.forEach(function (p) { resourceProgressCache[p.resource_file] = p; });
      } catch (e) { resourceProgressCache = {}; }
    } else {
      var freeRes = await apiFetch('/resources/free?examType=' + encodeURIComponent(state.examType));
      signedUrls = freeRes.urls;
    }
  } catch (e) {
    appEl.innerHTML = renderTabs('resources') +
      '<p>Could not load resources. Try again shortly.</p>';
    return;
  }

  resourcesOpenIndex = null;
  resourcesRowsCache = items.map(function (r, i) {
    var unlocked = loggedIn || !!r.free;
    var url = unlocked ? (r.url || (r.file ? (API_BASE + signedUrls[r.file]) : null)) : null;
    return {
      index: i, title: r.title, type: r.type, topic: r.topic || 'General Reference', desc: r.desc,
      unlocked: unlocked, downloadable: !!r.url, url: url, table: r.table || null,
      flashcards: r.flashcards || null,
      resourceKey: r.file || r.url, // stable identifier for progress tracking, regardless of R2 vs external
      lengthSeconds: null, estimatedLengthSeconds: estimateDurationSeconds(r.type, r.sizeBytes),
    };
  });
  // A stale filter (e.g. left over from a different exam track) shouldn't hide everything.
  if (currentResourcesTopic && !resourcesRowsCache.some(function (r) { return r.topic === currentResourcesTopic; })) {
    currentResourcesTopic = null;
  }

  var intro = loggedIn
    ? '<p class="muted resources-intro">Guided material to go with your practice questions.</p>'
    : '';
  appEl.innerHTML = renderTabs('resources') + intro +
    (loggedIn ? '' : RESOURCES_PROMO_BANNER) +
    '<div id="resources-table-container"></div>';
  renderResourcesTable();

  // Best-effort, lightweight duration lookups (the server's Range support means this only
  // pulls the file's metadata atom, not the whole file) so Length is populated -- and sortable
  // -- without the visitor needing to press Play first. Locked rows have no URL to probe.
  resourcesRowsCache.forEach(function (row) {
    if (!row.unlocked || !row.url || (row.type !== 'audio' && row.type !== 'video')) return;
    var probe = document.createElement(row.type);
    probe.preload = 'metadata';
    // display:none is unreliable for firing loadedmetadata in some browsers -- this keeps the
    // element genuinely "rendered" (so loading actually proceeds) while staying invisible.
    // CSP blocks inline style.cssText, hence a class (see .resource-duration-probe in style.css).
    probe.classList.add('resource-duration-probe');
    probe.muted = true;
    probe.addEventListener('loadedmetadata', function () {
      row.lengthSeconds = probe.duration;
      renderResourcesTable();
      probe.remove();
    });
    probe.addEventListener('error', function () { probe.remove(); });
    probe.src = row.url;
    document.body.appendChild(probe);
  });
}

function distinctResourceTopics() {
  var seen = {}, topics = [];
  resourcesRowsCache.forEach(function (r) { if (!seen[r.topic]) { seen[r.topic] = true; topics.push(r.topic); } });
  topics.sort();
  return topics;
}

function resourceTopicCounts() {
  var counts = {};
  resourcesRowsCache.forEach(function (r) { counts[r.topic] = (counts[r.topic] || 0) + 1; });
  return counts;
}

function renderResourceTopicSubTabs() {
  var counts = resourceTopicCounts();
  var tabs = [null].concat(distinctResourceTopics());
  return '<nav class="tabs sub-tabs topic-sub-tabs">' + tabs.map(function (t) {
    var count = t === null ? resourcesRowsCache.length : (counts[t] || 0);
    return '<a href="#" data-act="select-resource-topic-tab" data-topic="' + (t === null ? '' : t) + '"' +
      (t === currentResourcesTopic ? ' aria-current="page"' : '') + '>' +
      (t === null ? 'All' : t) + ' (' + count + ')</a>';
  }).join('') + '</nav>';
}

function sortedResourceRows() {
  var rows = currentResourcesTopic
    ? resourcesRowsCache.filter(function (r) { return r.topic === currentResourcesTopic; })
    : resourcesRowsCache.slice();
  var key = resourcesSort.key, dir = resourcesSort.dir;
  rows.sort(function (a, b) {
    var av, bv;
    if (key === 'length') {
      av = a.lengthSeconds != null ? a.lengthSeconds : (a.estimatedLengthSeconds != null ? a.estimatedLengthSeconds : -1);
      bv = b.lengthSeconds != null ? b.lengthSeconds : (b.estimatedLengthSeconds != null ? b.estimatedLengthSeconds : -1);
    }
    else if (key === 'status') { av = a.unlocked ? 1 : 0; bv = b.unlocked ? 1 : 0; }
    else { av = String(a[key] || '').toLowerCase(); bv = String(b[key] || '').toLowerCase(); }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
  return rows;
}

function renderResourcesTable() {
  var container = document.getElementById('resources-table-container');
  if (!container) return; // navigated away before an async duration lookup resolved

  var loggedIn = isLoggedInForCurrentTrack();
  var columns = [['type', 'Type'], ['title', 'Name'], ['topic', 'Topic'], ['length', 'Length'], ['status', 'Status']];
  // Action column first -- so mobile users can see/tap Play/Show/Hide/Unlock without having to
  // horizontally scroll the table to reach it.
  var headerCells = '<th></th>' + columns.map(function (c) {
    var indicator = resourcesSort.key === c[0] ? (resourcesSort.dir === 1 ? ' ▲' : ' ▼') : '';
    return '<th data-act="sort-resources" data-key="' + c[0] + '">' + c[1] + indicator + '</th>';
  }).join('');

  var bodyHtml = sortedResourceRows().map(function (row) {
    var lengthLabel = row.type !== 'audio' && row.type !== 'video' ? '—'
      : row.lengthSeconds != null ? formatDuration(row.lengthSeconds)
      : formatApproxMinutes(row.estimatedLengthSeconds);
    var progress = resourceProgressCache[row.resourceKey];
    var progressNote = '';
    if (row.unlocked && loggedIn && progress) {
      progressNote = (row.type === 'audio' || row.type === 'video')
        ? '<div class="resource-progress-note muted">' + (progress.percent >= 95 ? '✓ Watched' : progress.percent + '% watched') + '</div>'
        : '<div class="resource-progress-note muted">✓ Viewed</div>';
    }
    var statusCell = (!row.unlocked ? '<span class="badge resource-locked-badge">🔒 Locked</span>'
      : loggedIn ? '<span class="badge">Included</span>'
      : '<span class="badge resource-free-badge">Free sample</span>') + progressNote;

    var actionCell;
    if (!row.unlocked) {
      // Unlock stays a real, prominent button -- it's the primary CTA, unlike the minimal
      // icon-only triggers below for already-unlocked play/show/hide/open actions.
      actionCell = '<a class="btn-secondary btn-sm" href="#/buy">Unlock →</a>';
    } else if (row.type === 'pdf' && row.downloadable) {
      actionCell = '<a class="resource-action-icon-btn" href="' + row.url + '" target="_blank" rel="noopener" title="Open" aria-label="Open">↗</a>';
    } else {
      var isOpen = resourcesOpenIndex === row.index;
      var actionLabel = isOpen ? 'Hide' : row.type === 'table' ? 'Show' : row.type === 'image' ? 'View' : row.type === 'flashcards' ? 'Study' : 'Play';
      var actionIcon = isOpen ? '✕' : row.type === 'table' ? '📊' : row.type === 'image' ? '👁' : row.type === 'flashcards' ? '🗂️' : '▶';
      actionCell = '<button class="resource-action-icon-btn" type="button" data-act="toggle-resource-media" data-index="' + row.index +
        '" title="' + actionLabel + '" aria-label="' + actionLabel + '">' + actionIcon + '</button>';
    }

    var mainRow = '<tr>' +
      '<td>' + actionCell + '</td>' +
      '<td>' + resourceTypeCellHtml(row.type) + '</td>' +
      '<td>' + row.title + '</td>' +
      '<td class="muted">' + row.topic + '</td>' +
      '<td>' + lengthLabel + '</td>' +
      '<td>' + statusCell + '</td>' +
      '</tr>';

    if (resourcesOpenIndex !== row.index) return mainRow;

    var inner = '';
    if (row.type === 'audio') {
      inner = '<audio class="resource-player" controls autoplay preload="metadata" data-resource-key="' + row.resourceKey + '" data-resource-type="audio"' +
        (row.downloadable ? '' : ' controlsList="nodownload" oncontextmenu="return false"') + ' src="' + row.url + '"></audio>' + resourcePlayerSkipControlsHtml();
    } else if (row.type === 'video') {
      inner = '<video class="resource-player" controls autoplay preload="metadata" data-resource-key="' + row.resourceKey + '" data-resource-type="video"' +
        (row.downloadable ? '' : ' controlsList="nodownload" oncontextmenu="return false"') + ' src="' + row.url + '"></video>' + resourcePlayerSkipControlsHtml();
    } else if (row.type === 'image') {
      inner = '<img class="resource-thumb" src="' + row.url + '" alt="' + row.title + '" oncontextmenu="return false">';
    } else if (row.type === 'table') {
      inner = resourceTableInnerHtml(row.table);
    } else if (row.type === 'flashcards') {
      inner = flashcardDeckHtml(row.flashcards, row.index);
    } else if (row.type === 'pdf') {
      inner = '<iframe class="resource-pdf-frame" src="' + row.url + '#toolbar=0" title="' + row.title + '"></iframe>';
    }

    return mainRow + '<tr class="resources-index-expand-row"><td colspan="6">' +
      '<p class="muted resource-desc">' + row.desc + '</p>' + inner + '</td></tr>';
  }).join('');

  var empty = bodyHtml ? '' : '<p class="muted">No resources yet for this topic.</p>';
  container.innerHTML = renderResourceTopicSubTabs() + empty +
    '<div class="resource-table-scroll"><table class="resource-table resources-index-table">' +
    '<thead><tr>' + headerCells + '</tr></thead><tbody>' + bodyHtml + '</tbody></table></div>';

  // Track audio/video watch progress -- throttled to avoid posting on every timeupdate tick
  // (which fires several times a second), and always send a final update on pause/end so the
  // last few seconds of a session aren't lost to the throttle window.
  var player = container.querySelector('.resource-player[data-resource-key]');
  if (player && loggedIn) {
    var lastSent = 0;
    var sendPlayerProgress = function () {
      if (!player.duration || isNaN(player.duration)) return;
      var pct = Math.round((player.currentTime / player.duration) * 100);
      postResourceProgress(player.getAttribute('data-resource-key'), player.getAttribute('data-resource-type'), pct, false);
    };
    player.addEventListener('timeupdate', function () {
      var t = Date.now();
      if (t - lastSent < 15000) return;
      lastSent = t;
      sendPlayerProgress();
    });
    player.addEventListener('pause', sendPlayerProgress);
    player.addEventListener('ended', function () { postResourceProgress(player.getAttribute('data-resource-key'), player.getAttribute('data-resource-type'), 100, false); });
  }
}

async function renderQuiz() {
  quizRenderToken++; // invalidates any pending auto-advance timer scheduled for a prior question
  // Only blank to the loading placeholder on a genuinely empty screen (first tab entry) -- doing
  // it unconditionally (including Next/auto-advance, when a question is already showing) collapsed
  // the page to one line and forced an instant scroll-to-0 snap, right before scrollToQuestion()
  // below smooth-scrolled back down -- a jarring snap-then-rebound on every question change.
  // Leaving the current question mounted during the fetch keeps the page height stable instead.
  if (!state.question) appEl.innerHTML = renderTabs('quiz') + '<p class="muted">Loading question…</p>';
  try {
    var qs = state.quizDifficulty ? '?difficulty=' + state.quizDifficulty : '';
    state.question = await apiFetch('/questions/next' + qs);
    state.answered = null;
    drawQuestion();
    scrollToQuestion();
    if (quizAutoRead) speak(questionReadText(state.question));
    refreshQuizStats(); // best-effort re-sync (e.g. picks up progress made via a mock exam elsewhere)
  } catch (e) {
    appEl.innerHTML = renderTabs('quiz') + '<p>Could not load a question. Try again shortly.</p>';
  }
}

// Compact version of the Progress tab's stats-bar, kept live on the Quiz tab itself so accuracy
// is visible continuously instead of only on a separate tab. state.quizStats is refreshed from
// /progress/summary on every new question (self-healing, e.g. after a mock exam elsewhere) and
// updated instantly from each /answer response in between (no extra round-trip needed for that).
function renderQuizStatsBarHtml() {
  var s = state.quizStats || { totalAnswered: 0, totalCorrect: 0 };
  var wrong = s.totalAnswered - s.totalCorrect;
  var pct = s.totalAnswered ? Math.round((100 * s.totalCorrect) / s.totalAnswered) : 0;
  return '<div class="stats-bar quiz-stats-bar" id="quiz-stats-bar">' +
    '<div class="stat-box"><div class="label">Total</div><div class="val">' + s.totalAnswered + '</div></div>' +
    '<div class="stat-box"><div class="label">Correct</div><div class="val correct">' + s.totalCorrect + '</div></div>' +
    '<div class="stat-box"><div class="label">Wrong</div><div class="val wrong">' + wrong + '</div></div>' +
    '<div class="stat-box"><div class="label">Accuracy</div><div class="val accuracy">' + pct + '%</div></div>' +
    '</div>';
}

// quizStatsToken guards against a stale response clobbering fresher data -- refreshQuizStats()
// is fire-and-forget (not awaited), so its /progress/summary fetch can still be in flight when
// the user answers the question it was requested for. submitAnswer() already has the correct
// post-answer totals straight from /answer's own response; if this fetch's response lands after
// that, applying it would silently roll the stats bar (esp. the Wrong count) back to pre-answer
// numbers. Every write to state.quizStats bumps the token first, so a fetch only applies if
// nothing newer has written to quizStats since it was kicked off.
var quizStatsToken = 0;

function refreshQuizStats() {
  var tokenAtFetch = ++quizStatsToken;
  apiFetch('/progress/summary').then(function (s) {
    if (quizStatsToken !== tokenAtFetch) return; // superseded by a newer answer/question load
    state.quizStats = s;
    var bar = document.getElementById('quiz-stats-bar');
    if (bar) bar.outerHTML = renderQuizStatsBarHtml();
  }).catch(function () {}); // best-effort -- the quiz itself must never depend on this succeeding
}

// Difficulty here isn't manually tagged -- the server buckets each question by how everyone has
// actually done on it so far (see DIFFICULTY_CASE in the Worker), so this filter improves as more
// people answer questions rather than needing upkeep.
function renderQuizDifficultyPicker() {
  return '<div class="quiz-difficulty-pill" role="group" aria-label="Difficulty">' +
    QUIZ_DIFFICULTIES.map(function (d) {
      var active = state.quizDifficulty === d[0];
      return '<button type="button" class="' + (active ? 'active' : '') + '" data-act="quiz-difficulty" data-difficulty="' + d[0] + '"' +
        (active ? ' aria-current="true"' : '') + '>' + d[1] + '</button>';
    }).join('') + '</div>';
}

function renderQuizAutoAdvanceToggle() {
  return '<label class="auto-advance-toggle">' +
    '<input type="checkbox" data-act="toggle-quiz-autoadvance"' + (quizAutoAdvance ? ' checked' : '') + '> ' +
    'Auto-advance when I answer correctly</label>';
}

function renderQuizAutoReadToggle() {
  return '<label class="auto-advance-toggle">' +
    '<input type="checkbox" data-act="toggle-quiz-autoread"' + (quizAutoRead ? ' checked' : '') + '> ' +
    'Auto-read question and answer</label>';
}

// Grouped so both toggles sit on the same line/pill row instead of quiz-controls-row's own
// space-between splitting them apart from each other.
function renderQuizToggles() {
  return '<div class="quiz-toggles-group">' + renderQuizAutoAdvanceToggle() + renderQuizAutoReadToggle() + '</div>';
}

// Mobile-only collapse (CSS media query) -- desktop always shows the content regardless of this
// flag, since there's room for it there. Re-rendered via drawQuestion() on toggle, not a fresh
// question fetch, so answered state/etc. is untouched.
var quizControlsExpanded = false;
function renderQuizControlsSection() {
  return '<div class="quiz-controls-row">' +
    '<button class="quiz-controls-toggle" type="button" data-act="toggle-quiz-controls">' +
    'Quiz settings ' + (quizControlsExpanded ? '▴' : '▾') + '</button>' +
    '<div class="quiz-controls-content' + (quizControlsExpanded ? ' expanded' : '') + '">' +
    renderQuizDifficultyPicker() + renderQuizToggles() + '</div>' +
    '</div>';
}

// Shared by the manual "Read aloud" button and auto-read, so both stay in sync.
function questionReadText(q) {
  return q.question + '. ' + ['A', 'B', 'C', 'D'].map(function (k) { return k + '. ' + q.choices[k]; }).join('. ');
}

function drawQuestion() {
  var q = state.question;
  var prefixes = ['A', 'B', 'C', 'D'];
  var choiceHtml = prefixes.map(function (k) {
    var cls = 'option-btn';
    if (state.answered) {
      if (k === state.answered.correctChoice) cls += ' correct';
      else if (k === state.answered.picked) cls += ' wrong';
    }
    return optionButtonHtml(k, q.choices[k], cls,
      'data-act="answer" data-choice="' + k + '"' + (state.answered ? ' disabled' : ''));
  }).join('');

  var explanation = state.answered
    ? '<div class="explanation-box">' +
      '<strong class="' + (state.answered.correct ? 'result-correct' : 'result-incorrect') + '">' +
      (state.answered.correct ? 'Correct.' : 'Incorrect.') + '</strong> ' + state.answered.explanation + '</div>'
    : '';

  var micZone = !state.answered
    ? '<div class="mic-zone">' +
      '<button class="btn-mic" data-act="mic-toggle">🎙️ Voice Answer</button>' +
      '<div class="transcript-box" id="mic-transcript"></div></div>'
    : '';

  var nav = state.answered
    ? '<div class="nav-controls"><button class="btn-primary" data-act="next-question">Next question →</button></div>'
    : '';

  appEl.innerHTML = renderTabs('quiz') +
    renderQuizStatsBarHtml() +
    renderQuizControlsSection() +
    '<div class="card">' +
    '<div class="question-topic">' + q.topic + '</div>' +
    '<div class="question-text">' + q.question + '</div>' +
    '<div class="audio-actions"><button class="btn-secondary btn-sm" data-act="listen">🔊 Read aloud</button></div>' +
    '</div>' +
    '<div class="options-grid">' + choiceHtml + '</div>' +
    explanation + micZone + nav;

  setupMic();
}

var progressExamAttempts = []; // standard + toughest45 attempts merged into one list, each tagged with .mode -- stashed so toggling an attempt open/closed doesn't re-fetch
var examAttemptOpenId = null; // attemptId currently expanded, or null (accordion -- one at a time -- attemptIds are globally unique across modes so this is unambiguous)
var examAttemptDetailCache = {}; // attemptId -> { review } | { error: true }, fetched lazily on first open
var examAttemptsExpanded = false; // collapsed by default, same "Show all" pattern as the topics table below
var examAttemptsSort = { key: 'date', dir: 'desc' }; // newest first by default; click a header to re-sort (e.g. by Mode, to group Weak Spots attempts together)
var EXAM_ATTEMPTS_COLLAPSED_COUNT = 2;
var EXAM_ATTEMPT_MODE_LABELS = { standard: 'Standard', toughest45: 'Weak Spots' };

// Per-attempt exam history for the Progress tab -- same attempts list as the Exam/Weak Spots
// tabs' own history pages, but each row expands in place to show just the wrong questions (with
// the correct answer + explanation), mirroring the admin console's user → attempt → per-question
// drill-down. The full per-question detail (/exam/attempt) isn't in the /exam/history list
// response, so it's fetched lazily the first time a row opens rather than upfront for every attempt.
function examAttemptDetailHtml(attemptId) {
  var cached = examAttemptDetailCache[attemptId];
  if (!cached) return '<p class="muted">Loading…</p>';
  if (cached.error) return '<p class="error-text">Could not load this attempt. Try again shortly.</p>';
  var wrongOnly = cached.review
    .map(function (r, i) { return { r: r, i: i }; })
    .filter(function (x) { return !x.r.correct; });
  if (!wrongOnly.length) return '<p class="muted">All correct on this attempt — nice work! 🎉</p>';
  return '<div class="exam-attempt-wrong-list">' +
    wrongOnly.map(function (x) { return examReviewItemHtml(x.r, x.i); }).join('') + '</div>';
}

function examAttemptSortValue(a, key) {
  if (key === 'mode') return a.mode;
  if (key === 'score') return a.total ? a.correct / a.total : 0;
  return a.submittedAt;
}

// Standard and Weak Spots attempts merged into one sortable table (a Mode column tells them
// apart) rather than two near-identical cards -- they carry the same fields, and a reader browsing
// recent activity doesn't care which bucket an attempt landed in until they want to filter by it,
// at which point sorting by Mode groups them.
function examAttemptsSectionHtml() {
  var attempts = progressExamAttempts;
  if (!attempts.length) return '';
  var key = examAttemptsSort.key, dir = examAttemptsSort.dir;
  var sorted = attempts.slice().sort(function (a, b) {
    var av = examAttemptSortValue(a, key), bv = examAttemptSortValue(b, key);
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  var truncated = !examAttemptsExpanded && sorted.length > EXAM_ATTEMPTS_COLLAPSED_COUNT;
  var visible = truncated ? sorted.slice(0, EXAM_ATTEMPTS_COLLAPSED_COUNT) : sorted;
  var arrow = function (k) { return key === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''; };
  var rows = visible.map(function (a) {
    var isOpen = examAttemptOpenId === a.attemptId;
    var date = new Date(a.submittedAt * 1000).toLocaleString();
    var row = '<tr class="exam-attempt-row" data-act="toggle-exam-attempt" data-attempt-id="' + a.attemptId + '">' +
      '<td>' + date + '</td>' +
      '<td>' + EXAM_ATTEMPT_MODE_LABELS[a.mode] + '</td>' +
      '<td><span class="' + (a.passed ? 'exam-attempt-score-passed' : 'exam-attempt-score-failed') + '">' + a.correct + ' / ' + a.total + '</span> ' +
      '<span class="exam-attempt-caret">' + (isOpen ? '▲' : '▾') + '</span></td>' +
      '</tr>';
    var detailRow = isOpen
      ? '<tr class="exam-attempt-detail-row"><td colspan="3"><div class="exam-attempt-detail">' + examAttemptDetailHtml(a.attemptId) + '</div></td></tr>'
      : '';
    return row + detailRow;
  }).join('');
  var toggleHtml = sorted.length > EXAM_ATTEMPTS_COLLAPSED_COUNT
    ? '<button class="btn-secondary btn-sm progress-topics-toggle" type="button" data-act="toggle-exam-attempts-expanded">' +
      (truncated ? 'Show all ' + sorted.length + ' attempts ▾' : 'Show fewer ▴') + '</button>'
    : '';
  return '<h3 class="mockexam-review-heading">Exam Attempts (' + attempts.length + ')</h3>' +
    '<p class="muted">Tap an attempt to see the questions you missed, with the correct answer and why.</p>' +
    '<table class="progress-topics-table exam-attempts-table"><thead><tr>' +
    '<th data-act="sort-exam-attempts" data-sort-key="date">Date' + arrow('date') + '</th>' +
    '<th data-act="sort-exam-attempts" data-sort-key="mode">Mode' + arrow('mode') + '</th>' +
    '<th data-act="sort-exam-attempts" data-sort-key="score">Score' + arrow('score') + '</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' + toggleHtml;
}

var progressByTopic = null; // stashed so the table can be re-sorted without a re-fetch
var progressSort = { key: 'topic', dir: 'asc' };
var progressTopicsExpanded = false; // collapsed by default -- a full topic list (30+ rows for
// notary) otherwise pushes the wrong-questions section below the fold, especially on mobile.
var PROGRESS_TOPICS_COLLAPSED_COUNT = 5;
// Accuracy/Coverage thresholds are both admin-configurable (progress_accuracy_pass_pct /
// progress_coverage_pass_pct in app_settings) and come back on the /progress payload -- shared by
// both the headline stat box and the per-topic table's own columns. These are just the
// client-side fallback if that's ever missing, matching the API's own defaults. Note this is
// distinct from the real exam's own pass score (EXAM_CONFIGS.notary.passPercent, currently also
// 70, used to grade actual mock exam attempts) -- that one is intentionally NOT admin-configurable
// here, it's a fact about the real exam, not a personal-progress goal.
var progressAccuracyPassPct = 80;
var progressCoveragePassPct = 50;

function progressTopicPct(t) { return t.total ? Math.round((100 * t.correct) / t.total) : 0; }
function progressTopicCoveragePct(t) { return t.topicTotal ? Math.round((100 * t.seen) / t.topicTotal) : 0; }

function progressTopicsTableHtml() {
  var key = progressSort.key, dir = progressSort.dir;
  var sorted = (progressByTopic || []).slice().sort(function (a, b) {
    var av = key === 'pct' ? progressTopicPct(a) : key === 'coverage' ? progressTopicCoveragePct(a) : key === 'total' ? a.total : a.topic.toLowerCase();
    var bv = key === 'pct' ? progressTopicPct(b) : key === 'coverage' ? progressTopicCoveragePct(b) : key === 'total' ? b.total : b.topic.toLowerCase();
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  var truncated = !progressTopicsExpanded && sorted.length > PROGRESS_TOPICS_COLLAPSED_COUNT;
  var visible = truncated ? sorted.slice(0, PROGRESS_TOPICS_COLLAPSED_COUNT) : sorted;
  var arrow = function (k) { return key === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''; };
  var rows = visible.map(function (t) {
    var pct = progressTopicPct(t);
    var coverage = progressTopicCoveragePct(t);
    var rowCls = pct < progressAccuracyPassPct ? 'progress-row-low' : 'progress-row-good';
    // Coverage gets its own cell-level color, independent of the row's accuracy-based color above
    // (a topic can be low-accuracy but well-covered, or vice versa -- two separate signals, can't
    // both be expressed as one row color).
    var coverageCls = coverage < progressCoveragePassPct ? 'progress-row-low' : 'progress-row-good';
    return '<tr class="' + rowCls + '"><td>' + t.topic + '</td><td>' + pct + '%</td>' +
      '<td><span class="' + coverageCls + '">' + coverage + '%</span></td><td>' + t.total + '</td></tr>';
  }).join('');
  var toggleHtml = sorted.length > PROGRESS_TOPICS_COLLAPSED_COUNT
    ? '<button class="btn-secondary btn-sm progress-topics-toggle" type="button" data-act="toggle-progress-topics">' +
      (truncated ? 'Show all ' + sorted.length + ' topics ▾' : 'Show fewer ▴') + '</button>'
    : '';
  return '<table class="progress-topics-table"><thead><tr>' +
    '<th data-act="sort-progress-topics" data-sort-key="topic">Topic' + arrow('topic') + '</th>' +
    '<th data-act="sort-progress-topics" data-sort-key="pct">Accuracy' + arrow('pct') + '</th>' +
    '<th data-act="sort-progress-topics" data-sort-key="coverage">Coverage' + arrow('coverage') + '</th>' +
    '<th data-act="sort-progress-topics" data-sort-key="total">Questions' + arrow('total') + '</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' + toggleHtml;
}

// Leaderboard -- top 3 by accuracy, top 3 by coverage, same track only, fetched as one deduped
// set from /leaderboard (see the Worker for why: it must guarantee the true top 3 for whichever
// metric the client sorts by, without a second round-trip). Descending-only sort, no ascending
// direction, since "who's lowest" isn't the point of a leaderboard.
var leaderboardUsers = [];
var leaderboardMinQuestions = 20;
var leaderboardSortKey = 'accuracy';

function leaderboardTableHtml() {
  if (!leaderboardUsers.length) {
    return '<p class="muted">No one on your track has answered at least ' + leaderboardMinQuestions + ' questions yet.</p>';
  }
  var key = leaderboardSortKey;
  var rows = leaderboardUsers.slice().sort(function (a, b) { return b[key] - a[key]; }).slice(0, 3).map(function (u) {
    return '<tr><td>' + u.code + '</td><td>' + u.accuracy + '%</td><td>' + u.coverage + '%</td><td>' + u.total + '</td><td>' + u.attempts + '</td></tr>';
  }).join('');
  var arrow = function (k) { return key === k ? ' ▼' : ''; };
  return '<table class="progress-topics-table leaderboard-table"><thead><tr>' +
    '<th>Code</th>' +
    '<th data-act="sort-leaderboard" data-sort-key="accuracy">Accuracy' + arrow('accuracy') + '</th>' +
    '<th data-act="sort-leaderboard" data-sort-key="coverage">Coverage' + arrow('coverage') + '</th>' +
    '<th>Questions</th>' +
    '<th>Attempts</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

var progressResetPending = null; // null | 'quiz' | 'all' -- which scope (if any) is awaiting confirmation

// In-page confirmation instead of a native confirm() popup, matching this app's own design
// system rather than an OS-native dialog for a destructive action.
function progressResetSectionHtml() {
  if (progressResetPending) {
    var scopeLabel = progressResetPending === 'all'
      ? 'your quiz progress AND all past Mock Exam attempts/scores'
      : 'your quiz progress (topic stats and wrong-questions list)';
    return '<div class="card progress-reset-card">' +
      '<p><strong class="result-incorrect">Reset ' + scopeLabel + '? This can\'t be undone.</strong></p>' +
      '<div class="progress-reset-actions">' +
      '<button class="btn-primary" type="button" data-act="progress-reset-confirm" data-scope="' + progressResetPending + '">Yes, reset</button>' +
      '<button class="btn-secondary" type="button" data-act="progress-reset-cancel">Cancel</button>' +
      '</div></div>';
  }
  return '<div class="card progress-reset-card">' +
    '<h3>Reset Progress</h3>' +
    '<p class="muted">Start fresh on the question rotation and wrong-questions list.</p>' +
    '<div class="progress-reset-actions">' +
    '<button class="btn-secondary btn-sm" type="button" data-act="progress-reset-select" data-scope="quiz">Reset quiz progress</button>' +
    '<button class="btn-secondary btn-sm" type="button" data-act="progress-reset-select" data-scope="all">Reset everything (incl. exam history)</button>' +
    '</div></div>';
}

async function renderProgress() {
  appEl.innerHTML = renderTabs('progress') + '<p class="muted">Loading…</p>';
  progressResetPending = null; // a fresh load (e.g. after a reset) always starts from the unconfirmed state
  examAttemptOpenId = null;
  examAttemptDetailCache = {};
  var results = await Promise.all([apiFetch('/progress'), apiFetch('/exam/history?mode=standard'), apiFetch('/exam/history?mode=toughest45'), apiFetch('/leaderboard')]);
  var p = results[0];
  var pct = p.totalAnswered ? Math.round((100 * p.totalCorrect) / p.totalAnswered) : 0;
  var wrong = p.totalAnswered - p.totalCorrect;
  progressByTopic = p.byTopic;
  var standardAttempts = (results[1].attempts || []).map(function (a) { a.mode = 'standard'; return a; });
  var toughest45Attempts = (results[2].attempts || []).map(function (a) { a.mode = 'toughest45'; return a; });
  progressExamAttempts = standardAttempts.concat(toughest45Attempts);
  leaderboardUsers = results[3].users || [];
  leaderboardMinQuestions = typeof results[3].minQuestions === 'number' ? results[3].minQuestions : leaderboardMinQuestions;

  // The totals above are a "last attempt wins" snapshot shared by quiz and mock exam (a question
  // answered in both only reflects whichever happened most recently) -- exam_attempts has no such
  // ambiguity per attempt, so it's the only way to show an exact mock-exam-only figure alongside.
  var examTotals = (results[1].attempts || []).reduce(function (acc, a) {
    acc.correct += a.correct; acc.total += a.total; return acc;
  }, { correct: 0, total: 0 });
  var examPct = examTotals.total ? Math.round((100 * examTotals.correct) / examTotals.total) : 0;
  var examBreakdownNote = examTotals.total
    ? 'Includes both quiz and mock exam questions — mock exam: ' + examTotals.correct + '/' + examTotals.total + ' (' + examPct + '%).'
    : 'Includes both quiz and mock exam questions — no mock exam attempts yet.';

  // Reuses the exact same review-item markup as the mock exam's answer review (question text,
  // A-D options with correct/wrong highlighting, explanation box) -- each <details> is the
  // "clickable" part, collapsed by default so the list stays scannable at a glance.
  var wrongQuestionsHtml = (p.wrongQuestions || []).map(function (r) {
    var choiceHtml = ['A', 'B', 'C', 'D'].map(function (k) {
      var cls = 'option-btn';
      if (k === r.correctChoice) cls += ' correct';
      else if (k === r.yourChoice) cls += ' wrong';
      return optionButtonHtml(k, r.choices[k], cls, 'disabled');
    }).join('');
    var yourAnswerNote = r.yourChoice
      ? '<strong class="result-incorrect">Your answer: ' + r.yourChoice + '.</strong> '
      : '<strong class="muted">You got this wrong on a past attempt, but we don\'t have your exact answer on file (from before we tracked ' +
        'picks, or it was skipped) — retake it to see your answer here.</strong> ';
    // name= groups these into a native exclusive accordion (browser closes any other open one in
    // the same group automatically) -- no JS needed, unlike the Exam Attempts sections which had
    // to be hand-rolled for the same effect since they need lazy-fetched detail on open.
    return '<details class="card mockexam-review-item" name="progress-wrong-questions">' +
      '<summary>' + r.topic + ' — ' + r.question.slice(0, 80) + (r.question.length > 80 ? '…' : '') + '</summary>' +
      '<div class="question-text">' + r.question + '</div>' +
      '<div class="options-grid">' + choiceHtml + '</div>' +
      '<div class="explanation-box">' + yourAnswerNote + r.explanation + '</div>' +
      '</details>';
  }).join('');
  var wrongQuestionsSection = wrong > 0
    ? '<h3 class="mockexam-review-heading">Questions you got wrong (' + (p.wrongQuestions || []).length + ')</h3>' +
      '<p class="muted">Click any question below to see your answer, the correct one, and why.</p>' +
      '<div class="progress-wrong-list">' + wrongQuestionsHtml + '</div>'
    : '';

  // Overall coverage across every topic in the exam (sum of the same seen/topicTotal fields the
  // per-topic table uses) -- distinct questions ever attempted, not attempt count, so retrying a
  // question you've already seen doesn't inflate it.
  var totalSeen = (p.byTopic || []).reduce(function (sum, t) { return sum + (t.seen || 0); }, 0);
  var totalPossible = (p.byTopic || []).reduce(function (sum, t) { return sum + (t.topicTotal || 0); }, 0);
  var coveragePct = totalPossible ? Math.round((100 * totalSeen) / totalPossible) : 0;
  if (typeof p.accuracyPassPct === 'number') progressAccuracyPassPct = p.accuracyPassPct;
  if (typeof p.coveragePassPct === 'number') progressCoveragePassPct = p.coveragePassPct;
  var accuracyValCls = pct < progressAccuracyPassPct ? 'wrong' : 'correct';
  var coverageValCls = coveragePct < progressCoveragePassPct ? 'wrong' : 'correct';

  var standardAttemptsCount = standardAttempts.length;
  var toughest45AttemptsCount = toughest45Attempts.length;

  var examAttemptsHtml = examAttemptsSectionHtml();

  // Radial rings for the two threshold-graded metrics (ported RadialProgress usage from v0's
  // study-hub.tsx) -- color reuses the same pass/fail logic as the stat-box classes below rather
  // than introducing a second source of truth for "did they clear the bar". The plain stats-bar
  // stays as-is alongside these -- it carries detail (raw right/wrong/total, attempt counts) the
  // rings don't, so this is additive, not a replacement.
  var progressRadialsHtml = '<div class="progress-radials">' +
    '<div class="progress-radial-tile">' + radialProgressSvg(pct, {
      size: 120, strokeWidth: 11, label: 'Accuracy',
      color: accuracyValCls === 'correct' ? 'var(--correct)' : 'var(--incorrect)',
    }) + '</div>' +
    '<div class="progress-radial-tile">' + radialProgressSvg(coveragePct, {
      size: 120, strokeWidth: 11, label: 'Coverage',
      color: coverageValCls === 'correct' ? 'var(--correct)' : 'var(--incorrect)',
    }) + '</div>' +
    '</div>';

  appEl.innerHTML = renderTabs('progress') +
    progressRadialsHtml +
    '<div class="stats-bar progress-stats-bar">' +
    '<div class="stat-box"><div class="label">Right/Wrong/Total</div><div class="val stat-triple">' +
    '<span class="correct">' + p.totalCorrect + '</span><span class="sep">/</span>' +
    '<span class="wrong">' + wrong + '</span><span class="sep">/</span>' +
    '<span class="total">' + p.totalAnswered + '</span></div></div>' +
    '<div class="stat-box"><div class="label">Accuracy</div><div class="val ' + accuracyValCls + '">' + pct + '%</div></div>' +
    '<div class="stat-box"><div class="label">Coverage</div><div class="val ' + coverageValCls + '">' + coveragePct + '%</div></div>' +
    '<div class="stat-box progress-attempts-stat"><div class="label">Attempts</div><div class="val">' +
    progressExamAttempts.length + ' (' + standardAttemptsCount + '+' + toughest45AttemptsCount + ')</div></div>' +
    '</div>' +
    '<p class="muted progress-breakdown-note">' + examBreakdownNote + '</p>' +
    '<div class="progress-tables-grid">' +
    '<div class="card progress-table-card">' +
    '<h3>Progress by Topic</h3>' +
    '<div id="progress-topics-wrap">' + progressTopicsTableHtml() + '</div>' +
    '</div>' +
    '<div class="card progress-table-card">' +
    '<h3 class="progress-leaderboard-heading">Leaderboard</h3>' +
    '<p class="muted page-intro-text">Top 3 by accuracy and by coverage among everyone on your track who\'s answered at least ' +
    leaderboardMinQuestions + ' questions.</p>' +
    '<div id="leaderboard-wrap">' + leaderboardTableHtml() + '</div>' +
    '</div>' +
    (examAttemptsHtml ? '<div class="card progress-table-card" id="exam-attempts-wrap">' + examAttemptsHtml + '</div>' : '<div id="exam-attempts-wrap"></div>') +
    '</div>' +
    wrongQuestionsSection +
    '<div id="progress-reset-wrap">' + progressResetSectionHtml() + '</div>';
}

// A REAL, answerable sample question on the track landing page itself -- distinct from
// trackLandingPreviewHtml()'s locked Quiz/Exam/Progress teaser further down this page, which is
// explicitly illustrative UI chrome, not a real question. Visitors clicking "View full track
// details" from a category page (see categoryHeroTrackLinkHtml/categoryBreakdownHtml) land here
// wanting to evaluate THIS track specifically; previously the only real sample question lived one
// more click away on the standalone #/sample page. Same select-then-submit + read-aloud pattern as
// categoryPageState.sampleQuestion (drawCategorySampleQuestion) -- a third near-identical copy
// rather than a shared abstraction, matching this codebase's existing precedent of one dedicated
// copy per surface (the standalone #/sample page's sampleState is the second) instead of unifying
// three call sites with meaningfully different surrounding state shapes.
var trackLandingSample = { question: null, selected: null, answered: null };

function trackLandingSampleWidgetHtml() {
  // "Live" badge (added 2026-09-02) pairs with the "Preview only" badge on the locked mockup
  // panels further down this same page (trackLandingPreviewHtml()) -- without it, this real,
  // answerable question and that illustrative mockup looked like the same kind of thing at a
  // glance, since both reuse the same .options-grid/.option-btn markup.
  return '<section class="category-sample" id="track-landing-sample">' +
    '<p class="section-eyebrow">Try before you buy</p>' +
    '<h2 class="comparison-heading">Interactive Sample Question <span class="badge locked-preview-badge-live">Live</span></h2>' +
    '<div id="track-landing-sample-wrap"><p class="muted">Loading…</p></div>' +
    '</section>';
}

async function loadTrackLandingSampleQuestion(exam) {
  var wrap = document.getElementById('track-landing-sample-wrap');
  if (!wrap) return;
  try {
    var res = await apiFetch('/sample?examType=' + encodeURIComponent(exam.examType));
    var q = (res.questions || [])[0];
    if (!q) { wrap.innerHTML = '<p class="muted">No sample available for this track yet.</p>'; return; }
    trackLandingSample.question = q;
    trackLandingSample.selected = null;
    trackLandingSample.answered = null;
    drawTrackLandingSampleQuestion();
    var qNode = questionJsonLd(q);
    qNode['@context'] = 'https://schema.org';
    injectJsonLd('track-landing-sample-jsonld', qNode);
  } catch (e) {
    wrap.innerHTML = '<p class="muted">Could not load a sample question. Try again shortly.</p>';
  }
}

function drawTrackLandingSampleQuestion() {
  var wrap = document.getElementById('track-landing-sample-wrap');
  var q = trackLandingSample.question;
  if (!wrap || !q) return;
  var answered = trackLandingSample.answered;
  var selected = trackLandingSample.selected;
  var prefixes = ['A', 'B', 'C', 'D'];
  var choiceHtml = prefixes.map(function (k) {
    var cls = 'option-btn';
    if (answered) {
      if (k === q.correctChoice) cls += ' correct';
      else if (k === answered) cls += ' wrong';
    } else if (k === selected) {
      cls += ' selected';
    }
    return optionButtonHtml(k, q.choices[k], cls, 'data-act="track-landing-sample-answer" data-choice="' + k + '"' + (answered ? ' disabled' : ''));
  }).join('');
  var submitControl = !answered
    ? '<div class="nav-controls"><button class="btn-primary" type="button" data-act="track-landing-sample-submit"' + (selected ? '' : ' disabled') + '>Submit Answer</button></div>'
    : '';
  var explanation = answered
    ? '<div class="explanation-box"><strong class="' + (answered === q.correctChoice ? 'result-correct' : 'result-incorrect') + '">' +
      (answered === q.correctChoice ? 'Correct.' : 'Incorrect.') + '</strong> ' + q.explanation + '</div>' +
      '<div class="nav-controls"><a class="btn-primary" href="#/sample">Try more free questions →</a></div>'
    : '';
  // Card wraps only the question stem, same as the real paid quiz (drawQuestion()), the standalone
  // #/sample page (drawSampleQuestion()), and the category page's identical widget (see its own
  // comment) -- choices/submit/explanation sit outside it on the bare page background, not inside
  // one big card like this widget used to.
  wrap.innerHTML = '<div class="card">' +
    '<div class="question-topic">' + escapeHtml(q.topic) + '</div><div class="question-text">' + escapeHtml(q.question) + '</div>' +
    '<div class="audio-actions"><button class="btn-secondary btn-sm" type="button" data-act="track-landing-sample-listen">🔊 Read aloud</button></div>' +
    '</div>' +
    '<div class="options-grid">' + choiceHtml + '</div>' + submitControl + explanation;
}

// ---- Track landing/sales page (logged-out visitors) -----------------------
// Consolidated single sales page (Round 2 redesign decision) -- replaces the previous four
// per-tab locked-preview mockups (one each for Quiz/Exam/Toughest45/Progress, each showing a
// blurred fake preview of that tab) with one persuasive page shown for ANY of those routes while
// logged out, or logged in for a different track. Reuses the same specs/breakdown markup the hub
// cards used to show before they were shrunk (kept in style.css for exactly this) and the
// checkout page's two-column .buy-layout pattern.
async function renderTrackLanding() {
  var exam = trackByExamType(state.examType);
  if (!exam) { renderHub(); return; }
  // 0.8KB and CDN-cached for 5 min -- fetched only on a track's own page, for that one track,
  // rather than shipping all 285 tracks' disclaimer prose in the bundle to every visitor.
  await loadTrackContent(exam.examType);
  // Lives right in the specs card (facts about THIS exam), not the purchase card further down --
  // it's a trust/verification link a skeptical, comparison-shopping visitor wants BEFORE deciding
  // to buy, not a purchase action, so a small inline link here reads better than a full-width
  // button competing with the real "Get Instant Access"/"Try a free sample" CTAs (its old spot).
  var infoLinks = trackInfoLinks(exam.examType);
  var officialLinkHtml = infoLinks.length
    ? '<p class="muted track-landing-official-inline">Verify with the official source: ' +
      '<a class="exam-track-view-link" href="' + infoLinks[0].url + '" target="_blank" rel="noopener noreferrer">Official exam info ↗</a></p>'
    : '';
  // Real freshness signal (MAX(questions.created_at) per track, from /track-registry -- see
  // examprep-api's handleTrackRegistryList) -- deliberately labeled "last updated," not "last
  // verified," since every addition to a track (including a pure pool-depth backfill) goes through
  // this site's same real-citation drafting process, but this timestamp can't itself prove a
  // full manual re-read of EVERY existing question in the bank happened on that date.
  var freshnessHtml = exam.questionsUpdatedAt
    ? '<p class="muted track-landing-freshness">🔄 Question bank last updated ' +
      new Date(exam.questionsUpdatedAt * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) +
      ' — every question is sourced from the current official handbook or statute, not third-party prep material.</p>'
    : '';
  var specsHtml = '<div class="exam-specs">' +
    '<div>⏱️ <strong>Duration:</strong> ' + exam.duration + '</div>' +
    '<div>📄 <strong>Questions:</strong> ' + exam.questions + '</div>' +
    '<div>🏆 <strong>Passing Score:</strong> ' + exam.passScore + '</div>' +
    '<div>📚 <strong>Study Resources:</strong> ' + resourceInventorySummary(exam.examType).full + '</div>' +
    '</div>' + officialLinkHtml + freshnessHtml;
  var breakdownHtml = '<div class="breakdown-label">Key Breakdown</div><div class="breakdown-list">' +
    exam.breakdown.map(function (b) {
      var pct = parseInt(b[1], 10) || 0;
      return '<div class="breakdown-row">' +
        '<div class="breakdown-row-top"><span>' + b[0] + '</span><span>' + b[1] + '</span></div>' +
        '<div class="breakdown-bar"><div class="breakdown-bar-fill pct-' + pct + '"></div></div>' +
        '</div>';
    }).join('') + '</div>';
  var compliance = trackCompliance(exam.examType);

  appEl.innerHTML =
    '<div class="track-landing">' +
    '<nav class="track-landing-breadcrumb" aria-label="Breadcrumb"><a href="/">Exams</a> / ' +
    '<a href="/' + kindSlug(exam.examKind) + '">' + escapeHtml(exam.examKind) + '</a> / ' +
    '<span class="breadcrumb-current">' + escapeHtml(STATE_LABELS[exam.stateCode] || exam.stateCode) + '</span></nav>' +
    // Points at the category page's own state picker (categoryStateSelectHtml) rather than
    // describing a mechanism to use in place -- this used to reference a header state picker that
    // was removed entirely during the category-first restructure (2026-08-25), leaving both the
    // "state picker" and "on mobile, open the ☰ menu first" halves of the old copy dead: there was
    // nothing left on this page, or in the header, for either sentence to actually point to.
    '<p class="muted track-landing-state-hint">Not studying for <strong class="state-name-emphasis">' + escapeHtml(STATE_LABELS[exam.stateCode] || exam.stateCode) + '</strong>? ' +
    '<a href="/' + kindSlug(exam.examKind) + '">Pick your state on the ' + escapeHtml(exam.examKind) + ' page →</a></p>' +
    '<div class="exam-track-top"><span class="badge">' + exam.category + '</span>' +
    '<span class="status-badge active"><span class="pulse-dot"></span>Active</span></div>' +
    '<h1>' + exam.title + '</h1>' +
    '<p class="muted page-intro-text track-landing-description">' + exam.description + '</p>' +
    '<div class="buy-layout">' +
    '<div class="buy-value-col"><div class="card">' + specsHtml + trackResourceStatsHtml(exam.examType) + breakdownHtml + '</div></div>' +
    '<div class="card">' +
    '<div id="track-landing-promotions-wrap" class="promotions-wrap"></div>' +
    '<div class="exam-track-price" id="landing-price">…</div>' +
    '<ul class="buy-feature-list">' +
    '<li>✓ Full question bank, unlimited practice</li>' +
    '<li>✓ Timed mock exam &amp; Weak Spots drills</li>' +
    '<li>✓ Voice-enabled answering &amp; read-aloud</li>' +
    '<li>✓ Per-topic progress tracking</li>' +
    '<li>✓ Pass-or-money-back guarantee</li>' +
    '</ul>' +
    '<div class="buy-cta-group">' +
    '<a class="btn-primary hub-cta" href="#/buy">Get Instant Access →</a>' +
    '<a class="btn-secondary hub-cta" href="#/sample">Try a free sample →</a>' +
    '</div>' +
    '<p class="muted redeem-sample-hint">Already have a code? <a href="#/redeem">Redeem it →</a></p>' +
    '<p class="muted track-landing-disclaimer">Not affiliated with, authorized by, sponsored by, or endorsed by ' + compliance.orgLine + '.</p>' +
    '</div>' +
    '</div>' +
    trackLandingSampleWidgetHtml() +
    '<section class="track-landing-preview-section">' +
    '<h2>Preview the study hub</h2>' +
    '<p class="muted">Here\'s what Quiz, Exam, and Progress look like inside this track — unlock to start.</p>' +
    trackLandingPreviewHtml(exam) +
    '</section>' +
    '<div id="track-landing-testimonials-wrap"></div>' +
    guaranteeCtaBandHtml() +
    '<div id="buy-other-tracks-wrap" class="track-landing-crosssell"></div>' +
    '</div>';

  apiFetch('/pricing?examType=' + encodeURIComponent(exam.examType)).then(function (p) {
    var priceStr = '$' + (p.priceCents / 100).toFixed(2);
    var el = document.getElementById('landing-price');
    if (el) el.textContent = priceStr;
    var previewPriceEl = document.getElementById('landing-preview-price');
    if (previewPriceEl) previewPriceEl.textContent = priceStr;
  }).catch(function () {
    var el = document.getElementById('landing-price');
    if (el) el.textContent = '';
  });
  loadOtherTracksPricing();
  fillTrackLandingResourcePreview(exam.examType);
  loadTrackLandingSampleQuestion(exam);
  // Same testimonials the exam's own category landing page shows (category_content is keyed by
  // category slug, not per-track) -- real, relevant social proof for THIS exam kind, not a fake
  // per-track set that would need authoring 190+ times over.
  apiFetch('/category-content?slug=' + encodeURIComponent(kindSlug(exam.examKind))).then(function (res) {
    var content = (res.categories || [])[0] || null;
    var wrap = document.getElementById('track-landing-testimonials-wrap');
    if (wrap) wrap.innerHTML = categoryTestimonialsHtml(content && content.testimonials);
  }).catch(function () { /* best-effort -- section just stays empty */ });
  // Same "home" promos the hub shows -- this page IS the funnel entry point for this specific
  // track, so a discount visible on the unscoped hub should be visible here too.
  Promise.all([apiFetch('/promotions?placement=home'), loadSiteConfig()]).then(function (results) {
    var r = results[0];
    var wrap = document.getElementById('track-landing-promotions-wrap');
    if (wrap) wrap.innerHTML = promoBannersHtml(r.promotions || [], false);
  }).catch(function () { /* best-effort -- page still works without it */ });
}

// Tabbed Quiz/Exam/Progress teaser, embedded directly on the landing page (client-side tab switch,
// no navigation) -- ports v0's locked-preview.tsx as a widget rather than the separate routed
// pages this site used to have (see the Stage 6 consolidation note above). Blurred + overlaid with
// an unlock CTA, same as before -- the example content inside is illustrative (what the UI looks
// like), not a claim about the viewer's own data, same category as the sample question mockups
// this site has always shown to logged-out visitors.
// Split out of trackLandingPreviewHtml so the same markup can be re-rendered in place once that
// track's items arrive, without re-rendering the whole landing page.
function trackLandingResourcePreviewInnerHtml(examType) {
  var resourceItems = (RESOURCES[examType] || []).slice(0, 4);
  return (resourceItems.length ? resourceItems.map(function (r) {
    return '<div class="card locked-preview-resource-card">' +
      '<div class="locked-preview-resource-title">' + escapeHtml(r.title) + (r.free ? ' <span class="badge">Free</span>' : '') + '</div>' +
      '<p class="muted">' + escapeHtml(r.desc) + '</p>' +
      '</div>';
  }).join('') : '<p class="muted">Study resources for this track.</p>') +
    '<a class="muted locked-preview-seeall" href="#/resources">See all resources →</a>';
}

function fillTrackLandingResourcePreview(examType) {
  if (RESOURCES[examType]) return; // already loaded -- first render was already correct
  loadTrackResources(examType).then(function () {
    var wrap = document.getElementById('locked-preview-resources');
    if (wrap) wrap.innerHTML = trackLandingResourcePreviewInnerHtml(examType);
  });
}

function trackLandingPreviewHtml(exam) {
  var firstTopic = (exam.breakdown && exam.breakdown[0] && exam.breakdown[0][0]) || 'the exam topics';
  // "Preview only" badge (added 2026-09-02) -- makes it visually obvious at a glance that these
  // three gated panels are illustrative mockups, not real interactive content, regardless of tab
  // state or the mockup's own (deliberately light, see .locked-preview-mockup's own comment) blur.
  // Resources/Info panels don't get it since they show real, unblurred, un-gated content.
  var previewOnlyBadge = '<span class="badge locked-preview-badge">Preview only</span>';
  var quizPanel = '<div class="locked-preview-quiz">' +
    previewOnlyBadge +
    '<p class="muted locked-preview-meta">Question 4 of ' + exam.questions + ' · ' + escapeHtml(firstTopic) + '</p>' +
    '<h4>Sample question about ' + escapeHtml(firstTopic) + '</h4>' +
    '<div class="options-grid">' + ['A', 'B', 'C', 'D'].map(function (k) {
      return optionButtonHtml(k, 'Answer choice ' + k, 'option-btn', 'disabled');
    }).join('') + '</div>' +
    '</div>';
  var examPanel = '<div class="locked-preview-exam">' +
    previewOnlyBadge +
    '<div class="locked-preview-exam-bar"><span>Mock exam in progress</span><span>28:14</span></div>' +
    '<div class="breakdown-bar locked-preview-exam-track"><div class="breakdown-bar-fill pct-33"></div></div>' +
    '<p class="muted">' + exam.questions + ' · ' + exam.duration + ' · pass at ' + exam.passScore + '</p>' +
    '<div class="card"><p>No feedback until you finish — just like the real thing.</p></div>' +
    '</div>';
  var progressPanel = '<div class="locked-preview-progress-panel">' +
    previewOnlyBadge +
    radialProgressSvg(82, { size: 96, strokeWidth: 9, label: 'Accuracy' }) +
    radialProgressSvg(64, { size: 96, strokeWidth: 9, label: 'Coverage', color: 'var(--highlight)' }) +
    '</div>';

  // Resources and Info aren't login-gated at all (see renderTabs()'s `gated` map -- only
  // quiz/exam/toughest45/progress require an account), so unlike the three panels above these show
  // real, un-blurred content straight from the same data every visitor already sees on #/resources
  // and #/info, not a fabricated mockup. Each links out to that real tab to explore further.
  // Needs real item titles/descs, which live in the per-track payload rather than the counts map --
  // so this panel fills in a moment later (see fillTrackLandingResourcePreview) rather than the
  // page blocking on that fetch. Same progressive-enhancement posture as this page's promo and
  // pricing slots.
  var resourcesPanel = '<div class="locked-preview-resources" id="locked-preview-resources">' +
    trackLandingResourcePreviewInnerHtml(exam.examType) +
    '</div>';
  var infoLinks = trackInfoLinks(exam.examType).slice(0, 3);
  var infoPanel = '<div class="locked-preview-info">' +
    (infoLinks.length ? infoLinks.map(function (l) {
      return '<a class="card additional-info-card" href="' + l.url + '" target="_blank" rel="noopener noreferrer">' +
        '<div class="additional-info-title">' + escapeHtml(l.title) + ' ↗</div>' +
        '<p class="muted">' + escapeHtml(l.desc) + '</p>' +
        '</a>';
    }).join('') : '<p class="muted">Official exam information for this track.</p>') +
    '<a class="muted locked-preview-seeall" href="#/info">See all official info →</a>' +
    '</div>';

  return '<div class="locked-preview-tabs-wrap">' +
    '<div class="locked-preview-tabs" role="tablist">' +
    '<button type="button" class="active" data-act="landing-preview-tab" data-tab="resources">Resources</button>' +
    '<button type="button" data-act="landing-preview-tab" data-tab="quiz">Quiz</button>' +
    '<button type="button" data-act="landing-preview-tab" data-tab="exam">Exam</button>' +
    '<button type="button" data-act="landing-preview-tab" data-tab="progress">Progress</button>' +
    '<button type="button" data-act="landing-preview-tab" data-tab="info">Info</button>' +
    '</div>' +
    '<div class="locked-preview-body">' +
    '<div class="locked-preview-mockup is-open" data-preview-panel="resources">' + resourcesPanel + '</div>' +
    '<div class="locked-preview-mockup" data-preview-panel="quiz" hidden>' + quizPanel + '</div>' +
    '<div class="locked-preview-mockup" data-preview-panel="exam" hidden>' + examPanel + '</div>' +
    '<div class="locked-preview-mockup" data-preview-panel="progress" hidden>' + progressPanel + '</div>' +
    '<div class="locked-preview-mockup is-open" data-preview-panel="info" hidden>' + infoPanel + '</div>' +
    '<div class="locked-preview-overlay" id="landing-preview-overlay" hidden>' +
    '<div class="locked-preview-icon">🔒</div>' +
    '<p id="landing-preview-unlock-text">Unlock the full quiz for this track</p>' +
    '<a class="btn-primary hub-cta" href="#/buy">Unlock for <span id="landing-preview-price">…</span></a>' +
    '</div>' +
    '</div>' +
    '</div>';
}

// ---- Additional information (official external links, per exam type) -----
// A separate table from HUB_EXAMS, keyed the same way (examType) but not auto-derived from it --
// nothing enforces that every active HUB_EXAMS entry has a matching entry here. That's exactly how
// this went stale: only ca_notary was ever filled in (2026-08-13ish), and every batch of new
// tracks added since (real estate, driver, motorcycle, CDL) skipped it entirely, leaving the
// "Official exam info" link on renderTrackLanding() silently empty for ~211 of 212 active tracks
// until a dedicated research pass filled in notary/real_estate/cdl on 2026-08-25 (git log for
// this file around that date). When adding a new state/category, research and add its
// ADDITIONAL_INFO_LINKS entry (or entries) in the SAME pass
// as the HUB_EXAMS entry -- real, verified official source URLs only, never fabricated (a missing
// entry just means the link doesn't render, which is safe; a wrong URL is not).
// ADDITIONAL_INFO_LINKS lived here as a ~153KB object literal (official 'verify this yourself'
// links per track). Migrated to D1's `track_content` table 2026-09-05 alongside TRACK_COMPLIANCE;
// read via trackInfoLinks(examType).


async function renderAdditionalInfo() {
  await loadTrackContent(state.examType);
  var links = trackInfoLinks(state.examType);
  var linkCards = links.map(function (l) {
    return '<a class="card additional-info-card" href="' + l.url + '" target="_blank" rel="noopener noreferrer">' +
      '<div class="additional-info-title">' + l.title + ' ↗</div>' +
      '<p class="muted">' + l.desc + '</p>' +
      '<div class="additional-info-url">' + l.url + '</div>' +
      '</a>';
  }).join('');
  appEl.innerHTML = renderTabs('info') +
    '<h1>Additional Information</h1>' +
    '<p class="muted page-intro-text">Official, outside resources for the real exam — registration, scheduling, and state program details.</p>' +
    linkCards;
}

// ---- Timed mock exam (+ "Weak Spots", a harder variant) ------------------
// A single-sitting, timed simulation of the real exam -- no per-question feedback, free
// navigation between questions, and a countdown clock computed from the server's own
// startedAt (not a client-only timer), so a refresh mid-sitting resumes in place rather than
// restarting the clock or handing out a fresh question set.
//
// Both the regular exam and "Weak Spots" (same timed format, but every question is drawn from
// ones you've previously gotten wrong -- see pickToughest45Questions in the Worker) share all of
// this code, distinguished only by a `mode` ('standard' | 'toughest45') threaded through every
// function and echoed in the server's exam_attempts row, rather than duplicating ~250 lines for a
// second tab that's otherwise identical. examTabKey/examHistoryHash/examMainHash below are the
// only mode-to-string mappings -- every other function just forwards the mode value it's given.

function examTabKey(mode) { return mode === 'toughest45' ? 'toughest45' : 'exam'; }
function examHistoryHash(mode) { return mode === 'toughest45' ? '#/toughest45-history' : '#/exam-history'; }
function examMainHash(mode) { return mode === 'toughest45' ? '#/toughest45' : '#/exam'; }

// A failed apiFetch on any exam load/action was showing the same generic "try again shortly" text
// regardless of cause -- including a plain expired/invalidated session (401, e.g. the same access
// code redeemed on another device), which looks like a mysterious server error instead of the
// ordinary "please log in again" it actually is. apiFetch's 401 path already clears the token
// before throwing, so reloading naturally lands back on the redeem/login page.
function examErrorHtml(e, genericMsg) {
  return e && e.status === 401
    ? '<p>Your session has ended (often just means this access code was used to log in somewhere ' +
      'else). <button class="btn-primary btn-sm" type="button" data-act="reload-for-update">Log in again</button></p>'
    : genericMsg;
}

var examState = { attempt: null, config: null, currentIndex: 0, timerHandle: null, mode: 'standard' };

async function renderExam(mode) {
  mode = mode || 'standard';
  appEl.innerHTML = renderTabs(examTabKey(mode)) + '<p class="muted">Loading…</p>';
  try {
    var current = await apiFetch('/exam/current?mode=' + mode);
    if (current.attempt) { enterExamSitting(current.attempt, mode); return; }
    await renderExamIntro(mode);
  } catch (e) {
    appEl.innerHTML = renderTabs(examTabKey(mode)) + examErrorHtml(e, '<p>Could not load the exam. Try again shortly.</p>');
  }
}

async function renderExamIntro(mode) {
  mode = mode || 'standard';
  examState.mode = mode; // so the age-category picker's change handler can re-render with the right mode
  var isToughest = mode === 'toughest45';
  var config = await apiFetch('/exam/config' + (examAgeCategoryOverride ? '?ageCategory=' + examAgeCategoryOverride : ''));
  examState.config = config;
  // Awaited explicitly rather than relying on the footer's own load having already populated it --
  // a hard navigation straight to this URL would otherwise race, and this disclaimer (plus the
  // pass-score note below) must be this track's real wording, never the generic fallback.
  await loadTrackContent(state.examType);
  var compliance = trackCompliance(state.examType);
  var isCaDriver = config.examType === 'ca_driver';
  var questionSourceLine = isToughest
    ? '<li>Built <strong>entirely from questions you\'ve gotten wrong before</strong> -- up to ' + config.questionCount +
      ', but could be fewer if you currently have less than that missed (no filler questions)</li>'
    : '<li><strong>' + config.questionCount + ' questions</strong>, drawn at random from the full question bank</li>';
  var isUntimed = !config.durationSec;
  appEl.innerHTML = renderTabs(examTabKey(mode)) +
    '<h1>' + (isToughest ? 'Weak Spots' : (isUntimed ? 'Practice Exam' : 'Timed Practice Exam')) + '</h1>' +
    (isToughest ? '<p class="muted page-intro-text">Same format as the practice exam, but every question is one you\'ve missed before -- a focused drill on your actual weak spots.</p>' : '') +
    '<div class="card mockexam-intro-card">' +
    '<p>This mimics the real exam format as closely as possible:</p>' +
    '<ul class="mockexam-intro-list">' +
    questionSourceLine +
    (isUntimed
      ? '<li><strong>No time limit</strong>, matching the real test — take as long as you need</li>'
      : '<li><strong>' + Math.round(config.durationSec / 60) + '-minute</strong> timer, running continuously in one sitting</li>') +
    '<li>No answer feedback until you finish — just like the real thing</li>' +
    '<li>Need <strong>' + config.passPercent + '%</strong> to pass (' + compliance.passScoreNote + ')</li>' +
    '</ul>' +
    '<p class="muted">' + (isUntimed
      ? 'This stays open even if you close this tab — reopening it will resume right where you left off, not restart. There\'s no pausing.'
      : 'Once started, the clock keeps running even if you close this tab — reopening it will resume right where you left off, not restart. There\'s no pausing.') + '</p>' +
    '<p class="exam-disclaimer-callout">This is an independent practice tool, not the official state exam. Completing it does not ' +
    compliance.examIntroDisclaimer + '</p>' +
    (isToughest ? '' :
      '<label class="auto-advance-toggle">' +
      '<input type="checkbox" data-act="toggle-exam-unseen-only"' + (examUnseenOnly ? ' checked' : '') + '> ' +
      'Only questions I haven\'t seen before (exam may run shorter than ' + config.questionCount + ')</label>') +
    (isCaDriver
      ? '<label class="muted buy-email-label">Written test format for this attempt</label>' +
        '<select data-act="change-exam-age-category">' +
        '<option value=""' + (examAgeCategoryOverride === '' ? ' selected' : '') + '>Use my account default (18+ if none set)</option>' +
        '<option value="18plus"' + (examAgeCategoryOverride === '18plus' ? ' selected' : '') + '>18 or older — 36 questions</option>' +
        '<option value="under18"' + (examAgeCategoryOverride === 'under18' ? ' selected' : '') + '>Under 18 (permit) — 46 questions</option>' +
        '</select>'
      : '') +
    '<button class="btn-primary" type="button" data-act="exam-begin" data-mode="' + mode + '">Begin Exam →</button>' +
    '<a class="btn-secondary exam-history-link" href="' + examHistoryHash(mode) + '">View past attempts →</a>' +
    '</div>';
}

async function renderExamHistory(mode) {
  mode = mode || 'standard';
  var examLabel = mode === 'toughest45' ? 'Weak Spots exam' : 'practice exam';
  appEl.innerHTML = renderTabs(examTabKey(mode)) + '<p class="muted">Loading past attempts…</p>';
  try {
    var res = await apiFetch('/exam/history?mode=' + mode);
    if (!res.attempts.length) {
      appEl.innerHTML = renderTabs(examTabKey(mode)) + '<h1>Past Attempts</h1>' +
        '<p class="muted">You haven\'t completed a ' + examLabel + ' yet.</p>' +
        '<a class="btn-primary hub-cta" href="' + examMainHash(mode) + '">Take one now →</a>';
      return;
    }
    var rows = res.attempts.map(function (a) {
      var date = new Date(a.submittedAt * 1000).toLocaleString();
      return '<a class="card exam-history-row" href="' + examHistoryHash(mode) + '/' + a.attemptId + '">' +
        '<span>' + date + '</span>' +
        '<span class="' + (a.passed ? 'exam-attempt-score-passed' : 'exam-attempt-score-failed') + '">' + a.correct + ' / ' + a.total + '</span>' +
        '</a>';
    }).join('');
    appEl.innerHTML = renderTabs(examTabKey(mode)) +
      '<h1>Past Attempts</h1>' +
      '<p class="muted page-intro-text">Every ' + examLabel + ' you\'ve completed, most recent first. Tap one to review your answers.</p>' +
      '<div class="exam-history-list">' + rows + '</div>' +
      '<a class="btn-secondary hub-cta" href="' + examMainHash(mode) + '">← Back to exam</a>';
  } catch (e) {
    appEl.innerHTML = renderTabs(examTabKey(mode)) + examErrorHtml(e, '<p>Could not load your past attempts. Try again shortly.</p>');
  }
}

async function renderExamAttemptDetailView(attemptId, mode) {
  mode = mode || 'standard';
  appEl.innerHTML = renderTabs(examTabKey(mode)) + '<p class="muted">Loading…</p>';
  try {
    var result = await apiFetch('/exam/attempt?attemptId=' + encodeURIComponent(attemptId));
    renderExamResults(result, { fromHistory: true, mode: mode });
  } catch (e) {
    appEl.innerHTML = renderTabs(examTabKey(mode)) +
      examErrorHtml(e, '<p>Could not load this attempt.</p><a class="btn-secondary hub-cta" href="' + examHistoryHash(mode) + '">← Back to past attempts</a>');
  }
}

async function beginExam(mode) {
  mode = mode || 'standard';
  var unseenOnly = mode === 'standard' && examUnseenOnly;
  appEl.innerHTML = renderTabs(examTabKey(mode)) + '<p class="muted">Starting…</p>';
  try {
    var attempt = await apiFetch('/exam/start', { method: 'POST', body: { mode: mode, unseenOnly: unseenOnly, ageCategory: examAgeCategoryOverride || undefined } });
    enterExamSitting(attempt, mode);
  } catch (e) {
    // Weak Spots has no backfill -- a user with nothing currently wrong gets 'no_questions' here,
    // which deserves an explanation ("go miss some questions first") rather than a generic error.
    // Same idea for "unseen only" -- a user who's seen the whole bank gets 'no_unseen_questions'.
    var errCode = e.data && e.data.error;
    var msg = errCode === 'no_unseen_questions'
      ? '<p>You\'ve already seen every question in the bank at least once — nice work! Turn off ' +
        '"Only questions I haven\'t seen before" to take a normal exam.</p>'
      : errCode === 'no_questions' && mode === 'toughest45'
      ? '<p>You don\'t have any wrongly-answered questions right now -- nothing to drill on yet. ' +
        'Take the Quiz or the regular Exam first, and missed questions will show up here.</p>'
      : examErrorHtml(e, '<p>Could not start the exam. Try again shortly.</p>');
    appEl.innerHTML = renderTabs(examTabKey(mode)) + msg;
  }
}

function enterExamSitting(attempt, mode) {
  examState.attempt = attempt;
  examState.mode = mode || attempt.mode || 'standard';
  examState.currentIndex = 0;
  examSubmitConfirmPending = false;
  examDiscardConfirmPending = false;
  drawExamSitting();
  speakCurrentExamQuestion();
  startExamTimer();
}

function examSecondsRemaining() {
  var a = examState.attempt;
  var elapsed = Math.floor(Date.now() / 1000) - a.startedAt;
  return Math.max(0, a.durationSec - elapsed);
}

function formatClock(seconds) {
  var m = Math.floor(seconds / 60), s = seconds % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function startExamTimer() {
  if (examState.timerHandle) clearInterval(examState.timerHandle);
  if (!examState.attempt.durationSec) return; // untimed track -- no countdown, nothing to auto-submit
  examState.timerHandle = setInterval(function () {
    var el = document.getElementById('exam-timer-display');
    if (!el) { clearInterval(examState.timerHandle); examState.timerHandle = null; return; } // navigated away
    var remaining = examSecondsRemaining();
    el.textContent = formatClock(remaining);
    if (remaining <= 60) el.classList.add('mockexam-timer-low');
    if (remaining <= 0) { clearInterval(examState.timerHandle); examState.timerHandle = null; submitExam(); }
  }, 1000);
}

// In-page (non-native) confirmation instead of window.confirm(), matching the Reset Progress
// pattern (progressResetSectionHtml) -- only shown once Submit is clicked with questions still
// unanswered; hidden otherwise.
function examSubmitConfirmHtml(attempt) {
  if (!examSubmitConfirmPending) return '';
  var unanswered = attempt.questions.length - Object.keys(attempt.answers).length;
  return '<div class="card progress-reset-card">' +
    '<p><strong class="result-incorrect">' + unanswered + ' question' + (unanswered === 1 ? '' : 's') +
    ' unanswered. Submit anyway?</strong></p>' +
    '<div class="progress-reset-actions">' +
    '<button class="btn-primary" type="button" data-act="exam-submit-confirmed">Yes, submit</button>' +
    '<button class="btn-secondary" type="button" data-act="exam-submit-cancel">Cancel</button>' +
    '</div></div>';
}

// Same in-page confirmation pattern -- for interruptions (an emergency, needing a break, etc.)
// where the user wants to bail on this sitting entirely rather than finish or wait out the clock.
// Deliberately vanishes with no trace (not kept as an "abandoned" attempt) -- this is a practice
// exam, not a certification, so there's nothing to lose by not recording a bailed-on attempt.
function examDiscardConfirmHtml() {
  if (!examDiscardConfirmPending) return '';
  return '<div class="card progress-reset-card">' +
    '<p><strong class="result-incorrect">Discard this attempt and start over? Your answers so far will be lost -- this can\'t be undone.</strong></p>' +
    '<div class="progress-reset-actions">' +
    '<button class="btn-primary" type="button" data-act="exam-discard-confirmed">Yes, discard</button>' +
    '<button class="btn-secondary" type="button" data-act="exam-discard-cancel">Cancel</button>' +
    '</div></div>';
}

function drawExamSitting() {
  var attempt = examState.attempt;
  var q = attempt.questions[examState.currentIndex];
  var answeredCount = Object.keys(attempt.answers).length;

  // Collapsed by default -- a 45-box grid eats a lot of vertical space, especially on mobile
  // where it can push the actual question below the fold before the user scrolls.
  var navGridHtml = '<button class="btn-secondary btn-sm exam-nav-toggle" type="button" data-act="toggle-exam-nav">' +
    (examNavExpanded ? 'Hide question list ▲' : 'Jump to a question ▾') + '</button>';
  if (examNavExpanded) {
    var navGrid = attempt.questions.map(function (question, i) {
      var cls = 'mockexam-nav-btn';
      if (i === examState.currentIndex) cls += ' current';
      if (attempt.answers[question.id]) cls += ' answered';
      return '<button type="button" class="' + cls + '" data-act="exam-goto" data-index="' + i + '">' + (i + 1) + '</button>';
    }).join('');
    navGridHtml += '<div class="mockexam-nav-grid">' + navGrid + '</div>';
  }

  var choiceHtml = ['A', 'B', 'C', 'D'].map(function (k) {
    var cls = 'option-btn';
    if (attempt.answers[q.id] === k) cls += ' selected';
    return optionButtonHtml(k, q.choices[k], cls, 'type="button" data-act="exam-answer" data-choice="' + k + '"');
  }).join('');

  appEl.innerHTML = renderTabs(examTabKey(examState.mode)) +
    '<div class="mockexam-header">' +
    '<div>Question ' + (examState.currentIndex + 1) + ' of ' + attempt.questions.length +
    ' — <span class="muted">' + answeredCount + ' answered</span></div>' +
    '<div class="mockexam-timer" id="exam-timer-display">' + (attempt.durationSec ? formatClock(examSecondsRemaining()) : 'No time limit') + '</div>' +
    '<label class="auto-advance-toggle">' +
    '<input type="checkbox" data-act="toggle-exam-autoadvance"' + (examAutoAdvance ? ' checked' : '') + '> ' +
    'Auto-advance after I answer</label>' +
    '<label class="auto-advance-toggle">' +
    '<input type="checkbox" data-act="toggle-exam-autoread"' + (examAutoRead ? ' checked' : '') + '> ' +
    'Auto-read question</label>' +
    '</div>' +
    navGridHtml +
    '<div class="card">' +
    '<div class="question-topic">' + q.topic + '</div>' +
    '<div class="question-text">' + q.question + '</div>' +
    // Duplicates the "Question X of N" count from .mockexam-header above -- scrollToQuestion()
    // lands the question text at the top of the viewport, scrolling that header (and this count
    // with it) out of view, so this copy stays visible no matter where the page has scrolled to.
    '<div class="question-progress-note muted">Question ' + (examState.currentIndex + 1) + ' of ' + attempt.questions.length + '</div>' +
    '<div class="audio-actions"><button class="btn-secondary btn-sm" type="button" data-act="exam-listen">🔊 Read aloud</button></div>' +
    '</div>' +
    '<div class="options-grid">' + choiceHtml + '</div>' +
    '<div class="nav-controls mockexam-controls">' +
    '<button class="btn-secondary" type="button" data-act="exam-prev"' + (examState.currentIndex === 0 ? ' disabled' : '') + '>← Previous</button>' +
    '<button class="btn-secondary" type="button" data-act="exam-next"' + (examState.currentIndex === attempt.questions.length - 1 ? ' disabled' : '') + '>Next →</button>' +
    '<button class="btn-primary" type="button" data-act="exam-submit-confirm">Submit Exam</button>' +
    '</div>' +
    '<div class="exam-discard-actions">' +
    '<button class="btn-secondary btn-sm" type="button" data-act="exam-discard-confirm">Discard &amp; Restart</button>' +
    '</div>' +
    examSubmitConfirmHtml(attempt) + examDiscardConfirmHtml();
}

// Called explicitly from question-navigation actions (goto/prev/next/begin/auto-advance), NOT
// from drawExamSitting() itself -- that also re-renders for reasons that aren't a new question
// (selecting an answer, toggling a checkbox), which would otherwise re-read the same question
// from the start every time.
function speakCurrentExamQuestion() {
  if (!examAutoRead) return;
  var attempt = examState.attempt;
  speak(questionReadText(attempt.questions[examState.currentIndex]));
}

// Stops a sitting whose attempt has died server-side (already submitted, or expired past its
// duration_sec) -- e.g. resumed on a second device/tab that then submitted it, or a stale tab
// reopened well after the timer ran out elsewhere. Every /exam/answer from here on would silently
// fail to save (server rejects with 'already_submitted'/'attempt_not_found'), so this must stop
// the sitting immediately rather than let the user keep answering into a session that's no longer
// being recorded -- see the 2026-08-06 incident where 45 minutes of real answers were silently
// dropped this way after a stale in-progress attempt got resumed and submitted from elsewhere.
function examSittingDied() {
  if (examState.timerHandle) { clearInterval(examState.timerHandle); examState.timerHandle = null; }
  appEl.innerHTML = renderTabs(examTabKey(examState.mode)) +
    '<h1>This exam session ended</h1>' +
    '<p class="error-text">This attempt was already submitted or has expired -- possibly resumed and ' +
    'finished from another device or browser tab on this account. Answers entered after that point ' +
    'were not saved, sorry about that.</p>' +
    '<a class="btn-primary hub-cta" href="' + examMainHash(examState.mode) + '">← Back to ' +
    (examState.mode === 'toughest45' ? 'Weak Spots' : 'Exam') + '</a>';
}

async function selectExamAnswer(choice) {
  var attempt = examState.attempt;
  var q = attempt.questions[examState.currentIndex];
  attempt.answers[q.id] = choice;
  drawExamSitting();
  try {
    await apiFetch('/exam/answer', { method: 'POST', body: { attemptId: attempt.attemptId, questionId: q.id, choice: choice } });
  } catch (e) {
    if (e.data && (e.data.error === 'already_submitted' || e.data.error === 'attempt_not_found')) {
      examSittingDied();
      return;
    }
    // Anything else (e.g. time_expired in the final seconds) is best-effort -- the countdown
    // timer's own auto-submit-at-zero will surface it within moments regardless.
  }
  // Regardless of right/wrong -- the exam never reveals that anyway -- just moves navigation
  // forward one step, same as manually clicking Next →. Stays put on the last question (nothing
  // to advance to; Submit is the natural next action there).
  if (examAutoAdvance && examState.currentIndex < attempt.questions.length - 1) {
    examState.currentIndex++;
    drawExamSitting();
    scrollToQuestion();
    speakCurrentExamQuestion();
  }
}

async function submitExam() {
  var attempt = examState.attempt;
  var mode = examState.mode;
  if (examState.timerHandle) { clearInterval(examState.timerHandle); examState.timerHandle = null; }
  appEl.innerHTML = renderTabs(examTabKey(mode)) + '<p class="muted">Scoring your exam…</p>';
  try {
    var result = await apiFetch('/exam/submit', { method: 'POST', body: { attemptId: attempt.attemptId } });
    renderExamResults(result, { mode: mode });
  } catch (e) {
    appEl.innerHTML = renderTabs(examTabKey(mode)) + examErrorHtml(e, '<p>Could not submit the exam. Try again shortly.</p>');
  }
}

async function discardExam() {
  var attempt = examState.attempt;
  var mode = examState.mode;
  if (examState.timerHandle) { clearInterval(examState.timerHandle); examState.timerHandle = null; }
  appEl.innerHTML = renderTabs(examTabKey(mode)) + '<p class="muted">Discarding…</p>';
  try {
    await apiFetch('/exam/discard', { method: 'POST', body: { attemptId: attempt.attemptId } });
  } catch (e) {
    // already_submitted/attempt_not_found just means there's nothing left to discard (e.g. it
    // finished on another tab first) -- either way, falling through to a fresh intro screen is
    // the right outcome, so this isn't treated as an error worth surfacing.
  }
  examState.attempt = null;
  await renderExamIntro(mode);
}

// Shared by the mock exam's own review (full attempt, all questions) and the Progress tab's
// per-attempt exam history (wrong questions only) -- one attempt's question-review card.
function examReviewItemHtml(r, i) {
  var choiceHtml = ['A', 'B', 'C', 'D'].map(function (k) {
    var cls = 'option-btn';
    if (k === r.correctChoice) cls += ' correct';
    else if (k === r.yourChoice) cls += ' wrong';
    return optionButtonHtml(k, r.choices[k], cls, 'disabled');
  }).join('');
  var yourAnswerNote = r.yourChoice
    ? '<strong class="' + (r.correct ? 'result-correct' : 'result-incorrect') + '">' + (r.correct ? 'Correct.' : 'Incorrect.') + '</strong> '
    : '<strong class="result-incorrect">Not answered.</strong> ';
  return '<details class="card mockexam-review-item" data-correct="' + (r.correct ? 'true' : 'false') + '">' +
    '<summary>Question ' + (i + 1) + ' — ' + (r.correct ? '✅' : '❌') + ' ' + r.topic + '</summary>' +
    '<div class="question-text">' + r.question + '</div>' +
    '<div class="options-grid">' + choiceHtml + '</div>' +
    '<div class="explanation-box">' + yourAnswerNote + r.explanation + '</div>' +
    '</details>';
}

function renderExamResults(result, opts) {
  opts = opts || {};
  var mode = opts.mode || 'standard';
  var reviewHtml = result.review.map(examReviewItemHtml).join('');

  var dateNote = opts.fromHistory && result.submittedAt
    ? '<p class="muted">Taken ' + new Date(result.submittedAt * 1000).toLocaleString() + '</p>' : '';
  var ctaHtml = opts.fromHistory
    ? '<a class="btn-secondary hub-cta" href="' + examHistoryHash(mode) + '">← Back to past attempts</a>'
    : '<button class="btn-primary hub-cta" type="button" data-act="exam-restart" data-mode="' + mode + '">Take another ' +
      (mode === 'toughest45' ? 'Weak Spots exam' : 'practice exam') + ' →</button>';

  appEl.innerHTML = renderTabs(examTabKey(mode)) +
    '<h1>' + (result.passed ? 'You passed! 🎉' : 'Not quite — keep studying') + '</h1>' +
    dateNote +
    '<div class="stats-bar">' +
    '<div class="stat-box"><div class="label">Score</div><div class="val">' + result.correct + ' / ' + result.total + '</div></div>' +
    '<div class="stat-box"><div class="label">Percent</div><div class="val ' + (result.passed ? 'correct' : 'wrong') + '">' + result.percent + '%</div></div>' +
    '<div class="stat-box"><div class="label">Time used</div><div class="val">' + formatClock(result.timeTakenSec) + '</div></div>' +
    '</div>' +
    '<p class="muted mockexam-result-note">Practice score only — the real exam reports a proprietary scaled score, not raw percent-correct.</p>' +
    // Ask right at the moment of a genuine positive outcome, not on every repeat view of exam
    // history -- only on a fresh pass, not opts.fromHistory.
    (result.passed && !opts.fromHistory
      ? '<p class="muted mockexam-feedback-prompt">Nice work! <a href="#/feedback">Share your experience →</a></p>' : '') +
    ctaHtml +
    '<h3 class="mockexam-review-heading">Review your answers</h3>' +
    '<label class="wrong-only-toggle"><input type="checkbox" data-act="toggle-wrong-only"> Show only questions I got wrong</label>' +
    '<div id="mockexam-review-list">' + reviewHtml + '</div>';
}

// ---- Buy an access code (Stripe, no code needed to get started) -----------
// Card, Apple Pay, and Google Pay all go through one Payment Element -- Stripe decides which
// to actually show based on the buyer's device/browser (see `automatic_payment_methods` on the
// server side), so there's no separate wallet-specific button to wire up here.

// A single shared promise for the SDK script -- if renderBuy() ever fires twice in quick
// succession (e.g. a double navigation event), both calls just attach to the same promise
// instead of racing a polling loop against the script's own onload.
var stripeSdkPromise = null;
function loadStripeSdk(callback) {
  if (window.Stripe) { callback(); return; }
  if (!stripeSdkPromise) {
    stripeSdkPromise = new Promise(function (resolve) {
      var script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.onload = function () { resolve(); };
      document.head.appendChild(script);
    });
  }
  stripeSdkPromise.then(callback);
}

// Turnstile's widget can take a moment to auto-resolve (or need a click) after the buy page
// first renders -- since Stripe needs a real PaymentIntent (and therefore a valid Turnstile
// token) before it can mount the Payment Element, this polls briefly rather than firing the
// create-intent call too early and failing closed. Mirrors renderTurnstileWidget's own retry loop.
function waitForTurnstileToken(callback, attemptsLeft) {
  attemptsLeft = attemptsLeft === undefined ? 50 : attemptsLeft; // ~10s, then give up and let the server reject
  var token = '';
  try { token = (window.turnstileReady && window.turnstile) ? window.turnstile.getResponse() : ''; }
  catch (ignored) { token = ''; }
  if (token || attemptsLeft <= 0) { callback(token); return; }
  setTimeout(function () { waitForTurnstileToken(callback, attemptsLeft - 1); }, 200);
}

var buyPricing = null; // stashed so the points-apply checkbox can recompute the displayed total
var buyPromoCode = null; // the code last confirmed valid by the server (or null)
var buyPromoDiscountCents = 0; // set from the server's response once a code is confirmed valid
var buyPromoVerifySentKey = null; // "<promoId or code>:<email>" a verification link was already sent for, to avoid re-sending on repeat blur

// giftIntent starts the gift checkbox pre-checked -- driven by the hash (#/buy-gift vs #/buy, see
// renderTrackApp) rather than a module var, since the #/gift landing page's track links change the
// URL's PATHNAME too (a real page load, not just a hash change on the same page -- this SPA has no
// pushState-based interception of pathname links), so any in-memory flag would be wiped before
// drawBuyForm ever ran. Reading it fresh off location.hash survives that reload naturally.
function renderBuy(giftIntent) {
  var trackTitle = (trackByExamType(state.examType) || {}).title || 'PassExamHQ';
  appEl.innerHTML = '<h1>Get Instant Access</h1><p class="buy-track-subtitle">' + escapeHtml(trackTitle) + '</p><p class="muted">Loading price…</p>';
  trackEvent('checkout_started', state.examType);
  Promise.all([apiFetch('/pricing?examType=' + encodeURIComponent(state.examType)), loadSiteConfig()]).then(function (results) {
    var p = results[0];
    buyPricing = p;
    drawBuyForm(p, giftIntent);
    // loadSiteConfig() is already resolved by this point -- it's one of the two promises this
    // whole .then() is chained off of (Promise.all above) -- but call it again anyway (cheap,
    // cached singleton) so this stays correct even if the surrounding code is ever reordered.
    Promise.all([apiFetch('/promotions?placement=checkout'), loadSiteConfig()]).then(function (results) {
      var r = results[0];
      var wrap = document.getElementById('checkout-promotions-wrap');
      if (wrap) wrap.innerHTML = promoBannersHtml(r.promotions || [], false);
    }).catch(function () { /* best-effort */ });
  }).catch(function () {
    appEl.innerHTML = '<h1>Get Instant Access</h1><p class="buy-track-subtitle">' + escapeHtml(trackTitle) + '</p><p>Could not load pricing. Try again shortly.</p>';
  });
}

function drawBuyForm(pricing, giftIntent) {
  var priceLabel = '$' + (pricing.priceCents / 100).toFixed(2);
  var track = trackByExamType(state.examType);
  var trackTitle = (track || {}).title || 'PassExamHQ';
  buyPromoCode = null;
  buyPromoDiscountCents = 0;
  var breadcrumbHtml = '<nav class="track-landing-breadcrumb" aria-label="Breadcrumb"><a href="/">Exams</a> / ' +
    (track ? '<a href="/' + kindSlug(track.examKind) + '">' + escapeHtml(track.examKind) + '</a> / ' : '') +
    (track ? '<a href="' + track.route + '">' + escapeHtml(track.stateCode ? (STATE_LABELS[track.stateCode] || track.stateCode) : trackTitle) + '</a> / ' : '') +
    '<span class="breadcrumb-current">Get Instant Access</span></nav>';
  appEl.innerHTML =
    breadcrumbHtml +
    '<h1>Get Instant Access</h1>' +
    '<p class="buy-track-subtitle">' + escapeHtml(trackTitle) + '</p>' +
    '<div class="buy-layout">' +
    '<div class="buy-value-col">' +
    '<div class="card buy-order-summary">' +
    '<div class="buy-order-summary-top"><span>' + escapeHtml(trackTitle) + ' — Full Access</span><span class="buy-order-price">' + priceLabel + '</span></div>' +
    '<p class="buy-promo-note">🔥 Promotional price — increasing soon</p>' +
    '<p class="muted">One-time payment, instant access — no subscription.</p>' +
    '<ul class="buy-feature-list">' +
    '<li>✓ Full practice question bank</li>' +
    '<li>✓ Voice-enabled practice</li>' +
    '<li>✓ Timed mock exam simulation</li>' +
    '<li>✓ Progress tracking</li>' +
    '<li>✓ Study resource library</li>' +
    '<li>✓ Lifetime access</li>' +
    '</ul>' +
    '</div>' +
    // Moved below the track name/price card (was above it, right under the page title) --
    // per-user request, so the discount promos read as "here's how to save on what you just saw
    // the price of" rather than competing with the page title for first attention.
    '<div id="checkout-promotions-wrap" class="promotions-wrap"></div>' +
    '<div class="card buy-guarantee-card">' +
    '<div class="buy-guarantee-item"><strong>🎯 Pass or ' + refundFailurePercent + '% of Your Money Back</strong>' +
    '<p class="muted">Take the real exam and don\'t pass? Get ' + refundFailurePercent + '% of your money back ' +
    '(as long as you maintain a minimum of ' + progressAccuracyPassPct + '% Accuracy and ' + progressCoveragePassPct + '% Coverage).</p></div>' +
    '<p class="muted buy-guarantee-footnote"><a href="#/refund">Refund request →</a></p>' +
    '</div>' +
    '</div>' +
    '<div class="buy-payment-col">' +
    '<div class="card">' +
    '<label class="muted buy-email-label">Your Email Address (to send your instant access receipt & code)</label>' +
    // Email input + gift toggle on one row on anything wider than a phone -- were two stacked
    // full-width rows, but the checkbox is compact and directly related (whose email this
    // purchase's email is), so pairing them saves another row of height (per-user request).
    '<div class="buy-email-gift-row">' +
    '<input type="email" id="buy-email" placeholder="you@example.com">' +
    '<label class="buy-gift-toggle"><input type="checkbox" id="buy-gift-checkbox"' + (giftIntent ? ' checked' : '') + '> 🎁 This is a gift</label>' +
    '</div>' +
    '<div id="buy-gift-fields" class="buy-gift-fields"' + (giftIntent ? '' : ' hidden') + '>' +
    '<label class="muted buy-email-label">Recipient\'s email (optional — we\'ll send them the code)</label>' +
    '<input type="email" id="buy-gift-recipient-email" placeholder="friend@example.com">' +
    '<label class="muted buy-email-label">Gift message (optional)</label>' +
    '<textarea id="buy-gift-message" rows="2" maxlength="500" placeholder="Good luck on your exam!"></textarea>' +
    '<p class="muted buy-gift-hint">Leave the recipient\'s email blank to just get a shareable code on the next screen instead.</p>' +
    '</div>' +
    // CA Driver only -- the real DMV written test's question count/pass line depends on the
    // applicant's age (36Q/83.3% at 18+, 46Q/82.6% under 18 with a permit). Optional: skipping
    // it defaults to the 18+ format. Can also be changed per-sitting on the exam intro page later.
    // Hidden in gift mode -- a gift's code is issued unredeemed (see issueGiftCode), so this
    // choice would never actually reach the eventual redeemer/student; they can set their own
    // format preference later via the exam intro page's picker instead.
    '<div id="buy-age-category-wrap"' + (giftIntent ? ' hidden' : '') + '>' +
    (state.examType === 'ca_driver'
      ? '<label class="muted buy-email-label">Which written test format? (optional)</label>' +
        '<select id="buy-age-category">' +
        '<option value="">Prefer not to say (defaults to 18+ format)</option>' +
        '<option value="18plus">18 or older — 36 questions</option>' +
        '<option value="under18">Under 18 (permit) — 46 questions</option>' +
        '</select>'
      : '') +
    '</div>' +
    // Points-check and promo-code are two independent, unrelated checkout actions that used to
    // stack as their own full-width rows -- side by side on anything wider than a phone instead,
    // to cut the form's vertical height (per-user request).
    '<div class="buy-secondary-actions-row">' +
    '<div class="buy-points-check">' +
    '<label class="muted buy-email-label">Have referral points?</label>' +
    '<button class="btn-secondary btn-sm" type="button" data-act="check-points">Check my points</button>' +
    '<div id="points-result"></div>' +
    '</div>' +
    '<div class="buy-promo-check">' +
    '<label class="muted buy-email-label">Promo code (optional)</label>' +
    '<div class="buy-promo-row">' +
    '<input type="text" id="buy-promo-input" placeholder="e.g. SAVE20">' +
    '<button class="btn-secondary btn-sm" type="button" data-act="apply-promo-code" disabled>Apply</button>' +
    '</div>' +
    '<div id="buy-promo-result"></div>' +
    '</div>' +
    '</div>' +
    '<p class="buy-total-line">Total: <span id="buy-total">' + priceLabel + '</span></p>' +
    '<div id="turnstile-container"></div>' +
    '<p class="muted stripe-card-note">💳 Pay by card, Apple Pay, or Google Pay — whichever your device supports shows up automatically below.</p>' +
    '<form id="stripe-payment-form" data-act="stripe-pay-submit">' +
    '<div id="stripe-payment-element" class="stripe-container"><p class="muted">Loading payment options…</p></div>' +
    '<p class="error-text" id="stripe-pay-error"></p>' +
    '<button class="btn-primary" id="stripe-pay-button" type="submit" disabled>Pay now</button>' +
    '</form>' +
    '<p class="muted buy-security-note">🔒 Secure, encrypted checkout via Stripe</p>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '<p class="redeem-sample-hint buy-redeem-hint">Already have a code? <a href="' + (trackByExamType(state.examType) || {}).route + '">Enter it here</a></p>' +
    '<div id="buy-other-tracks-wrap"></div>';
  renderTurnstileWidget();
  loadOtherTracksPricing();
  // Re-quotes on email blur (not just on Apply/points-toggle) so a codeless, domain-gated promo
  // (e.g. a .edu student discount) gets auto-detected the moment a qualifying email is entered --
  // no code to type or Apply button to click for that case.
  var buyEmailEl = document.getElementById('buy-email');
  if (buyEmailEl) buyEmailEl.addEventListener('blur', function () { mountStripePaymentElement(); });
  var buyPromoInputEl = document.getElementById('buy-promo-input');
  var buyPromoApplyBtn = document.querySelector('[data-act="apply-promo-code"]');
  if (buyPromoInputEl && buyPromoApplyBtn) {
    buyPromoInputEl.addEventListener('input', function () {
      buyPromoApplyBtn.disabled = !buyPromoInputEl.value.trim();
    });
  }
  var giftCheckboxEl = document.getElementById('buy-gift-checkbox');
  if (giftCheckboxEl) giftCheckboxEl.addEventListener('change', function () {
    var fieldsEl = document.getElementById('buy-gift-fields');
    if (fieldsEl) fieldsEl.hidden = !giftCheckboxEl.checked;
    var ageCategoryWrapEl = document.getElementById('buy-age-category-wrap');
    if (ageCategoryWrapEl) ageCategoryWrapEl.hidden = giftCheckboxEl.checked;
  });
  if (STRIPE_PUBLISHABLE_KEY.indexOf('REPLACE') !== -1) {
    var el = document.getElementById('stripe-payment-element');
    if (el) el.innerHTML = '<p class="muted">Payments aren\'t configured yet.</p>';
    return;
  }
  loadStripeSdk(function () { mountStripePaymentElement(); });
}

// Lets someone comparison-shop other active tracks' pricing without leaving the buy flow --
// deliberately just a browse/switch list, not a cart: each account/purchase is still scoped to
// exactly one exam_type (see the users/codes schema), so "adding" a second track here means
// switching to that track's own buy page, not combining a multi-item order.
// Scoped to the current track's own state (same reasoning as the hub's default state view --
// cross-state relevance is ~nil for a licensing-exam product: an Ohio Real Estate buyer caring
// about Wyoming Notary is noise, not a cross-sell). Capped at BUY_OTHER_TRACKS_LIMIT even
// within-state, since a state's own track count is only going to grow.
var BUY_OTHER_TRACKS_LIMIT = 6;
function loadOtherTracksPricing() {
  var wrap = document.getElementById('buy-other-tracks-wrap');
  if (!wrap) return;
  var currentTrack = trackByExamType(state.examType);
  var currentStateCode = currentTrack ? currentTrack.stateCode : null;
  var others = HUB_EXAMS.filter(function (e) {
    return e.active && e.examType !== state.examType && e.stateCode === currentStateCode;
  }).slice(0, BUY_OTHER_TRACKS_LIMIT);
  if (!others.length) return;
  var label = 'Also studying for something else' + (currentStateCode && STATE_LABELS[currentStateCode] ? ' in ' + escapeHtml(STATE_LABELS[currentStateCode]) : '') + '?';
  Promise.all(others.map(function (t) {
    return apiFetch('/pricing?examType=' + encodeURIComponent(t.examType))
      .then(function (p) { return { track: t, priceCents: p.priceCents }; })
      .catch(function () { return null; });
  })).then(function (results) {
    var rows = results.filter(Boolean).map(function (r) {
      return '<a class="buy-other-track-row" href="' + r.track.route + '">' +
        '<span>' + escapeHtml(r.track.shortName || r.track.title) + '</span>' +
        '<span class="buy-other-track-price">$' + (r.priceCents / 100).toFixed(2) + '</span>' +
        '</a>';
    }).join('');
    if (!rows) return;
    wrap.innerHTML = '<div class="card buy-other-tracks-card">' +
      '<div class="buy-other-tracks-label">' + label + '</div>' +
      rows + '</div>';
  }).catch(function () { /* best-effort -- not shown if pricing can't be fetched */ });
}

function updateBuyTotalDisplay() {
  var totalEl = document.getElementById('buy-total');
  if (!totalEl || !buyPricing) return;
  var checkbox = document.getElementById('apply-points-checkbox');
  var applying = !!(checkbox && checkbox.checked);
  var pointsAvailable = checkbox ? Number(checkbox.getAttribute('data-points-available') || 0) : 0;
  // Mirrors quoteCheckout's order: promo discount first, then points on whatever that leaves.
  var afterPromoCents = Math.max(0, buyPricing.priceCents - buyPromoDiscountCents);
  var pointsApplied = pointsAvailable;
  var finalCents = afterPromoCents;
  if (applying) {
    finalCents = Math.max(0, afterPromoCents - pointsAvailable);
    // Mirrors the server's floor (see quoteCheckout) so the preview matches what actually gets
    // charged -- a partial discount can't leave less than this payable through the processor.
    var minCents = buyPricing.minPaypalChargeCents || 0;
    if (finalCents > 0 && finalCents < minCents) {
      pointsApplied = Math.max(0, afterPromoCents - minCents);
      finalCents = afterPromoCents - pointsApplied;
    }
  }
  var noteParts = [];
  if (buyPromoDiscountCents > 0) noteParts.push('promo -$' + (buyPromoDiscountCents / 100).toFixed(2));
  if (applying) noteParts.push(pointsApplied + ' points applied');
  totalEl.textContent = '$' + (finalCents / 100).toFixed(2) + (noteParts.length ? ' (' + noteParts.join(', ') + ')' : '');
}

var stripeObj = null;         // the Stripe(publishableKey) instance, created once and reused
var stripeElementsObj = null; // current Elements group, re-created whenever the quoted amount changes
// Guards against overlapping mountStripePaymentElement() calls stomping each other. On initial
// load there are TWO independent triggers -- loadStripeSdk's own callback, and Turnstile's resolve
// callback (added specifically to retry a mount that gave up before Turnstile finished, see
// renderTurnstileWidget) -- that can both fire close together. Turnstile tokens are single-use
// server-side, but window.turnstile.getResponse() keeps returning the same cached string after
// it's been spent, so a second concurrent call unknowingly resubmits an already-consumed token,
// gets rejected, and its error handler would otherwise overwrite the FIRST call's already-mounted,
// working payment form with the generic "Could not load payment options" message. Only the most
// recently *invoked* call is allowed to touch the DOM/state -- a stale call's result (success or
// failure) is dropped once a newer call has started.
var stripeMountSeq = 0;

// Fetches a fresh PaymentIntent (reflecting the current email/points-checkbox state -- same
// "just-in-time, always current" idea as PayPal's createOrder callback, just triggered by
// mount/re-mount instead of a button click, since Stripe's Payment Element needs a real
// clientSecret up front rather than lazily on click) and mounts the Payment Element into it.
function mountStripePaymentElement() {
  var el = document.getElementById('stripe-payment-element');
  if (!el) return;
  if (STRIPE_PUBLISHABLE_KEY.indexOf('REPLACE') !== -1) {
    el.innerHTML = '<p class="muted">Payments aren\'t configured yet.</p>';
    return;
  }
  var payBtn = document.getElementById('stripe-pay-button');
  if (payBtn) payBtn.disabled = true;
  var mySeq = ++stripeMountSeq;
  waitForTurnstileToken(function (turnstileToken) {
    if (mySeq !== stripeMountSeq) return; // superseded by a newer call while we waited on Turnstile
    var emailEl = document.getElementById('buy-email');
    var email = emailEl && emailEl.value.trim() ? emailEl.value.trim() : undefined;
    var applyCheckbox = document.getElementById('apply-points-checkbox');
    var applyPoints = !!(applyCheckbox && applyCheckbox.checked);
    var promoResultEl = document.getElementById('buy-promo-result');
    apiFetch('/stripe/create-intent', {
      method: 'POST', body: { examType: state.examType, turnstileToken: turnstileToken, email: email, applyPoints: applyPoints, promoCode: buyPromoCode || undefined },
    }).then(function (r) {
      if (mySeq !== stripeMountSeq) return; // a newer call already mounted its own result -- don't clobber it
      buyPromoDiscountCents = r.promoDiscountCents || 0;
      updateBuyTotalDisplay();
      if (promoResultEl && buyPromoDiscountCents > 0) {
        promoResultEl.innerHTML = '<p class="result-correct">"' + escapeHtml(r.promoTitle || buyPromoCode || 'Promo') +
          '" applied: -$' + (buyPromoDiscountCents / 100).toFixed(2) + '</p>';
      }
      stripeObj = stripeObj || Stripe(STRIPE_PUBLISHABLE_KEY);
      var local = loadLocalPrefs();
      var isDark = local.theme === 'dark' || (local.theme === 'system' &&
        window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      stripeElementsObj = stripeObj.elements({
        clientSecret: r.clientSecret,
        appearance: {
          theme: isDark ? 'night' : 'stripe',
          variables: { colorPrimary: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() },
        },
      });
      var paymentElement = stripeElementsObj.create('payment');
      el.innerHTML = '';
      paymentElement.mount('#stripe-payment-element');
      if (payBtn) payBtn.disabled = false;
    }).catch(function (err) {
      if (mySeq !== stripeMountSeq) return; // superseded -- a newer call is handling this, don't show a stale error
      // An invalid/expired code, or one whose email requirement isn't met, shouldn't strand
      // checkout -- clear it and retry at full (or points-discounted) price so the buyer can
      // still complete the purchase. The code stays typed in the input either way, so fixing the
      // email (for the domain-restricted case) and clicking Apply again just works.
      var errCode = err.data && err.data.error;
      if (errCode === 'promo_email_verification_required') {
        // Covers both paths: an explicitly-applied code (buyPromoCode set) and an auto-detected
        // codeless domain-gated promo (server identifies it by promoId since there's no code).
        var codeToVerify = buyPromoCode;
        var promoIdToVerify = err.data.promoId;
        var promoTitle = err.data.promoTitle;
        buyPromoCode = null;
        buyPromoDiscountCents = 0;
        updateBuyTotalDisplay();
        mountStripePaymentElement();
        if (!email) {
          // Only the explicit-code path can reach here with no email (auto-detect never matches
          // without one) -- codeless promos are silent until an email is actually entered.
          if (promoResultEl) promoResultEl.innerHTML = '<p class="error-text">Enter your email above first, then click Apply again.</p>';
          return;
        }
        // Avoid re-sending the same link on every blur if nothing about this attempt changed.
        var verifyKey = (promoIdToVerify || codeToVerify) + ':' + email;
        if (buyPromoVerifySentKey === verifyKey) {
          if (promoResultEl) promoResultEl.innerHTML = '<p class="muted">Check your inbox for the confirmation link we already sent, then click Apply again.</p>';
          return;
        }
        buyPromoVerifySentKey = verifyKey;
        if (promoResultEl) {
          promoResultEl.innerHTML = '<p class="muted">' + (promoTitle ? 'You qualify for "' + escapeHtml(promoTitle) + '" — ' : '') +
            'sending a verification link…</p>';
        }
        waitForTurnstileToken(function (verifyTurnstileToken) {
          apiFetch('/promotions/verify-request', {
            method: 'POST',
            body: { promoCode: codeToVerify || undefined, promoId: promoIdToVerify || undefined, email: email, turnstileToken: verifyTurnstileToken },
          }).then(function (r) {
            if (!promoResultEl) return;
            promoResultEl.innerHTML = r.alreadyVerified
              ? '<p class="muted">That email is already verified — click Apply again.</p>'
              : '<p class="result-correct">We sent a confirmation link to ' + escapeHtml(email) +
                ' — click it, then come back here and click Apply again.</p>';
          }).catch(function (verifyErr) {
            buyPromoVerifySentKey = null; // let a retry go through
            var verifyErrCode = verifyErr.data && verifyErr.data.error;
            if (promoResultEl) {
              promoResultEl.innerHTML = verifyErrCode === 'promo_email_domain_required'
                ? '<p class="error-text">This promo requires an email ending in "' + escapeHtml(verifyErr.data.requiredEmailDomain) + '".</p>'
                : '<p class="error-text">Could not send the verification email. Try again shortly.</p>';
            }
          });
        });
        return;
      }
      if (errCode === 'invalid_promo_code' || errCode === 'promo_email_domain_required' ||
          errCode === 'promo_first_purchase_only_email_required' || errCode === 'promo_not_first_purchase') {
        buyPromoCode = null;
        buyPromoDiscountCents = 0;
        updateBuyTotalDisplay();
        if (promoResultEl) {
          promoResultEl.innerHTML = errCode === 'promo_email_domain_required'
            ? '<p class="error-text">This promo requires an email ending in "' + escapeHtml(err.data.requiredEmailDomain) +
              '" — enter that email above, then click Apply again.</p>'
            : errCode === 'promo_first_purchase_only_email_required'
            ? '<p class="error-text">This promo is for first-time buyers — enter your email above first, then click Apply again.</p>'
            : errCode === 'promo_not_first_purchase'
            ? '<p class="error-text">This promo is for first-time buyers only, and that email already has access.</p>'
            : '<p class="error-text">That promo code isn\'t valid or has expired.</p>';
        }
        mountStripePaymentElement();
        return;
      }
      el.innerHTML = '<p class="error-text">Could not load payment options. Try again shortly.</p>';
    });
  });
}

async function submitStripePayment() {
  var errorEl = document.getElementById('stripe-pay-error');
  var payBtn = document.getElementById('stripe-pay-button');
  if (errorEl) errorEl.textContent = '';
  if (!stripeObj || !stripeElementsObj) return;
  if (payBtn) payBtn.disabled = true;

  var result = await stripeObj.confirmPayment({
    elements: stripeElementsObj,
    redirect: 'if_required', // card/wallet payments confirm in place; only 3rd-party-redirect
                              // methods (not offered here) would ever need the full-page bounce.
  });

  if (result.error) {
    if (errorEl) errorEl.textContent = result.error.message || 'Payment failed. Please try again.';
    if (payBtn) payBtn.disabled = false;
    return;
  }

  var emailEl = document.getElementById('buy-email');
  var email = emailEl && emailEl.value.trim() ? emailEl.value.trim() : undefined;
  var ageCategoryEl = document.getElementById('buy-age-category');
  var ageCategory = ageCategoryEl && ageCategoryEl.value ? ageCategoryEl.value : undefined;
  var giftCheckboxEl = document.getElementById('buy-gift-checkbox');
  var isGift = !!(giftCheckboxEl && giftCheckboxEl.checked);
  var recipientEmailEl = document.getElementById('buy-gift-recipient-email');
  var recipientEmail = isGift && recipientEmailEl && recipientEmailEl.value.trim() ? recipientEmailEl.value.trim() : undefined;
  var giftMessageEl = document.getElementById('buy-gift-message');
  var giftMessage = isGift && giftMessageEl && giftMessageEl.value.trim() ? giftMessageEl.value.trim() : undefined;
  try {
    var res = await apiFetch('/stripe/confirm', {
      method: 'POST', body: {
        paymentIntentId: result.paymentIntent.id, examType: state.examType, email: email, ageCategory: ageCategory,
        isGift: isGift, recipientEmail: recipientEmail, giftMessage: giftMessage, refCode: getStoredRefCode(),
        affCode: getStoredAffCode(), sessionId: getOrCreateSessionId(),
      },
    });
    if (res.isGift) {
      // Deliberately does NOT call setToken/change state.examType/accountExamType or re-render
      // the header/footer -- a gift purchase never logs the buyer in as the student, and if they
      // were already logged into their OWN account, setToken(null) would corrupt that session
      // (localStorage stringifies null to the literal text "null").
      renderGiftPurchaseSuccess(res.code, recipientEmail);
      return;
    }
    setToken(res.token);
    // Set BEFORE re-rendering chrome -- currentTrackOrNull() reads accountExamType, so the header/
    // footer's Refer/sample links would still reflect the pre-purchase state for one render if this
    // ran after.
    state.examType = res.examType;
    accountExamType = res.examType;
    renderSiteHeader();
    renderSiteFooter();
    var local = loadLocalPrefs();
    applyTheme(local.theme, local.fontScale);
    renderPurchaseSuccess(res.code, res.pointsApplied);
  } catch (err) {
    appEl.innerHTML = '<h1>Something went wrong</h1>' +
      '<p class="muted">Your payment may have gone through — contact whoever runs this site before trying ' +
      'again, so you don\'t get charged twice.</p>';
  }
}

function renderPurchaseSuccess(code, pointsApplied) {
  appEl.innerHTML =
    '<h1>You\'re in! 🎉</h1>' +
    (pointsApplied ? '<p class="muted">' + pointsApplied + ' points applied to this purchase.</p>' : '') +
    '<div class="card purchase-success-card">' +
    '<p class="muted">Your access code (keep it as a backup):</p>' +
    '<div class="purchase-code">' + code + '</div>' +
    '<button class="btn-secondary btn-sm" data-act="copy-code" data-code="' + code + '">Copy code</button>' +
    '</div>' +
    '<a class="btn-primary hub-cta" href="#/quiz">Start studying →</a>' +
    '<p class="muted redeem-sample-hint">Covered by our 7-day refund and pass-or-' + refundFailurePercent + '%-back guarantees — ' +
    '<a href="#/refund">request one anytime →</a></p>';
}

function renderGiftPurchaseSuccess(code, recipientEmail) {
  appEl.innerHTML =
    '<h1>Gift purchased! 🎁</h1>' +
    '<div class="card purchase-success-card">' +
    '<p class="muted">' + (recipientEmail
      ? 'We\'ve emailed this code to <strong>' + escapeHtml(recipientEmail) + '</strong> — here\'s a copy for your records:'
      : 'Share this code with whoever you\'re gifting it to:') + '</p>' +
    '<div class="purchase-code">' + code + '</div>' +
    '<button class="btn-secondary btn-sm" data-act="copy-code" data-code="' + code + '">Copy code</button>' +
    '</div>' +
    '<p class="muted redeem-sample-hint">They\'ll enter it on the <a href="#/redeem">Redeem page</a> to create their own account — ' +
    'covered by our 7-day refund and pass-or-' + refundFailurePercent + '%-back guarantees.</p>' +
    '<a class="btn-primary hub-cta" href="#/gift">Buy another gift →</a>';
}

// Global, track-agnostic entry point (same reasoning as #/redeem, #/refund) -- picking a track
// here just deep-links into that track's own buy page in gift mode (#/buy-gift), reusing the
// normal checkout flow wholesale rather than duplicating it. Category+state picker (see
// giftPickerHtml/giftResultHtml above) shows nothing until both are chosen, rather than a
// browsable grid of all active tracks -- a deliberate 2026-08-25 redesign, see that comment block
// for why.
function renderGift() {
  giftPickedKind = '';
  giftPickedState = '';
  appEl.innerHTML =
    '<section class="refer-hero">' +
    '<span class="badge refer-hero-badge">Gift a Track</span>' +
    '<h1>Give the Gift of Passing 🎁</h1>' +
    '<p>Buy full access to any track for someone else. They get their own code by email (or you get a ' +
    'shareable one) — no account needed from you, and they redeem it whenever they\'re ready.</p>' +
    '</section>' +
    trustStripHtml() +
    '<div id="gift-picker-wrap">' + giftPickerHtml() + '</div>' +
    '<div id="gift-result-wrap">' + giftResultHtml() + '</div>' +
    // Reassurance content this page didn't have before -- previously the guarantee only appeared
    // post-purchase (renderGiftPurchaseSuccess) or in the buy-gift checkout itself, i.e. after the
    // decision to spend money was already made, not before it.
    guaranteeCtaBandHtml();
}

// ---- Refund requests (7-day unconditional + pass-or-N%-back) --------------

function renderRefundRequest() {
  appEl.innerHTML =
    '<div class="narrow-page">' +
    '<h1>Request a Refund</h1>' +
    '<p class="muted">Covers real-money purchases only — free courses redeemed with points aren\'t eligible, ' +
    'since no cash was paid.</p>' +
    '<form data-act="refund-claim-submit" class="card">' +
    '<label class="muted buy-email-label">Your access code</label>' +
    '<input type="text" name="code" class="redeem-code-input" placeholder="XXXXX-XXXXX" autocapitalize="characters" required>' +
    '<label class="muted buy-email-label refund-field-spacing">Your email</label>' +
    '<input type="email" name="email" placeholder="you@example.com" required>' +
    '<label class="muted buy-email-label refund-field-spacing">Which guarantee?</label>' +
    '<div class="refund-claim-type-options">' +
    '<label class="refund-claim-type-option"><input type="radio" name="claimType" value="unconditional_7day" checked> ' +
    '<span><strong>7-Day, No Questions Asked</strong><br><span class="muted">Full refund — must be within 7 days of purchase.</span></span></label>' +
    '<label class="refund-claim-type-option"><input type="radio" name="claimType" value="exam_failure_50pct"> ' +
    '<span><strong>Pass or ' + refundFailurePercent + '% of Your Money Back</strong><br><span class="muted">' + refundFailurePercent + '% refund if you took and failed the real exam.</span></span></label>' +
    '</div>' +
    '<div id="refund-failure-fields" class="refund-failure-fields">' +
    '<label class="muted buy-email-label">Exam date</label>' +
    '<input type="date" name="examDate">' +
    '<label class="muted buy-email-label refund-field-spacing">Confirmation/candidate ID (optional)</label>' +
    '<input type="text" name="confirmationNote" placeholder="e.g. your exam confirmation number">' +
    '</div>' +
    '<label class="muted buy-email-label refund-field-spacing">Notes (optional)</label>' +
    '<input type="text" name="notes" placeholder="Anything else we should know">' +
    '<div id="turnstile-container"></div>' +
    '<button class="btn-primary" type="submit">Submit Request</button>' +
    '</form>' +
    '</div>';
  renderTurnstileWidget();
}

// ---- Refer a friend, earn points ------------------------------------------

function loadReferrerInfo() {
  return {
    name: localStorage.getItem('examprep_referrer_name') || '',
    email: localStorage.getItem('examprep_referrer_email') || '',
  };
}
function saveReferrerInfo(name, email) {
  localStorage.setItem('examprep_referrer_name', name || '');
  localStorage.setItem('examprep_referrer_email', email || '');
}

var referFriendRowCount = 0;
var referPromoVerifySentKey = null; // "<promoId>:<email>" a verification link was already sent for, to avoid re-sending on repeat clicks

// Redeems a points-multiplier promo (e.g. "retired professionals get 2x referral points") --
// a different effect from the checkout discount flow, but the same code/verification machinery,
// so this mirrors mountStripePaymentElement's promo_email_verification_required handling closely.
async function applyPointsPromoCode() {
  var codeInput = document.getElementById('refer-promo-input');
  var code = codeInput ? codeInput.value.trim() : '';
  var resultEl = document.getElementById('refer-promo-result');
  var emailEl = document.querySelector('[name="referrerEmail"]');
  var email = emailEl ? emailEl.value.trim() : '';
  if (!code) return;
  if (!email) {
    if (resultEl) resultEl.innerHTML = '<p class="error-text">Enter your email above first, then click Apply again.</p>';
    return;
  }
  if (resultEl) resultEl.innerHTML = '<p class="muted">Checking…</p>';
  waitForTurnstileToken(function (turnstileToken) {
    apiFetch('/promotions/redeem-points-multiplier', {
      method: 'POST', body: { promoCode: code, email: email, turnstileToken: turnstileToken },
    }).then(function (r) {
      if (!resultEl) return;
      var expiresLabel = new Date(r.expiresAt * 1000).toLocaleDateString();
      resultEl.innerHTML = '<p class="result-correct">' + r.multiplier + '× points active on your account through ' + expiresLabel + '!</p>';
    }).catch(function (err) {
      var errCode = err.data && err.data.error;
      if (errCode === 'promo_email_verification_required') {
        var promoId = err.data.promoId;
        var promoTitle = err.data.promoTitle;
        var verifyKey = promoId + ':' + email;
        if (referPromoVerifySentKey === verifyKey) {
          if (resultEl) resultEl.innerHTML = '<p class="muted">Check your inbox for the confirmation link we already sent, then click Apply again.</p>';
          return;
        }
        referPromoVerifySentKey = verifyKey;
        if (resultEl) {
          resultEl.innerHTML = '<p class="muted">' + (promoTitle ? 'You qualify for "' + escapeHtml(promoTitle) + '" — ' : '') + 'sending a verification link…</p>';
        }
        waitForTurnstileToken(function (verifyTurnstileToken) {
          apiFetch('/promotions/verify-request', {
            method: 'POST', body: { promoId: promoId, email: email, turnstileToken: verifyTurnstileToken },
          }).then(function (vr) {
            if (!resultEl) return;
            resultEl.innerHTML = vr.alreadyVerified
              ? '<p class="muted">That email is already verified — click Apply again.</p>'
              : '<p class="result-correct">We sent a confirmation link to ' + escapeHtml(email) + ' — click it, then come back and click Apply again.</p>';
          }).catch(function () {
            referPromoVerifySentKey = null;
            if (resultEl) resultEl.innerHTML = '<p class="error-text">Could not send the verification email. Try again shortly.</p>';
          });
        });
        return;
      }
      if (resultEl) {
        resultEl.innerHTML = errCode === 'invalid_promo_code'
          ? '<p class="error-text">That promo code isn\'t valid or has expired.</p>'
          : '<p class="error-text">Could not apply that code. Try again shortly.</p>';
      }
    });
  });
}

function renderReferFriendRow(idx) {
  return '<div class="referred-friend-row" data-row-index="' + idx + '">' +
    '<input type="text" class="referred-friend-name" placeholder="Friend\'s name">' +
    '<input type="email" class="referred-friend-email" placeholder="friend@example.com" required>' +
    (idx > 0
      ? '<button type="button" class="btn-secondary btn-sm" data-act="remove-referred-friend" data-row-index="' + idx + '">✕</button>'
      : '') +
    '</div>';
}

// Adapted from v0's refer/page.tsx "How it works" -- v0's own version describes a share-your-own-
// link model (copy a URL, friends click through anonymously), which isn't how this site's
// referral system actually works (see renderReferForm below: the referrer submits friends' name/
// email directly, and we send the invite). Ported the section/structure, rewrote the 3 steps to
// describe the real mechanic with real point values (rules), not v0's fixed "$5 off"/"500 points".
function referHowItWorksHtml(rules) {
  var steps = [
    ['📧', 'Add your friend', 'Enter their name and email in the form above — no link to copy or share.'],
    ['✉️', 'They get invited', 'We send them a one-time email introducing PassExamHQ on your behalf.'],
    ['🎁', 'You earn points', rules.referralVerifiedPoints + ' points when they confirm, plus ' + rules.referralConvertedPoints +
      ' more if they buy a course — redeemable on your next track.'],
  ];
  return '<section class="refer-how-it-works">' +
    '<h2 class="comparison-heading">How it works</h2>' +
    '<div class="how-it-works-grid refer-how-it-works-grid">' +
    steps.map(function (s) {
      return '<div class="how-it-works-card">' +
        '<div class="how-it-works-icon">' + s[0] + '</div>' +
        '<h3>' + s[1] + '</h3>' +
        '<p class="muted">' + s[2] + '</p>' +
        '</div>';
    }).join('') +
    '</div>' +
    '</section>';
}

async function renderReferForm() {
  referFriendRowCount = 1;
  var referrerInfo = loadReferrerInfo();
  appEl.innerHTML = '<h1>Refer friends, earn free access</h1><p class="muted">Loading…</p>';

  // 'refer' is dispatched before renderTrackApp()'s isLoggedInForCurrentTrack() guard, so a
  // logged-in visitor who somehow lands on a DIFFERENT track's #/refer path (stale bookmark,
  // browser history, a link from before this fix) must still see their own account's track here,
  // not whichever track's path they happened to land on -- same accountExamType-first rule as
  // currentTrackOrNull(), which is what the links leading here now use going forward.
  var referExamType = (getToken() && accountExamType) ? accountExamType : state.examType;

  // Live values from the admin's actual point-rule/price settings, so this copy never drifts
  // out of sync -- falls back to sane defaults if the fetch fails, rather than blocking the page.
  var rules = { referralVerifiedPoints: 25, referralConvertedPoints: 100 };
  var pricing = { priceCents: 499 };
  try {
    var results = await Promise.all([apiFetch('/points/rules'), apiFetch('/pricing?examType=' + encodeURIComponent(referExamType))]);
    rules = results[0];
    pricing = results[1];
  } catch (e) { /* use the fallback defaults above */ }
  var required = pricing.priceCents;

  appEl.innerHTML =
    '<section class="refer-hero">' +
    '<span class="badge refer-hero-badge">Refer &amp; Earn</span>' +
    '<h1>Help a friend pass. Earn real points doing it.</h1>' +
    '<p>Add a friend below — they get a personal invite, and you earn ' + rules.referralVerifiedPoints +
    ' points once they confirm, plus ' + rules.referralConvertedPoints + ' more if they go on to buy a course.</p>' +
    '<button class="btn-secondary btn-sm" type="button" data-act="share-refer-link" ' +
    'data-share-url="' + escapeHtml(location.origin + ((trackByExamType(referExamType) || {}).route || '')) + '" ' +
    'data-share-title="' + escapeHtml((trackByExamType(referExamType) || {}).title || 'PassExamHQ') + '">Share with a friend</button>' +
    '</section>' +
    trustStripHtml() +
    '<div class="narrow-page">' +
    // Leftover duplicate <h1> removed here -- this was the loading-state placeholder's own
    // heading (still used verbatim at this function's initial appEl.innerHTML above), never
    // demoted once the .refer-hero section (with its own <h1>) was added above it.
    '<div id="refer-promotions-wrap" class="promotions-wrap"></div>' +
    '<p class="muted page-intro-text">Earn <strong>' + rules.referralVerifiedPoints + ' points</strong> when a friend confirms their email, ' +
    'plus <strong>' + rules.referralConvertedPoints + ' more</strong> if they go on to buy a course. Reach ' +
    '<strong>' + required + ' points</strong> to unlock the ' + escapeHtml((trackByExamType(referExamType) || {}).title || 'course') + ' completely free.</p>' +
    '<div class="refer-progress">' +
    '<div class="refer-progress-bar"><div class="refer-progress-fill"></div></div>' +
    '<div class="refer-progress-label muted">0 / ' + required + ' points — <a href="#/buy">check your real balance →</a></div>' +
    '</div>' +
    '<form data-act="refer-submit" class="card">' +
    '<div class="refer-name-email-grid">' +
    '<div><label class="muted buy-email-label">Your name</label>' +
    '<input type="text" name="referrerName" placeholder="Your name" value="' + escapeHtml(referrerInfo.name) + '"></div>' +
    '<div><label class="muted buy-email-label">Your email</label>' +
    '<input type="email" name="referrerEmail" placeholder="you@example.com" value="' + escapeHtml(referrerInfo.email) + '" required></div>' +
    '</div>' +
    '<label class="muted buy-email-label buy-promo-label">Have a points-boost promo code? (optional)</label>' +
    '<div class="buy-promo-row">' +
    '<input type="text" id="refer-promo-input" placeholder="e.g. RETIRED2X">' +
    '<button class="btn-secondary btn-sm" type="button" data-act="apply-points-promo-code">Apply</button>' +
    '</div>' +
    '<div id="refer-promo-result"></div>' +
    '<label class="muted buy-email-label">Friends to refer</label>' +
    '<div id="referred-friends-list">' + renderReferFriendRow(0) + '</div>' +
    '<button class="btn-secondary btn-sm" type="button" data-act="add-referred-friend">+ Add another friend</button>' +
    '<div id="turnstile-container"></div>' +
    '<button class="btn-primary" type="submit">Send referrals</button>' +
    '</form>' +
    '</div>' +
    referHowItWorksHtml(rules) +
    '<div id="refer-testimonials-wrap"></div>' +
    // Reassurance content this page didn't have before -- a referrer is vouching for the product
    // to a friend, so the same guarantee band shown on category/track pages belongs here too.
    guaranteeCtaBandHtml();
  renderTurnstileWidget();
  Promise.all([apiFetch('/promotions?placement=refer'), loadSiteConfig()]).then(function (results) {
    var r = results[0];
    var wrap = document.getElementById('refer-promotions-wrap');
    if (wrap) wrap.innerHTML = promoBannersHtml(r.promotions || [], true);
  }).catch(function () { /* best-effort */ });
  // Same testimonials the referred track's own category page shows (category_content is keyed by
  // category slug, not per-track) -- real social proof for what the referrer is vouching for.
  var referTrack = trackByExamType(referExamType);
  if (referTrack) {
    apiFetch('/category-content?slug=' + encodeURIComponent(kindSlug(referTrack.examKind))).then(function (res) {
      var content = (res.categories || [])[0] || null;
      var wrap = document.getElementById('refer-testimonials-wrap');
      if (wrap) wrap.innerHTML = categoryTestimonialsHtml(content && content.testimonials);
    }).catch(function () { /* best-effort -- section just stays empty */ });
  }
}

function renderReferVerify(token) {
  appEl.innerHTML = '<div class="narrow-page"><h1>Confirming…</h1><p class="muted">One moment.</p></div>';
  apiFetch('/referrals/verify?token=' + encodeURIComponent(token)).then(function (res) {
    var msg = res.alreadyVerified
      ? 'This referral was already confirmed — thanks!'
      : 'Thanks for confirming — your friend just earned points because of you.';
    appEl.innerHTML =
      '<div class="narrow-page"><div class="card refer-confirmed-card">' +
      '<div class="refer-confirmed-emoji">🎉</div>' +
      '<h1>You\'re confirmed!</h1>' +
      '<p class="muted">' + msg + '</p>' +
      '<div class="sample-done-cta">' +
      '<a class="btn-primary hub-cta" href="#/sample">Try 10 free sample questions →</a>' +
      '<a class="btn-secondary hub-cta" href="#/refer">Refer your own friends & earn free access →</a>' +
      '</div></div></div>';
  }).catch(function () {
    appEl.innerHTML = '<div class="narrow-page"><h1>Something went wrong</h1><p class="muted">This link may be invalid or expired.</p></div>';
  });
}

function renderPointsRedeemVerify(token) {
  appEl.innerHTML = '<div class="narrow-page"><h1>Confirming…</h1><p class="muted">One moment.</p></div>';
  apiFetch('/points/redeem-verify?token=' + encodeURIComponent(token)).then(function (res) {
    setToken(res.token);
    state.examType = res.examType;
    accountExamType = res.examType;
    renderSiteHeader();
    renderSiteFooter();
    var local = loadLocalPrefs();
    applyTheme(local.theme, local.fontScale);
    renderPurchaseSuccess(res.code);
  }).catch(function (err) {
    var code = err.data && err.data.error;
    var msg = code === 'insufficient_points'
      ? 'Your points balance changed before this was confirmed, so it could no longer be redeemed.'
      : 'This link may be invalid, already used, or expired (links are only good for 30 minutes).';
    appEl.innerHTML = '<div class="narrow-page"><h1>Could not redeem</h1><p class="muted">' + msg + '</p>' +
      '<a class="btn-secondary hub-cta" href="#/buy">Back to purchase page</a></div>';
  });
}

// Doesn't complete a purchase (unlike renderPointsRedeemVerify) -- just marks this email verified
// for the promo, then sends the buyer back to checkout to actually apply the discount and pay.
// Shared by both promo flows -- a checkout discount (see mountStripePaymentElement) and a
// points-multiplier redeemed on the Refer page (see applyPointsPromoCode) -- so this can't assume
// which one the buyer came from, hence the generic "wherever you were applying it" wording and
// both destination links.
function renderPromoVerify(token) {
  appEl.innerHTML = '<div class="narrow-page"><h1>Confirming…</h1><p class="muted">One moment.</p></div>';
  apiFetch('/promotions/verify-email?token=' + encodeURIComponent(token)).then(function (res) {
    appEl.innerHTML = '<div class="narrow-page"><h1>Email confirmed ✅</h1>' +
      '<p class="muted">' + (res.promoTitle ? 'You\'re all set for "' + escapeHtml(res.promoTitle) + '." ' : '') +
      'Go back to wherever you were applying your promo code and click Apply again — it\'ll go through now.</p>' +
      '<div class="buy-cta-group">' +
      '<a class="btn-primary hub-cta" href="#/buy">Back to checkout →</a>' +
      '<a class="btn-secondary hub-cta" href="#/refer">Back to Refer-a-Friend →</a>' +
      '</div></div>';
  }).catch(function () {
    appEl.innerHTML = '<div class="narrow-page"><h1>Could not confirm</h1>' +
      '<p class="muted">This link may be invalid or expired (links are good for 7 days). Go back to wherever ' +
      'you applied the code and click Apply again to get a new one.</p>' +
      '<div class="buy-cta-group">' +
      '<a class="btn-secondary hub-cta" href="#/buy">Back to checkout</a>' +
      '<a class="btn-secondary hub-cta" href="#/refer">Back to Refer-a-Friend</a>' +
      '</div></div>';
  });
}

// ---- Free sample (no access code needed) -----------------------------------

async function renderSample() {
  // currentTrackOrNull() (not a bare state.examType read) so this never silently claims a track
  // when reached from a context that never actually picked one -- if there's genuinely no track
  // in play (empty state.examType, logged out), send the visitor to
  // pick one instead of quietly showing California's sample questions under a generic title.
  var track = currentTrackOrNull();
  if (!track) { location.hash = ''; location.href = tracksHomeHref(); return; }
  appEl.innerHTML = '<h1>Try a Free Sample: ' + escapeHtml(track.shortName || track.title) + '</h1>' +
    '<p class="muted">10 questions, no access code needed.</p><p class="muted">Loading…</p>';
  if (!sampleState.questions || sampleState.examType !== track.examType) {
    try {
      var res = await apiFetch('/sample?examType=' + encodeURIComponent(track.examType));
      sampleState.questions = res.questions;
      sampleState.examType = track.examType;
      sampleState.index = 0;
      sampleState.selected = null;
      sampleState.answered = null;
    } catch (e) {
      appEl.innerHTML = '<p>Could not load the sample. Try again shortly.</p>';
      return;
    }
  }
  drawSampleQuestion();
  injectJsonLd('sample-quiz-jsonld', quizJsonLd(track.shortName || track.title, sampleState.questions));
}

function drawSampleQuestion() {
  var track = trackByExamType(sampleState.examType) || {};
  if (sampleState.index >= sampleState.questions.length) {
    appEl.innerHTML =
      '<h1>That Was the Sample: ' + escapeHtml(track.shortName || track.title || '') + '</h1>' +
      '<p class="muted">Enter an access code to unlock the full question bank and track your progress.</p>' +
      '<div class="sample-done-cta">' +
      '<a class="btn-primary hub-cta" href="' + (track.route || tracksHomeHref()) + '">Enter access code →</a>' +
      '<a class="btn-secondary hub-cta" href="#/resources">See free study resources →</a>' +
      '</div>';
    return;
  }
  var q = sampleState.questions[sampleState.index];
  var prefixes = ['A', 'B', 'C', 'D'];
  var choiceHtml = prefixes.map(function (k) {
    var cls = 'option-btn';
    if (sampleState.answered) {
      if (k === q.correctChoice) cls += ' correct';
      else if (k === sampleState.answered) cls += ' wrong';
    } else if (k === sampleState.selected) {
      cls += ' selected';
    }
    return optionButtonHtml(k, q.choices[k], cls,
      'data-act="sample-answer" data-choice="' + k + '"' + (sampleState.answered ? ' disabled' : ''));
  }).join('');

  // Clicking a choice only selects it (highlights, doesn't grade) -- a first-time, anonymous
  // visitor's very first interaction with the site has no prior exposure to the practice quiz's
  // own instant-reveal-on-click convention, so a visible submit step here avoids the "did that
  // just submit?" confusion an immediate reveal could cause right at the front door. The main
  // practice quiz (post-purchase, already-familiar users) deliberately keeps instant reveal --
  // this is scoped to the free sample only. The button itself is always visible once a question's
  // up (disabled until a choice is selected) rather than only appearing after selecting -- a
  // button that doesn't exist yet gives no signal there's a submit step at all.
  var submitControl = !sampleState.answered
    ? '<div class="nav-controls"><button class="btn-primary" type="button" data-act="sample-submit"' + (sampleState.selected ? '' : ' disabled') + '>Submit Answer</button></div>'
    : '';

  var explanation = sampleState.answered
    ? '<div class="explanation-box">' +
      '<strong class="' + (sampleState.answered === q.correctChoice ? 'result-correct' : 'result-incorrect') + '">' +
      (sampleState.answered === q.correctChoice ? 'Correct.' : 'Incorrect.') + '</strong> ' + q.explanation + '</div>' +
      '<div class="nav-controls"><button class="btn-primary" data-act="sample-next">' +
      (sampleState.index + 1 < sampleState.questions.length ? 'Next question →' : 'See results →') + '</button></div>'
    : '';

  appEl.innerHTML =
    '<h1>Try a Free Sample: ' + escapeHtml(track.shortName || track.title || '') + '</h1>' +
    '<p class="muted">Free sample — question ' + (sampleState.index + 1) + ' of ' + sampleState.questions.length + '</p>' +
    '<div class="card">' +
    '<div class="question-topic">' + q.topic + '</div>' +
    '<div class="question-text">' + q.question + '</div>' +
    '<div class="audio-actions"><button class="btn-secondary btn-sm" type="button" data-act="sample-listen">🔊 Read aloud</button></div>' +
    '</div>' +
    '<div class="options-grid">' + choiceHtml + '</div>' +
    submitControl + explanation;
}

// ---- Speech recognition (voice answer picker) ------------------------------

function setupMic() {
  var micBtn = document.querySelector('[data-act="mic-toggle"]');
  if (!micBtn) return;
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micBtn.disabled = true;
    micBtn.textContent = 'Voice input not supported in this browser';
    return;
  }
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.lang = 'en-US';
  recognition.onresult = function (event) {
    var transcript = event.results[0][0].transcript.toLowerCase();
    var box = document.getElementById('mic-transcript');
    if (box) box.textContent = 'You said: "' + transcript + '"';
    var map = { a: 'A', 'option a': 'A', first: 'A', b: 'B', 'option b': 'B', second: 'B', c: 'C', 'option c': 'C', third: 'C', d: 'D', 'option d': 'D', fourth: 'D' };
    var picked = null;
    Object.keys(map).forEach(function (phrase) {
      if (transcript.indexOf(phrase) !== -1) picked = map[phrase];
    });
    if (picked) submitAnswer(picked);
  };
  recognition.onend = function () {
    isRecording = false;
    if (micBtn) { micBtn.textContent = '🎙️ Voice Answer'; micBtn.classList.remove('listening'); }
  };
}

// ---- Routing --------------------------------------------------------------

async function renderTrackApp() {
  var view = (location.hash || '#/quiz').replace('#/', '');
  if (view === 'sample') { await renderSample(); return; }
  if (view === 'buy') { renderBuy(false); return; }
  if (view === 'buy-gift') { renderBuy(true); return; }
  if (view === 'refer') { renderReferForm(); return; }
  // redeem/refund are now global routes (see route()) -- reachable regardless of pathname, so
  // they're handled there before this function is even called, not here.
  if (view.indexOf('refer-verify/') === 0) { renderReferVerify(view.slice('refer-verify/'.length)); return; }
  if (view.indexOf('points-redeem-verify/') === 0) { renderPointsRedeemVerify(view.slice('points-redeem-verify/'.length)); return; }
  if (view.indexOf('promo-verify/') === 0) { renderPromoVerify(view.slice('promo-verify/'.length)); return; }
  if (view === 'resources') { await renderResources(); return; } // partially public — see renderResources()
  if (view === 'info') { renderAdditionalInfo(); return; } // fully public
  // Any of quiz/exam/toughest45/progress (plus their history/detail sub-views) while logged out
  // (or logged in for a different track) all land on the same consolidated sales page now --
  // see renderTrackLanding().
  if (!isLoggedInForCurrentTrack()) { renderTrackLanding(); return; }
  if (view === 'quiz') await renderQuiz();
  else if (view === 'exam') await renderExam('standard');
  else if (view === 'exam-history') await renderExamHistory('standard');
  else if (view.indexOf('exam-history/') === 0) await renderExamAttemptDetailView(view.slice('exam-history/'.length), 'standard');
  else if (view === 'toughest45') await renderExam('toughest45');
  else if (view === 'toughest45-history') await renderExamHistory('toughest45');
  else if (view.indexOf('toughest45-history/') === 0) await renderExamAttemptDetailView(view.slice('toughest45-history/'.length), 'toughest45');
  else if (view === 'progress') await renderProgress();
  else await renderQuiz();
}

// ---- Site visit tracking (first-party analytics beacon) -------------------
// Fires on every route() call (initial load + hash/pathname nav) plus once more on tab-hide via
// sendBeacon (more reliable than a fetch when a tab is closing). session_id (sessionStorage) is
// this browser tab's session, one row server-side (see examprep-api's /track/visit); visitor_id
// (localStorage) persists across sessions so the admin's Visitors tab can spot repeat visits by
// the same browser. IP/geo/user-agent are always read server-side from the request itself --
// nothing sent from here is trusted as identity, this only ever describes what a visitor did.
function uuidV4() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
function getOrCreateVisitorId() {
  var id = localStorage.getItem('pxq_visitor_id');
  if (!id) { id = uuidV4(); localStorage.setItem('pxq_visitor_id', id); }
  return id;
}
function getOrCreateSessionId() {
  var id = sessionStorage.getItem('pxq_session_id');
  if (!id) { id = uuidV4(); sessionStorage.setItem('pxq_session_id', id); }
  return id;
}
function getSessionPages() {
  try { return JSON.parse(sessionStorage.getItem('pxq_session_pages') || '[]'); } catch (e) { return []; }
}
function getFirstTouchUtm() {
  try { return JSON.parse(sessionStorage.getItem('pxq_first_touch') || 'null'); } catch (e) { return null; }
}
// Self-service opt-out (e.g. for the site owner's own browsing) -- visiting
// "?pxq_exclude=1" once permanently stops this browser from sending any tracking beacons,
// regardless of IP (survives switching wifi/mobile/VPN, unlike the admin's IP exclusion list in
// Settings). "?pxq_exclude=0" re-enables it. The flag itself never leaves the browser -- this is
// enforced entirely client-side by just never sending the beacon, not a server-side filter.
function isTrackingExcluded() { return localStorage.getItem('pxq_tracking_excluded') === '1'; }
var optOutLinkChecked = false;
function checkTrackingOptOutLink() {
  var params = new URLSearchParams(location.search);
  if (!params.has('pxq_exclude')) return;
  var val = params.get('pxq_exclude');
  if (val === '0') localStorage.removeItem('pxq_tracking_excluded');
  else localStorage.setItem('pxq_tracking_excluded', '1');
  params.delete('pxq_exclude');
  var newSearch = params.toString();
  history.replaceState(null, '', location.pathname + (newSearch ? '?' + newSearch : '') + location.hash);
  setTimeout(function () {
    alert(val === '0'
      ? 'Visit tracking re-enabled for this browser.'
      : 'Visit tracking disabled for this browser — your visits will no longer be recorded.');
  }, 0);
}
var visitBeaconTimer = null;
function trackPageview() {
  if (!optOutLinkChecked) { optOutLinkChecked = true; checkTrackingOptOutLink(); }
  if (isTrackingExcluded()) return;
  var path = location.pathname + (location.hash || '');
  var pages = getSessionPages();
  if (pages[pages.length - 1] !== path) {
    pages.push(path);
    if (pages.length > 200) pages = pages.slice(-200);
    sessionStorage.setItem('pxq_session_pages', JSON.stringify(pages));
  }
  var firstTouch = getFirstTouchUtm();
  if (!firstTouch) {
    var params = new URLSearchParams(location.search);
    firstTouch = {
      referrer: document.referrer || '',
      utmSource: params.get('utm_source') || '',
      utmMedium: params.get('utm_medium') || '',
      utmCampaign: params.get('utm_campaign') || '',
    };
    sessionStorage.setItem('pxq_first_touch', JSON.stringify(firstTouch));
  }
  // Debounced -- a burst of route() calls (e.g. programmatic redirects chaining through several
  // hash changes on load) shouldn't fire a beacon per intermediate hop, just the settled view.
  clearTimeout(visitBeaconTimer);
  visitBeaconTimer = setTimeout(function () { sendVisitBeacon(pages, firstTouch, false); }, 400);
}
function sendVisitBeacon(pages, firstTouch, isFinal) {
  var payload = {
    sessionId: getOrCreateSessionId(),
    visitorId: getOrCreateVisitorId(),
    pages: pages,
    referrer: firstTouch.referrer,
    utmSource: firstTouch.utmSource,
    utmMedium: firstTouch.utmMedium,
    utmCampaign: firstTouch.utmCampaign,
  };
  if (isFinal && navigator.sendBeacon) {
    navigator.sendBeacon(API_BASE + '/track/visit', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    return;
  }
  apiFetch('/track/visit', { method: 'POST', body: payload }).catch(function () { /* best-effort */ });
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden' && !isTrackingExcluded()) {
    sendVisitBeacon(getSessionPages(), getFirstTouchUtm() || { referrer: '', utmSource: '', utmMedium: '', utmCampaign: '' }, true);
  }
});

// Funnel/conversion event beacon -- same opt-out (isTrackingExcluded) as pageview tracking.
// eventName must be one of the API's FUNNEL_EVENT_NAMES allowlist (quiz_completed,
// checkout_started as of this writing) -- purchase_completed is recorded server-side directly,
// not through this.
function trackEvent(eventName, examType) {
  if (isTrackingExcluded()) return;
  apiFetch('/track/event', {
    method: 'POST',
    body: { sessionId: getOrCreateSessionId(), visitorId: getOrCreateVisitorId(), eventName: eventName, examType: examType || null },
  }).catch(function () { /* best-effort */ });
}

function route() {
  closeHeaderMenuIfOpen(); // runs on every hash/pathname change -- the drawer isn't re-rendered
                            // by a route change (renderSiteHeader() only runs a handful of times
                            // per session), so it needs to close itself independently.
  trackPageview();

  // Category-first: there's no more bare /{state} route to derive hubScopedState from (old
  // bookmarks/links to one are 301'd server-side, see _worker.js) -- it's only ever set by
  // landing directly on a track page (below), as "which state does the track I'm currently
  // viewing belong to." "/" is the one pathname that explicitly resets it to unscoped, resolved
  // up front (before the hash-route early-returns) so a hash-only page reached from "/" (e.g.
  // "#/gift") doesn't see a stale hubScopedState from whatever was viewed earlier this session.
  if (location.pathname === '/' || location.pathname === '') {
    hubScopedState = null;
  }

  var hashView = (location.hash || '').replace('#/', '');
  if (hashView === 'terms') { renderTerms(); return; }
  if (hashView === 'privacy') { renderPrivacy(); return; }
  if (hashView === 'contact') { renderContact(); return; }
  if (hashView === 'feedback') { renderTestimonialForm(); return; }
  if (hashView === 'about') { renderAbout(); return; }
  if (hashView === 'faq') { renderFaq(); return; }
  if (hashView === 'guarantee') { renderGuarantee(); return; }
  if (hashView === 'pass-rates') { renderPassRates(); return; }
  if (hashView === 'embed') { renderEmbedGenerator(); return; }
  if (hashView === 'changelog') { renderChangelog(); return; }
  if (hashView === 'profile') { renderProfile(); return; }
  // redeem/refund are genuinely track-agnostic -- both just take a code + email and let the
  // server resolve which track it belongs to, so unlike refer/sample/buy (which really are
  // track-specific) they don't need a track-scoped path at all. Global routes, same as
  // terms/guarantee/etc. above, so no chrome linking to them has to guess/default a track.
  if (hashView === 'redeem') { renderRedeem(); return; }
  if (hashView === 'refund') { renderRefundRequest(); return; }
  if (hashView === 'gift') { renderGift(); return; }
  if (location.pathname === '/' || location.pathname === '') {
    renderHub();
    return;
  }
  // Blog (#/blog is NOT used here -- these are real pathname routes, not hash routes, so
  // _worker.js can inject per-post SEO meta and list them in sitemap.xml; a hash fragment never
  // reaches the server, so a hash-routed blog would be invisible to search engines entirely).
  if (location.pathname === '/blog' || location.pathname === '/blog/') { renderBlogList(); return; }
  var blogPostMatch = location.pathname.match(/^\/blog\/([a-z0-9-]+)\/?$/);
  if (blogPostMatch) { renderBlogPost(blogPostMatch[1]); return; }

  // Category landing page: bare /{category-slug} (e.g. /notary, /real-estate-salesperson, /cdl).
  // renderCategoryPage() itself now resolves hubScopedState (to the page's own current track's
  // state), not this branch -- see its own comment.
  var categoryPathMatch = location.pathname.match(/^\/([a-z-]+)\/?$/);
  var matchedKind = categoryPathMatch ? kindFromSlug(categoryPathMatch[1]) : '';
  if (matchedKind) {
    renderCategoryPage(matchedKind);
    return;
  }
  var track = activeTrackForPath(location.pathname);
  if (track) {
    state.examType = track.examType;
    rememberLastViewedTrack(track.examType);
    // Track pages carry a "/{category-slug}/{state}" path, not a bare state prefix, so the
    // category-page branch above never fires for them -- on a fresh/hard load (real <a href> nav
    // between pages is the norm here, not pushState) hubScopedState would otherwise stay
    // whatever it initialized to (null), which is exactly the
    // "chosen state disappears" bug. Every track belongs to exactly one state, so just sync directly
    // from the track itself instead of depending on the pathname or cookie to carry it.
    // Deliberately NOT setStateCookie() here -- that used to fire on every track-page visit, which
    // meant simply clicking into any state's track page (a testimonial, a search-engine landing, a
    // "View full track details" link, curiosity) silently overwrote the visitor's real pxq_state
    // preference, making category pages appear to "randomly" default to whatever state was last
    // browsed instead of the visitor's own state or an explicit pick-category-state choice. The
    // cookie is now only ever written by an explicit choice (pick-category-state) or first-visit
    // geolocation (_worker.js) -- see getStateCookie()'s header comment.
    if (track.stateCode && hubScopedState !== track.stateCode) {
      hubScopedState = track.stateCode;
    }
    renderTrackApp();
  }
  else renderHub();
}

window.addEventListener('hashchange', route);
window.addEventListener('popstate', route);

// ---- Answer handling (shared by click + voice) -----------------------------

async function submitAnswer(choice) {
  if (state.answered) return;
  var res = await apiFetch('/answer', { method: 'POST', body: { questionId: state.question.id, choice: choice } });
  state.answered = { picked: choice, correct: res.correct, correctChoice: res.correctChoice, explanation: res.explanation };
  quizStatsToken++; // supersede any in-flight refreshQuizStats() fetch from before this answer
  state.quizStats = { totalAnswered: res.totalAnswered, totalCorrect: res.totalCorrect };
  drawQuestion();
  // The explanation box pushes "Next question" further down -- on a short phone screen it can
  // land below the fold. block:'nearest' scrolls only the minimum distance needed to bring it
  // into view (none at all if it's already visible), instead of yanking the question off-screen.
  // Skipped when auto-advance is about to fire (correct answer + quizAutoAdvance on) -- the page
  // fully re-renders for the next question ~700ms later anyway (renderQuiz() + scrollToQuestion()),
  // so scrolling here first just adds a pointless, visible extra motion right before that happens.
  var willAutoAdvance = res.correct && quizAutoAdvance;
  if (!willAutoAdvance) {
    var nextBtn = document.querySelector('.nav-controls');
    if (nextBtn) nextBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  var scheduleAutoAdvance = function () {
    if (!(res.correct && quizAutoAdvance)) return;
    var tokenAtSchedule = quizRenderToken;
    setTimeout(function () {
      // Only advance if nothing else has already loaded a new question in the meantime (manual
      // Next click, tab switch and back, difficulty change, ...) -- renderQuiz() bumps the token
      // on every call, so a stale timer just becomes a no-op instead of yanking the user forward.
      if (quizRenderToken === tokenAtSchedule) renderQuiz();
    }, QUIZ_AUTO_ADVANCE_DELAY_MS);
  };

  // Correct/incorrect + explanation is shown on screen but intentionally not read aloud -- it just
  // delayed auto-advance for no benefit. Auto-read still covers the question + choices themselves.
  scheduleAutoAdvance();
}

// ---- Delegated event handling (CSP-safe: no inline handlers) --------------
// Listens on document (not just #app) since the header now lives outside #app.

document.addEventListener('submit', async function (e) {
  var act = e.target.getAttribute && e.target.getAttribute('data-act');
  if (act === 'help-chat-send') {
    e.preventDefault();
    var helpChatInputEl = document.getElementById('help-chat-input');
    sendHelpChatQuestion(helpChatInputEl ? helpChatInputEl.value : '');
  } else if (act === 'stripe-pay-submit') {
    e.preventDefault();
    await submitStripePayment();
  } else if (act === 'redeem-submit') {
    e.preventDefault();
    var code = e.target.code.value.trim();
    var turnstileToken = '';
    try { turnstileToken = (window.turnstileReady && window.turnstile) ? window.turnstile.getResponse() : ''; }
    catch (ignored) { turnstileToken = ''; }
    try {
      var res = await apiFetch('/redeem', { method: 'POST', body: { code: code, turnstileToken: turnstileToken } });
      setToken(res.token);
      // Redeem is reached via a hash-only route (#/redeem) while location.pathname stays whatever
      // it already was (often "/", since redeem is deliberately track-agnostic -- see route()'s own
      // comment on this). Just setting location.hash + calling renderTrackApp() directly used to
      // race the browser's own async hashchange event: hashchange still fires route(), which
      // resolves the current track from PATHNAME (activeTrackForPath()), not state.examType/hash --
      // so on a still-"/" pathname it fell through to renderHub(), clobbering the correct render a
      // moment after it happened. Net effect: redeeming never visibly landed on the code's track.
      // A real navigation to the track's own path fixes this at the root -- pathname now matches,
      // so even a hashchange-triggered route() resolves correctly. The token survives (localStorage,
      // not an in-memory var), and the normal boot sequence picks it up on the fresh page load.
      location.href = redeemDestinationUrl(res.examType);
    } catch (err) {
      renderRedeem(err.data && err.data.error === 'code_expired' ? 'This code has expired.' :
        err.data && err.data.error === 'code_revoked' ? 'This code is no longer valid.' : 'Invalid code.');
    }
  } else if (act === 'refer-submit') {
    e.preventDefault();
    var f = e.target;
    var referTurnstileToken = '';
    try { referTurnstileToken = (window.turnstileReady && window.turnstile) ? window.turnstile.getResponse() : ''; }
    catch (ignored) { referTurnstileToken = ''; }

    var friendRows = document.querySelectorAll('.referred-friend-row');
    var friends = [];
    friendRows.forEach(function (row) {
      var nameEl = row.querySelector('.referred-friend-name');
      var emailEl = row.querySelector('.referred-friend-email');
      var friendEmail = emailEl ? emailEl.value.trim() : '';
      if (friendEmail) friends.push({ name: (nameEl && nameEl.value.trim()) || undefined, email: friendEmail });
    });
    if (!friends.length) {
      var noFriendsForm = document.querySelector('form[data-act="refer-submit"]');
      if (noFriendsForm) noFriendsForm.insertAdjacentHTML('beforebegin', '<p class="error-text">Enter at least one friend\'s email.</p>');
      return;
    }

    try {
      var inviteRes = await apiFetch('/referrals/invite', {
        method: 'POST',
        body: {
          referrerEmail: f.referrerEmail.value.trim(),
          referrerName: f.referrerName.value.trim() || undefined,
          friends: friends,
          turnstileToken: referTurnstileToken,
        },
      });
      saveReferrerInfo(f.referrerName.value.trim(), f.referrerEmail.value.trim());
      var sentResults = inviteRes.results.filter(function (r) { return r.status === 'sent'; });
      var issueResults = inviteRes.results.filter(function (r) { return r.status !== 'sent'; });
      var issueLabel = {
        already_referred: 'already referred by someone', self: 'that\'s your own email',
        invalid: 'missing an email', disposable_email: 'looks like a throwaway address',
      };
      var issuesHtml = issueResults.length
        ? '<p class="muted">Couldn\'t send to:</p><ul class="muted">' + issueResults.map(function (r) {
            return '<li>' + escapeHtml(r.email || '(blank)') + ' — ' + (issueLabel[r.status] || 'error') + '</li>';
          }).join('') + '</ul>'
        : '';
      appEl.innerHTML = '<h1>Thanks!</h1>' +
        (sentResults.length
          ? '<p class="muted">We\'ve emailed ' + sentResults.length + ' friend' + (sentResults.length === 1 ? '' : 's') +
            ' to confirm — you\'ll earn points once each does.</p>'
          : '') +
        issuesHtml +
        '<a class="btn-secondary hub-cta" href="#/refer">Refer more friends</a>';
    } catch (err) {
      var referErrCode = err.data && err.data.error;
      var referMsg = referErrCode === 'rate_limited' ? 'Too many referrals sent today — try again tomorrow.' :
        referErrCode === 'disposable_email' ? 'Please use a real, non-throwaway email address for yourself.' :
        'Something went wrong. Please try again.';
      renderReferForm();
      var formEl = document.querySelector('form[data-act="refer-submit"]');
      if (formEl) formEl.insertAdjacentHTML('beforebegin', '<p class="error-text">' + referMsg + '</p>');
    }
  } else if (act === 'refund-claim-submit') {
    e.preventDefault();
    var refundForm = e.target;
    var refundTurnstileToken = '';
    try { refundTurnstileToken = (window.turnstileReady && window.turnstile) ? window.turnstile.getResponse() : ''; }
    catch (ignored) { refundTurnstileToken = ''; }
    var claimType = refundForm.claimType.value;
    try {
      var claimRes = await apiFetch('/refunds/claim', {
        method: 'POST',
        body: {
          code: refundForm.code.value.trim(),
          email: refundForm.email.value.trim(),
          claimType: claimType,
          examDate: refundForm.examDate ? refundForm.examDate.value : undefined,
          confirmationNote: refundForm.confirmationNote ? refundForm.confirmationNote.value.trim() : undefined,
          notes: refundForm.notes.value.trim(),
          turnstileToken: refundTurnstileToken,
        },
      });
      appEl.innerHTML = '<h1>Request submitted</h1>' +
        '<p class="muted">We\'ll review it and get back to you at the email you provided. Approved refunds ' +
        'of $' + (claimRes.refundCents / 100).toFixed(2) + ' are processed directly through your original payment method.</p>' +
        '<a class="btn-secondary hub-cta" href="/">Back to home</a>';
    } catch (err) {
      var refundErrCode = err.data && err.data.error;
      var refundMsg =
        refundErrCode === 'not_a_paid_purchase' ? 'That code wasn\'t a paid purchase (free/points-redeemed courses aren\'t eligible).' :
        refundErrCode === 'already_claimed' ? 'A refund request already exists for that code.' :
        refundErrCode === 'window_expired' ? 'That code is outside the eligibility window for this guarantee.' :
        refundErrCode === 'code_not_found' ? 'We couldn\'t find that access code.' :
        'Something went wrong. Please try again.';
      renderRefundRequest();
      var refundFormEl = document.querySelector('form[data-act="refund-claim-submit"]');
      if (refundFormEl) refundFormEl.insertAdjacentHTML('beforebegin', '<p class="error-text">' + refundMsg + '</p>');
    }
  } else if (act === 'contact-submit') {
    e.preventDefault();
    var contactForm = e.target;
    var contactTurnstileToken = '';
    try { contactTurnstileToken = (window.turnstileReady && window.turnstile) ? window.turnstile.getResponse() : ''; }
    catch (ignored) { contactTurnstileToken = ''; }
    try {
      await apiFetch('/contact', {
        method: 'POST',
        body: {
          name: contactForm.name.value.trim() || undefined,
          email: contactForm.email.value.trim(),
          message: contactForm.message.value.trim(),
          turnstileToken: contactTurnstileToken,
        },
      });
      appEl.innerHTML = '<h1>Message sent</h1>' +
        '<p class="muted">Thanks for reaching out — we\'ll reply to your email as soon as we can.</p>' +
        '<a class="btn-secondary hub-cta" href="/">Back to home</a>';
    } catch (err) {
      var contactErrCode = err.data && err.data.error;
      var contactMsg = contactErrCode === 'contact_not_configured' || contactErrCode === 'send_failed'
        ? 'Sorry, something went wrong on our end sending this — please try again shortly.'
        : 'Something went wrong. Please try again.';
      renderContact();
      var contactFormEl = document.querySelector('form[data-act="contact-submit"]');
      if (contactFormEl) contactFormEl.insertAdjacentHTML('beforebegin', '<p class="error-text">' + contactMsg + '</p>');
    }
  } else if (act === 'waitlist-join') {
    e.preventDefault();
    var waitlistForm = e.target;
    try {
      await apiFetch('/waitlist/join', {
        method: 'POST',
        body: {
          email: waitlistForm.email.value.trim(),
          kind: waitlistForm.getAttribute('data-kind'),
          stateCode: waitlistForm.stateCode.value,
        },
      });
      waitlistForm.outerHTML = '<p class="muted">Thanks! We\'ll email you when it\'s live.</p>';
    } catch (err) {
      var waitlistBtn = waitlistForm.querySelector('button[type="submit"]');
      if (waitlistBtn) { waitlistBtn.textContent = 'Something went wrong — try again'; waitlistBtn.disabled = false; }
    }
  } else if (act === 'testimonial-submit') {
    e.preventDefault();
    var testimonialForm = e.target;
    var testimonialTurnstileToken = '';
    try { testimonialTurnstileToken = (window.turnstileReady && window.turnstile) ? window.turnstile.getResponse() : ''; }
    catch (ignored) { testimonialTurnstileToken = ''; }
    try {
      await apiFetch('/testimonials/submit', {
        method: 'POST',
        body: {
          author: testimonialForm.author.value.trim(),
          email: testimonialForm.email.value.trim() || undefined,
          examType: testimonialForm.examType.value,
          quote: testimonialForm.quote.value.trim(),
          turnstileToken: testimonialTurnstileToken,
        },
      });
      appEl.innerHTML = '<h1>Thank you!</h1>' +
        '<p class="muted">Your testimonial has been submitted for review — thanks for taking the time to share it.</p>' +
        '<a class="btn-secondary hub-cta" href="/">Back to home</a>';
    } catch (err) {
      renderTestimonialForm();
      var testimonialFormEl = document.querySelector('form[data-act="testimonial-submit"]');
      if (testimonialFormEl) testimonialFormEl.insertAdjacentHTML('beforebegin', '<p class="error-text">Something went wrong. Please try again.</p>');
    }
  }
});

document.addEventListener('change', function (e) {
  if (e.target && e.target.name === 'claimType') {
    var failureFields = document.getElementById('refund-failure-fields');
    if (failureFields) failureFields.classList.toggle('shown', e.target.value === 'exam_failure_50pct');
  } else if (e.target && e.target.getAttribute && e.target.getAttribute('data-act') === 'change-exam-age-category') {
    examAgeCategoryOverride = e.target.value;
    renderExamIntro(examState.mode); // re-fetches /exam/config with the new override to refresh the bullets
  } else if (e.target && e.target.getAttribute && e.target.getAttribute('data-act') === 'pick-category-state') {
    var pickedState = e.target.value;
    if (!pickedState) return;
    setStateCookie(pickedState);
    var newRepTrack = categoryPageState.tracks.filter(function (t) { return t.stateCode === pickedState; })[0];
    if (!newRepTrack) return; // shouldn't happen -- the select only lists states that offer this category
    categoryPageState.repTrack = newRepTrack;
    hubScopedState = newRepTrack.stateCode;
    renderSiteFooter();
    var heroLinkWrap = document.getElementById('category-hero-track-link-wrap');
    if (heroLinkWrap) heroLinkWrap.innerHTML = categoryHeroTrackLinkHtml(newRepTrack);
    var tracksWrap = document.getElementById('category-tracks-grid-wrap');
    if (tracksWrap) tracksWrap.innerHTML = categoryCurrentTrackHtml();
    var breakdownWrap = document.getElementById('category-breakdown-wrap');
    if (breakdownWrap) breakdownWrap.innerHTML = categoryBreakdownHtml(newRepTrack);
    var sampleSubhead = document.getElementById('category-sample-subhead');
    if (sampleSubhead) sampleSubhead.innerHTML = categorySampleSubheadHtml(newRepTrack);
    var sampleWrap = document.getElementById('category-sample-question-wrap');
    if (sampleWrap) { sampleWrap.innerHTML = '<p class="muted">Loading…</p>'; loadCategorySampleQuestion(); }
  } else if (e.target && e.target.getAttribute && e.target.getAttribute('data-act') === 'pick-gift-kind') {
    giftPickedKind = e.target.value;
    giftPickedState = ''; // the old state pick may not be valid for the new category
    var giftPickerWrap = document.getElementById('gift-picker-wrap');
    if (giftPickerWrap) giftPickerWrap.innerHTML = giftPickerHtml();
    var giftResultWrapKind = document.getElementById('gift-result-wrap');
    if (giftResultWrapKind) giftResultWrapKind.innerHTML = giftResultHtml();
  } else if (e.target && e.target.getAttribute && e.target.getAttribute('data-act') === 'pick-gift-state') {
    giftPickedState = e.target.value;
    var giftResultWrapState = document.getElementById('gift-result-wrap');
    if (giftResultWrapState) giftResultWrapState.innerHTML = giftResultHtml();
  } else if (e.target && e.target.getAttribute && e.target.getAttribute('data-act') === 'pick-embed-kind') {
    embedPickedKind = e.target.value;
    embedPickedState = ''; // the old state pick may not offer this category
    var embedPickerWrap = document.getElementById('embed-picker-wrap');
    if (embedPickerWrap) embedPickerWrap.innerHTML = embedPickerHtml();
    var embedResultWrapKind = document.getElementById('embed-result-wrap');
    if (embedResultWrapKind) embedResultWrapKind.innerHTML = embedResultHtml();
  } else if (e.target && e.target.getAttribute && e.target.getAttribute('data-act') === 'pick-embed-state') {
    embedPickedState = e.target.value;
    var embedResultWrapState = document.getElementById('embed-result-wrap');
    if (embedResultWrapState) embedResultWrapState.innerHTML = embedResultHtml();
  }
});

document.addEventListener('click', async function (e) {
  var el = e.target.closest && e.target.closest('[data-act]');
  if (!el) return;
  // Sub-tab links are real <a href="#"> (for the pill styling), but are handled entirely here --
  // without this, the browser's own navigation to "#" would fire the hashchange listener and
  // the router would fall back to the default tab, undoing the tab switch this handler just made.
  if (el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault();
  var act = el.getAttribute('data-act');
  if (act === 'toggle-help-chat') {
    if (helpChatOpen) {
      closeHelpChat();
    } else {
      helpChatOpen = true;
      var helpChatPanelEl = document.getElementById('help-chat-panel');
      if (helpChatPanelEl) helpChatPanelEl.hidden = false;
      openHelpChatIfNeeded();
      var helpChatInputEl = document.getElementById('help-chat-input');
      if (helpChatInputEl) helpChatInputEl.focus();
    }
  } else if (act === 'help-chat-suggestion') {
    sendHelpChatQuestion(el.getAttribute('data-question') || '');
  } else if (act === 'listen') {
    speak(questionReadText(state.question));
  } else if (act === 'answer') {
    stopSpeaking();
    if (recognition && isRecording) recognition.stop();
    await submitAnswer(el.getAttribute('data-choice'));
  } else if (act === 'next-question') {
    stopSpeaking();
    renderQuiz();
  } else if (act === 'quiz-difficulty') {
    var newDifficulty = el.getAttribute('data-difficulty');
    if (newDifficulty === state.quizDifficulty) return;
    state.quizDifficulty = newDifficulty;
    localStorage.setItem('examprep_quiz_difficulty', newDifficulty);
    stopSpeaking();
    renderQuiz();
  } else if (act === 'toggle-quiz-controls') {
    quizControlsExpanded = !quizControlsExpanded;
    drawQuestion();
  } else if (act === 'toggle-quiz-autoadvance') {
    quizAutoAdvance = el.checked;
    localStorage.setItem('examprep_quiz_autoadvance', quizAutoAdvance ? '1' : '0');
  } else if (act === 'toggle-quiz-autoread') {
    quizAutoRead = el.checked;
    localStorage.setItem('examprep_quiz_autoread', quizAutoRead ? '1' : '0');
    if (!quizAutoRead) { stopSpeaking(); }
    else if (state.question && !state.answered) { speak(questionReadText(state.question)); }
  } else if (act === 'toggle-exam-autoadvance') {
    examAutoAdvance = el.checked;
    localStorage.setItem('examprep_exam_autoadvance', examAutoAdvance ? '1' : '0');
  } else if (act === 'toggle-exam-nav') {
    examNavExpanded = !examNavExpanded;
    drawExamSitting();
  } else if (act === 'go-back') {
    history.back();
  } else if (act === 'category-quick-buy') {
    // #/buy is only handled by renderTrackApp()'s hash dispatch, which route() only ever reaches
    // once location.pathname has already matched a real track route (see route()'s own "var track
    // = activeTrackForPath(...)" branch) -- it does NOT fire from a category page's bare pathname,
    // so just setting location.hash while staying put here would silently no-op. A real navigation
    // to the track's own page with the hash already appended lands directly on the buy form once
    // that fresh load's route() resolves the pathname to this track.
    var quickBuyRoute = el.getAttribute('data-track-route');
    if (quickBuyRoute) location.href = quickBuyRoute + '#/buy';
  } else if (act === 'blog-load-more') {
    blogListState.visibleCount = Math.min(blogListState.visibleCount + BLOG_PAGE_SIZE, blogListState.shown.length);
    drawBlogList();
  } else if (act === 'sample-answer') {
    sampleState.selected = el.getAttribute('data-choice');
    drawSampleQuestion();
  } else if (act === 'sample-submit') {
    stopSpeaking();
    sampleState.answered = sampleState.selected;
    drawSampleQuestion();
    trackEvent('quiz_completed', sampleState.examType);
  } else if (act === 'sample-listen') {
    speak(questionReadText(sampleState.questions[sampleState.index]));
  } else if (act === 'category-sample-answer') {
    categoryPageState.sampleSelected = el.getAttribute('data-choice');
    drawCategorySampleQuestion();
  } else if (act === 'category-sample-submit') {
    stopSpeaking();
    categoryPageState.sampleAnswered = categoryPageState.sampleSelected;
    drawCategorySampleQuestion();
    trackEvent('quiz_completed', categoryPageState.repTrack && categoryPageState.repTrack.examType);
  } else if (act === 'category-sample-listen') {
    speak(questionReadText(categoryPageState.sampleQuestion));
  } else if (act === 'track-landing-sample-answer') {
    trackLandingSample.selected = el.getAttribute('data-choice');
    drawTrackLandingSampleQuestion();
  } else if (act === 'track-landing-sample-submit') {
    stopSpeaking();
    trackLandingSample.answered = trackLandingSample.selected;
    drawTrackLandingSampleQuestion();
    trackEvent('quiz_completed', state.examType);
  } else if (act === 'track-landing-sample-listen') {
    speak(questionReadText(trackLandingSample.question));
  } else if (act === 'sample-next') {
    stopSpeaking();
    sampleState.index += 1;
    sampleState.selected = null;
    sampleState.answered = null;
    drawSampleQuestion();
  } else if (act === 'mic-toggle') {
    if (!recognition) return;
    if (!isRecording) {
      isRecording = true;
      el.textContent = '🎙️ Listening…';
      el.classList.add('listening');
      recognition.start();
    } else {
      recognition.stop();
    }
  } else if (act === 'dismiss-news') {
    localStorage.setItem('examprep_news_dismissed', SITE_NEWS.id);
    var bannerEl = el.closest('.news-flash-banner');
    if (bannerEl) bannerEl.remove();
  } else if (act === 'dismiss-promo') {
    dismissPromoId(el.getAttribute('data-promo-id'));
    var promoBannerEl = el.closest('.promo-banner');
    var inRibbon = promoBannerEl && promoBannerEl.closest('#promo-ribbon-wrap');
    if (promoBannerEl) promoBannerEl.remove();
    // The ribbon is the one always-visible slot -- falls back to the guarantee tagline instead of
    // going blank, rather than just disappearing like the hub/checkout/refer promo cards do.
    if (inRibbon) fillPromoRibbon();
  } else if (act === 'reload-for-update') {
    location.reload();
  } else if (act === 'dismiss-update-banner') {
    updateBannerDismissed = true;
    var updateBannerEl = document.getElementById('update-available-banner');
    if (updateBannerEl) updateBannerEl.remove();
  } else if (act === 'sort-progress-topics') {
    var sortKey = el.getAttribute('data-sort-key');
    if (progressSort.key === sortKey) progressSort.dir = progressSort.dir === 'asc' ? 'desc' : 'asc';
    else { progressSort.key = sortKey; progressSort.dir = sortKey === 'topic' ? 'asc' : 'desc'; }
    var topicsWrap = document.getElementById('progress-topics-wrap');
    if (topicsWrap) topicsWrap.innerHTML = progressTopicsTableHtml();
  } else if (act === 'sort-leaderboard') {
    leaderboardSortKey = el.getAttribute('data-sort-key');
    var leaderboardWrap = document.getElementById('leaderboard-wrap');
    if (leaderboardWrap) leaderboardWrap.innerHTML = leaderboardTableHtml();
  } else if (act === 'toggle-progress-topics') {
    progressTopicsExpanded = !progressTopicsExpanded;
    var toggleWrap = document.getElementById('progress-topics-wrap');
    if (toggleWrap) toggleWrap.innerHTML = progressTopicsTableHtml();
  } else if (act === 'toggle-exam-attempt') {
    var attemptId = el.getAttribute('data-attempt-id');
    var rerenderAttemptWrap = function () {
      var attemptWrap = document.getElementById('exam-attempts-wrap');
      if (attemptWrap) attemptWrap.innerHTML = examAttemptsSectionHtml();
    };
    examAttemptOpenId = examAttemptOpenId === attemptId ? null : attemptId;
    if (examAttemptOpenId && !examAttemptDetailCache[attemptId]) {
      apiFetch('/exam/attempt?attemptId=' + encodeURIComponent(attemptId)).then(function (result) {
        examAttemptDetailCache[attemptId] = { review: result.review };
        if (examAttemptOpenId === attemptId) rerenderAttemptWrap();
      }).catch(function () {
        examAttemptDetailCache[attemptId] = { error: true };
        if (examAttemptOpenId === attemptId) rerenderAttemptWrap();
      });
    }
    rerenderAttemptWrap();
  } else if (act === 'toggle-exam-attempts-expanded') {
    examAttemptsExpanded = !examAttemptsExpanded;
    var expandWrap = document.getElementById('exam-attempts-wrap');
    if (expandWrap) expandWrap.innerHTML = examAttemptsSectionHtml();
  } else if (act === 'sort-exam-attempts') {
    var attemptSortKey = el.getAttribute('data-sort-key');
    if (examAttemptsSort.key === attemptSortKey) examAttemptsSort.dir = examAttemptsSort.dir === 'asc' ? 'desc' : 'asc';
    else { examAttemptsSort.key = attemptSortKey; examAttemptsSort.dir = attemptSortKey === 'mode' ? 'asc' : 'desc'; }
    var sortWrap = document.getElementById('exam-attempts-wrap');
    if (sortWrap) sortWrap.innerHTML = examAttemptsSectionHtml();
  } else if (act === 'progress-reset-select') {
    progressResetPending = el.getAttribute('data-scope');
    var resetWrapSelect = document.getElementById('progress-reset-wrap');
    if (resetWrapSelect) resetWrapSelect.innerHTML = progressResetSectionHtml();
  } else if (act === 'progress-reset-cancel') {
    progressResetPending = null;
    var resetWrapCancel = document.getElementById('progress-reset-wrap');
    if (resetWrapCancel) resetWrapCancel.innerHTML = progressResetSectionHtml();
  } else if (act === 'progress-reset-confirm') {
    var resetScope = el.getAttribute('data-scope');
    el.disabled = true;
    try {
      await apiFetch('/progress/reset', { method: 'POST', body: { scope: resetScope } });
      renderProgress();
    } catch (err) {
      el.disabled = false;
      var resetWrapErr = document.getElementById('progress-reset-wrap');
      if (resetWrapErr) resetWrapErr.insertAdjacentHTML('beforeend', '<p class="error-text">Could not reset. Try again shortly.</p>');
    }
  } else if (act === 'scroll-to-tracks') {
    var tracksEl = document.getElementById('tracks');
    if (tracksEl) tracksEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (act === 'scroll-to-category-sample') {
    var sampleEl = document.getElementById('category-sample');
    if (sampleEl) sampleEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (act === 'toggle-theme') {
    var nextTheme = el.getAttribute('data-next');
    var local = loadLocalPrefs();
    saveLocalPrefs(nextTheme, local.fontScale);
    applyTheme(nextTheme, local.fontScale);
    updateThemeButton();
    if (getToken()) apiFetch('/prefs', { method: 'POST', body: { theme: nextTheme } }).catch(function () {});
    // Turnstile's own chrome is set at render time (see renderTurnstileWidget's theme param) --
    // toggling the site theme afterward would otherwise leave an already-mounted widget stuck in
    // the old theme, mismatched against the card around it. Re-mount it if one's on screen.
    var mountedTurnstileEl = document.querySelector('#turnstile-container');
    if (mountedTurnstileEl && window.turnstile) {
      try { window.turnstile.remove(mountedTurnstileEl); } catch (ignored) { /* not yet rendered */ }
      renderTurnstileWidget();
    }
  } else if (act === 'font-up' || act === 'font-down') {
    var l = loadLocalPrefs();
    var next = Math.max(0.85, Math.min(1.4, l.fontScale + (act === 'font-up' ? 0.05 : -0.05)));
    saveLocalPrefs(l.theme, next);
    applyTheme(l.theme, next);
    if (getToken()) apiFetch('/prefs', { method: 'POST', body: { fontScale: next } }).catch(function () {});
  } else if (act === 'log-out') {
    clearToken();
    accountExamType = null;
    renderSiteHeader();
    renderSiteFooter();
    location.hash = '';
    renderTrackApp();
  } else if (act === 'toggle-profile-menu') {
    var profileMenuEl = el.closest('.profile-menu');
    if (profileMenuEl) profileMenuEl.classList.toggle('open');
  } else if (act === 'toggle-header-menu') {
    var drawerEl = document.getElementById('site-mobile-drawer');
    var isOpen = drawerEl ? drawerEl.classList.toggle('open') : false;
    el.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    el.textContent = isOpen ? '✕' : '☰';
  } else if (act === 'landing-preview-tab') {
    var previewTabKey = el.getAttribute('data-tab');
    document.querySelectorAll('.locked-preview-tabs button').forEach(function (b) {
      b.classList.toggle('active', b === el);
    });
    document.querySelectorAll('.locked-preview-mockup').forEach(function (p) {
      p.hidden = p.getAttribute('data-preview-panel') !== previewTabKey;
    });
    // Resources/Info aren't login-gated (see renderTabs()) -- no lock overlay over their real
    // content, unlike quiz/exam/progress.
    var isGatedPreviewTab = previewTabKey === 'quiz' || previewTabKey === 'exam' || previewTabKey === 'progress';
    var overlayEl = document.getElementById('landing-preview-overlay');
    if (overlayEl) overlayEl.hidden = !isGatedPreviewTab;
    var unlockTextEl = document.getElementById('landing-preview-unlock-text');
    if (unlockTextEl && isGatedPreviewTab) unlockTextEl.textContent = 'Unlock the full ' + previewTabKey + ' for this track';
  } else if (act === 'copy-code') {
    var codeVal = el.getAttribute('data-code');
    if (navigator.clipboard) navigator.clipboard.writeText(codeVal).catch(function () {});
    el.textContent = 'Copied!';
    setTimeout(function () { el.textContent = 'Copy code'; }, 1500);
  } else if (act === 'copy-embed-snippet') {
    var snippetVal = el.getAttribute('data-snippet');
    if (navigator.clipboard) navigator.clipboard.writeText(snippetVal).catch(function () {});
    el.textContent = 'Copied!';
    setTimeout(function () { el.textContent = 'Copy snippet'; }, 1500);
  } else if (act === 'share-refer-link') {
    var shareUrl = el.getAttribute('data-share-url');
    var shareTitle = el.getAttribute('data-share-title');
    // If the referrer has already typed their own email into the form above, mint a real
    // tracked ?ref=<accountId> link (via /referrals/link) so a purchase later actually credits
    // them -- see detectAndCreditConversion() on the API side. Best-effort: if this fails (no
    // email filled in yet, offline, etc.) falls back to sharing the plain untracked page link.
    var referrerEmailEl = document.querySelector('[name="referrerEmail"]');
    var referrerEmailVal = referrerEmailEl ? referrerEmailEl.value.trim() : '';
    if (referrerEmailVal) {
      try {
        var linkRes = await apiFetch('/referrals/link', { method: 'POST', body: { email: referrerEmailVal } });
        if (linkRes && linkRes.accountId) {
          shareUrl += (shareUrl.indexOf('?') === -1 ? '?' : '&') + 'ref=' + encodeURIComponent(linkRes.accountId);
        }
      } catch (e) { /* fall back to the untracked link below */ }
    }
    var shareText = 'I\'ve been using this to study for my ' + shareTitle + ' exam — worth a look:';
    if (navigator.share) {
      navigator.share({ title: shareTitle, text: shareText, url: shareUrl }).catch(function () { /* user cancelled -- no-op */ });
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(shareText + ' ' + shareUrl).catch(function () {});
      var originalLabel = el.textContent;
      el.textContent = 'Link copied!';
      setTimeout(function () { el.textContent = originalLabel; }, 1500);
    }
  } else if (act === 'add-referred-friend') {
    var friendsListEl = document.getElementById('referred-friends-list');
    if (friendsListEl) friendsListEl.insertAdjacentHTML('beforeend', renderReferFriendRow(referFriendRowCount++));
  } else if (act === 'remove-referred-friend') {
    var removeIdx = el.getAttribute('data-row-index');
    var rowToRemove = document.querySelector('.referred-friend-row[data-row-index="' + removeIdx + '"]');
    if (rowToRemove) rowToRemove.remove();
  } else if (act === 'exam-begin' || act === 'exam-restart') {
    await beginExam(el.getAttribute('data-mode') || 'standard');
  } else if (act === 'exam-goto') {
    stopSpeaking();
    examState.currentIndex = Number(el.getAttribute('data-index'));
    drawExamSitting();
    scrollToQuestion();
    speakCurrentExamQuestion();
  } else if (act === 'exam-prev') {
    stopSpeaking();
    examState.currentIndex = Math.max(0, examState.currentIndex - 1);
    drawExamSitting();
    scrollToQuestion();
    speakCurrentExamQuestion();
  } else if (act === 'exam-next') {
    stopSpeaking();
    examState.currentIndex = Math.min(examState.attempt.questions.length - 1, examState.currentIndex + 1);
    drawExamSitting();
    scrollToQuestion();
    speakCurrentExamQuestion();
  } else if (act === 'exam-answer') {
    stopSpeaking();
    await selectExamAnswer(el.getAttribute('data-choice'));
  } else if (act === 'exam-listen') {
    speak(questionReadText(examState.attempt.questions[examState.currentIndex]));
  } else if (act === 'toggle-exam-autoread') {
    examAutoRead = el.checked;
    localStorage.setItem('examprep_exam_autoread', examAutoRead ? '1' : '0');
    if (!examAutoRead) stopSpeaking();
    else speakCurrentExamQuestion();
  } else if (act === 'toggle-exam-unseen-only') {
    examUnseenOnly = el.checked;
    localStorage.setItem('examprep_exam_unseenonly', examUnseenOnly ? '1' : '0');
  } else if (act === 'exam-submit-confirm') {
    examDiscardConfirmPending = false;
    var unanswered = examState.attempt.questions.length - Object.keys(examState.attempt.answers).length;
    if (unanswered > 0) {
      examSubmitConfirmPending = true;
      drawExamSitting();
      return;
    }
    await submitExam();
  } else if (act === 'exam-submit-confirmed') {
    examSubmitConfirmPending = false;
    await submitExam();
  } else if (act === 'exam-submit-cancel') {
    examSubmitConfirmPending = false;
    drawExamSitting();
  } else if (act === 'exam-discard-confirm') {
    examSubmitConfirmPending = false;
    examDiscardConfirmPending = true;
    drawExamSitting();
  } else if (act === 'exam-discard-confirmed') {
    examDiscardConfirmPending = false;
    await discardExam();
  } else if (act === 'exam-discard-cancel') {
    examDiscardConfirmPending = false;
    drawExamSitting();
  } else if (act === 'toggle-wrong-only') {
    var reviewListEl = document.getElementById('mockexam-review-list');
    if (reviewListEl) reviewListEl.classList.toggle('review-wrong-only', el.checked);
  } else if (act === 'sort-resources') {
    var sortKey = el.getAttribute('data-key');
    if (resourcesSort.key === sortKey) resourcesSort.dir *= -1;
    else { resourcesSort.key = sortKey; resourcesSort.dir = 1; }
    renderResourcesTable();
  } else if (act === 'select-resource-topic-tab') {
    currentResourcesTopic = el.getAttribute('data-topic') || null;
    resourcesOpenIndex = null; // avoid a now-hidden row staying "expanded" behind the scenes
    flashcardState = null;
    renderResourcesTable();
  } else if (act === 'toggle-resource-media') {
    var toggleIdx = Number(el.getAttribute('data-index'));
    var opening = resourcesOpenIndex !== toggleIdx;
    resourcesOpenIndex = opening ? toggleIdx : null;
    if (!opening) flashcardState = null; // closing the row -- don't leave stale deck position behind
    if (opening) {
      var openedRow = resourcesRowsCache[toggleIdx];
      if (openedRow) {
        // pdf/image/table have no meaningful "extent" -- opening them is the whole interaction,
        // so mark 100% immediately. Audio/video start at 0 and update via timeupdate below.
        var initialPercent = (openedRow.type === 'audio' || openedRow.type === 'video') ? 0 : 100;
        postResourceProgress(openedRow.resourceKey, openedRow.type, initialPercent, true);
        if (resourceProgressCache[openedRow.resourceKey]) {
          resourceProgressCache[openedRow.resourceKey].percent = Math.max(resourceProgressCache[openedRow.resourceKey].percent, initialPercent);
        } else {
          resourceProgressCache[openedRow.resourceKey] = { percent: initialPercent, times_opened: 1 };
        }
      }
    }
    renderResourcesTable();
  } else if (act === 'flip-flashcard') {
    if (flashcardState) flashcardState.flipped = !flashcardState.flipped;
    renderResourcesTable();
  } else if (act === 'next-flashcard') {
    if (flashcardState) { flashcardState.index++; flashcardState.flipped = false; }
    renderResourcesTable();
  } else if (act === 'prev-flashcard') {
    if (flashcardState) { flashcardState.index = Math.max(0, flashcardState.index - 1); flashcardState.flipped = false; }
    renderResourcesTable();
  } else if (act === 'shuffle-flashcards') {
    var shuffleIdx = flashcardState ? flashcardState.resourceIndex : null;
    var shuffleRow = shuffleIdx != null ? resourcesRowsCache[shuffleIdx] : null;
    if (shuffleRow && shuffleRow.flashcards) {
      // Fisher-Yates, in place -- the underlying RESOURCES data is shared module state, so this
      // reshuffles the deck for every future open too, not just this session (matches "shuffle"
      // meaning "randomize study order," not "temporarily preview a random order").
      var deck = shuffleRow.flashcards;
      for (var si = deck.length - 1; si > 0; si--) {
        var sj = Math.floor(Math.random() * (si + 1));
        var tmp = deck[si]; deck[si] = deck[sj]; deck[sj] = tmp;
      }
      flashcardState.index = 0;
      flashcardState.flipped = false;
    }
    renderResourcesTable();
  } else if (act === 'skip-resource-player') {
    var seekPlayer = document.querySelector('.resource-player[data-resource-key]');
    if (seekPlayer) seekPlayer.currentTime = Math.max(0, seekPlayer.currentTime + (Number(el.getAttribute('data-seek')) || 0));
  } else if (act === 'toggle-apply-points') {
    updateBuyTotalDisplay();
    if (document.getElementById('stripe-payment-form')) mountStripePaymentElement();
  } else if (act === 'apply-promo-code') {
    var promoInputEl = document.getElementById('buy-promo-input');
    var promoCodeEntered = promoInputEl ? promoInputEl.value.trim() : '';
    var promoResultDivEl = document.getElementById('buy-promo-result');
    if (!promoCodeEntered) return;
    buyPromoCode = promoCodeEntered;
    if (promoResultDivEl) promoResultDivEl.innerHTML = '<p class="muted">Checking…</p>';
    if (document.getElementById('stripe-payment-form')) mountStripePaymentElement();
  } else if (act === 'apply-points-promo-code') {
    await applyPointsPromoCode();
  } else if (act === 'check-points') {
    var pointsEmailEl = document.getElementById('buy-email');
    var checkEmail = pointsEmailEl ? pointsEmailEl.value.trim() : '';
    var resultEl = document.getElementById('points-result');
    if (!checkEmail) { if (resultEl) resultEl.innerHTML = '<p class="error-text">Enter your email above first.</p>'; return; }
    if (resultEl) resultEl.innerHTML = '<p class="muted">Checking…</p>';
    try {
      var balanceRes = await apiFetch('/points/balance?email=' + encodeURIComponent(checkEmail));
      if (!resultEl) return;
      var trackReq = balanceRes.examTypes.filter(function (t) { return t.examType === state.examType; })[0];
      var required = trackReq ? trackReq.pointsRequired : null;
      if (required != null && balanceRes.points >= required) {
        resultEl.innerHTML = '<p class="result-correct">You have ' + balanceRes.points + ' points — enough for free access!</p>' +
          '<button class="btn-primary btn-sm" type="button" data-act="redeem-points" data-email="' + checkEmail + '">Email me a redemption link</button>';
      } else if (balanceRes.points > 0) {
        var discountLabel = '$' + (balanceRes.points / 100).toFixed(2);
        resultEl.innerHTML = '<p class="muted">You have ' + balanceRes.points + ' points (' + discountLabel + ' value).</p>' +
          '<label class="points-apply-label"><input type="checkbox" id="apply-points-checkbox" ' +
          'data-points-available="' + balanceRes.points + '" data-act="toggle-apply-points"> Apply my points to this purchase (up to -' + discountLabel + ')</label>';
      } else {
        resultEl.innerHTML = '<p class="muted">You have 0 points. <a href="#/refer">Refer friends to earn some →</a></p>';
      }
    } catch (err) {
      if (resultEl) resultEl.innerHTML = '<p class="error-text">Could not check your balance. Try again shortly.</p>';
    }
  } else if (act === 'redeem-points') {
    var redeemEmail = el.getAttribute('data-email');
    var redeemTurnstileToken = '';
    try { redeemTurnstileToken = (window.turnstileReady && window.turnstile) ? window.turnstile.getResponse() : ''; }
    catch (ignored) { redeemTurnstileToken = ''; }
    var pointsResultEl = document.getElementById('points-result');
    try {
      await apiFetch('/points/redeem', {
        method: 'POST', body: { email: redeemEmail, examType: state.examType, turnstileToken: redeemTurnstileToken },
      });
      // Doesn't redeem instantly -- a confirmation link goes to that email first, so only
      // someone who actually controls the inbox can complete the redemption.
      if (pointsResultEl) pointsResultEl.innerHTML =
        '<p class="result-correct">Check ' + escapeHtml(redeemEmail) + ' for a confirmation link — click it to get your code.</p>';
    } catch (err) {
      var redeemErrCode = err.data && err.data.error;
      var redeemMsg = redeemErrCode === 'insufficient_points' ? 'Your points balance changed — recheck it above.' :
        'Could not redeem — try again shortly.';
      if (pointsResultEl) pointsResultEl.innerHTML = '<p class="error-text">' + redeemMsg + '</p>';
    }
  }
});

// The toggle itself lives inside .profile-menu (so this never fights the toggle-profile-menu
// handler above), this only needs to catch clicks anywhere else while the menu is open.
document.addEventListener('click', function (e) {
  var openMenu = document.querySelector('.profile-menu.open');
  if (openMenu && !openMenu.contains(e.target)) openMenu.classList.remove('open');
});

// Redundant close paths for the help chat panel -- reported hard to close via the small ✕ alone
// (an imprecise click/tap on a fixed-corner button is a real failure mode, not a one-off), so
// this adds click-outside and Escape as backup, same click-outside pattern as .profile-menu
// above. #help-chat-root (not just .help-chat-panel) is the "inside" boundary, so a click on the
// toggle bubble itself -- also inside that root, already handled by the toggle-help-chat
// dispatcher above -- doesn't get double-processed here.
document.addEventListener('click', function (e) {
  if (!helpChatOpen) return;
  var root = document.getElementById('help-chat-root');
  if (root && !root.contains(e.target)) closeHelpChat();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && helpChatOpen) closeHelpChat();
});

// ---- Update checker ---------------------------------------------------
// index.html itself is served with max-age=0 (always revalidated on a real page load), but this
// is a long-lived SPA -- someone who leaves a tab open for hours/days never re-fetches it on
// their own, so they can sit on stale JS/CSS indefinitely without knowing. Periodically re-fetch
// it in the background and compare app.js's cache-bust version; if it changed, show a dismissible
// banner with a Refresh button rather than force-reloading (which could interrupt something like
// an in-progress mock exam, even though exam state itself would survive the reload).
var UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
var updateBannerDismissed = false;

function currentAppJsVersion() {
  var el = document.querySelector('script[src*="/js/app.js"]');
  var m = el && el.src.match(/[?&]v=(\d+)/);
  return m ? m[1] : null;
}

function checkForUpdate() {
  if (updateBannerDismissed || document.getElementById('update-available-banner')) return;
  fetch('/', { cache: 'no-store' }).then(function (res) { return res.text(); }).then(function (html) {
    var m = html.match(/\/js\/app\.js\?v=(\d+)/);
    var latest = m ? m[1] : null;
    var current = currentAppJsVersion();
    if (!latest || !current || latest === current) return;
    document.body.insertAdjacentHTML('afterbegin',
      '<div class="update-available-banner" id="update-available-banner">' +
      '<span>A new version of PassExamHQ is available.</span>' +
      '<button class="btn-primary btn-sm" type="button" data-act="reload-for-update">Refresh</button>' +
      '<button class="update-available-dismiss" type="button" data-act="dismiss-update-banner" aria-label="Dismiss">✕</button>' +
      '</div>');
  }).catch(function () {}); // best-effort -- never disrupts the app itself
}

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') checkForUpdate();
});
setInterval(function () { if (document.visibilityState === 'visible') checkForUpdate(); }, UPDATE_CHECK_INTERVAL_MS);

// ---- Boot -------------------------------------------------------------

(function boot() {
  var local = loadLocalPrefs();
  applyTheme(local.theme, local.fontScale);
  renderSiteHeader();
  renderSiteFooter();
  renderHelpChatWidget(); // outside appEl -- rendered once here only, so it survives every route() re-render
  // Must know which track the token (if any) actually belongs to, AND have the real
  // track_registry identity data (kind/state/short_name/active for all 244 tracks, including any
  // admin "pull from sale" toggle -- active lives directly on the registry row now, no separate
  // override layer) BEFORE #app's first render -- otherwise isLoggedInForCurrentTrack() would
  // wrongly read as "not logged in" for a moment (accountExamType still null), and HUB_EXAMS could
  // render as empty (see buildHubExams -- it starts as []). Both resolve near-instantly in the
  // common case. The header/footer sync calls above necessarily ran before this resolves too (with
  // accountExamType still null and HUB_EXAMS still empty) -- re-render both once the real values
  // are in, so a logged-in visitor's Refer/sample links reflect their own track's account instead
  // of no track/whatever page they'd last viewed.
  // Resource COUNTS are deliberately NOT in the gate below (changed 2026-09-05). They used to be --
  // as the full ~2.4MB catalog, no less -- which meant every page load waited on the single largest
  // payload this site serves before painting anything, to render pages that mostly needed a handful
  // of integers from it. Kicked off here so it's in flight during the blocking fetches, and the
  // surfaces that use it (stat tiles, resourceInventorySummary) fill in when it lands.
  loadResourceCounts().then(fillResourceCountSurfaces);
  Promise.all([loadSiteConfig(), loadAccountExamType(), loadTrackRegistry()]).then(function () {
    renderSiteHeader();
    renderSiteFooter();
    route();
    // route() is what actually resolves hubScopedState (from the pathname, or -- for a track's own
    // page -- from the track itself, see the activeTrackForPath branch), and both renders above ran
    // before it -- so the footer's "top 3 state tracks" fell back to whatever's first in HUB_EXAMS
    // (California) rather than the visitor's real state. Re-render now that it's resolved.
    renderSiteFooter();
  });
})();
