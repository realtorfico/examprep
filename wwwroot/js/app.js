// Vanilla JS, no framework/bundler. Hash-routed within a track's path (e.g. /notary); pathname-routed
// at the top level, matched against HUB_EXAMS's active tracks (see activeTrackForPath).
var appEl = document.getElementById('app');
var state = { question: null, answered: null, examType: 'ca_notary', quizDifficulty: localStorage.getItem('examprep_quiz_difficulty') || '' };
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
var examNavExpanded = false; // collapsed by default -- 45 nav boxes eat too much vertical space on mobile
var examSubmitConfirmPending = false; // in-page (non-native) "N unanswered, submit anyway?" confirmation
var examDiscardConfirmPending = false; // in-page confirmation for "discard this attempt and start over?"
var sampleState = { questions: null, index: 0, answered: null };
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
    theme: localStorage.getItem('examprep_theme') || 'dark',
    fontScale: parseFloat(localStorage.getItem('examprep_font') || '1'),
  };
}
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
    '<span class="site-logo-text"><a href="/" class="site-logo-word">PassExam<span class="site-logo-accent">HQ</span></a>' +
    '<a href="#/guarantee" class="site-logo-tagline">Pass Exam - Or Your Money Back</a></span>' +
    '</span>';

  // Marketing nav + CTAs (ported from v0's site-header.tsx) -- inline on desktop, folded into a
  // mobile drawer below the row on narrow screens. Kept separate from the existing font/theme/
  // profile controls (unchanged, still always visible) rather than merged into one cluster, so
  // adding these doesn't touch anything already working.
  var anchorRoute = (currentOrFirstActiveTrack() || {}).route || '/';
  var navLinksHtml = '<a href="/#tracks">Exam tracks</a>' +
    '<a href="#/guarantee">Guarantee</a>' +
    '<a href="' + anchorRoute + '#/refer">Refer &amp; earn</a>';
  var navCtaHtml = '<a class="btn-secondary btn-sm" href="' + anchorRoute + '#/redeem">Redeem code</a>' +
    '<a class="btn-primary btn-sm" href="/#tracks">Browse exams</a>';

  document.getElementById('site-header').innerHTML =
    '<div class="site-shell top-controls">' +
    logo +
    '<nav class="site-nav" aria-label="Primary">' + navLinksHtml + '</nav>' +
    '<div class="control-group">' +
    '<div class="site-nav-cta">' + navCtaHtml + '</div>' +
    '<button class="header-menu-toggle" type="button" data-act="toggle-header-menu" aria-label="Open menu" aria-expanded="false">☰</button>' +
    '<div class="font-size-pill" role="group" aria-label="Font size">' +
    '<button data-act="font-down">A-</button>' +
    '<button data-act="font-up">A+</button>' +
    '</div>' +
    '<button class="btn-secondary btn-sm" id="theme-toggle-btn" data-act="toggle-theme"></button>' +
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

// On a specific track's page, the footer's affiliation disclaimer names that track's real
// agency/requirement (accurate and precise). On the hub itself (no track in the URL path) there's
// no single track to name -- falling back to trackCompliance's default (ca_notary) would wrongly
// imply the site's only affiliation-relevant agencies are California's, when 14 tracks across 4
// states now exist. Use a deliberately agency-name-free disclaimer there instead, broad enough to
// cover every current and future track without needing an update each time one's added.
var HUB_FOOTER_ORG_LINE = 'any state department of motor vehicles, state licensing agency, official examination vendor,';
var HUB_FOOTER_REQUIREMENT = 'do not fulfill any state-mandated licensing, driver education, or training requirement';

// Four-column footer (ported from v0's site-footer.tsx) -- link destinations are all real routes
// (no v0 placeholder hrefs carried over): the Exams column samples a few real live tracks rather
// than hardcoding specific slugs, so it stays correct as tracks are added; Product/Legal links use
// currentOrFirstActiveTrack() for whichever track-scoped destination is relevant on the current page.
function renderSiteFooter() {
  var pageTrack = activeTrackForPath(window.location.pathname);
  var orgLine = pageTrack ? trackCompliance(pageTrack.examType).orgLine : HUB_FOOTER_ORG_LINE;
  var requirement = pageTrack ? trackCompliance(pageTrack.examType).footerRequirement : HUB_FOOTER_REQUIREMENT;
  var anchorTrack = currentOrFirstActiveTrack() || {};
  var anchorRoute = anchorTrack.route || '/';
  var sampleTracks = HUB_EXAMS.filter(function (e) { return e.active; }).slice(0, 3);

  var exverse = '<div><h3>Exams</h3><ul class="footer-link-list">' +
    '<li><a href="/#tracks">All exam tracks</a></li>' +
    sampleTracks.map(function (t) { return '<li><a href="' + t.route + '">' + escapeHtml(t.shortName || t.title) + '</a></li>'; }).join('') +
    '</ul></div>';
  var productCol = '<div><h3>Product</h3><ul class="footer-link-list">' +
    '<li><a href="' + anchorRoute + '#/redeem">Redeem access code</a></li>' +
    '<li><a href="#/guarantee">Guarantee &amp; refunds</a></li>' +
    '<li><a href="' + anchorRoute + '#/refer">Refer &amp; earn</a></li>' +
    '<li><a href="' + anchorRoute + '#/sample">Free sample questions</a></li>' +
    '</ul></div>';
  var legalCol = '<div><h3>Legal</h3><ul class="footer-link-list">' +
    '<li><a href="#/terms">Terms of service</a></li>' +
    '<li><a href="#/privacy">Privacy policy</a></li>' +
    '<li><a href="' + anchorRoute + '#/refund">Refund request</a></li>' +
    '<li><a href="#/contact">Contact us</a></li>' +
    '</ul></div>';

  document.getElementById('site-footer').innerHTML =
    '<div class="site-shell footer-shell">' +
    '<div class="footer-grid">' +
    '<div class="footer-brand-col">' +
    '<span class="site-logo"><span class="site-logo-icon">' + LOGO_SVG + '</span>' +
    '<span class="site-logo-word">PassExam<span class="site-logo-accent">HQ</span></span></span>' +
    '<p class="muted footer-brand-blurb">Independent, one-time-purchase prep for real licensing exams. Question banks built on the current official handbooks — no subscriptions, ever.</p>' +
    '</div>' +
    exverse + productCol + legalCol +
    '</div>' +
    '<div class="footer-legal-strip muted">' + window.location.hostname + ' is an independent study tool, not affiliated with, authorized by, sponsored by, or endorsed by ' + orgLine + ' or any other government agency. Practice questions only, and ' + requirement + ' — passing the real exam isn\'t guaranteed, though we back that risk with our <a href="#/guarantee">' + refundFailurePercent + '% refund guarantee</a>. © ' + SITE_YEAR + ' PassExamHQ. All rights reserved.</div>' +
    '</div>';
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

function renderTerms() {
  var pageTrack = activeTrackForPath(window.location.pathname);
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
    var refundRoute = (currentOrFirstActiveTrack() || {}).route || '/';
    var passRateNote = (stats && stats.passRate != null)
      ? '<div class="guarantee-stat-divider"></div><p class="guarantee-stat-label">Backed by real practice data</p>' +
        '<p class="muted guarantee-stat-note">' + stats.passRate + '% of practice mock exams taken on PassExamHQ end in a passing score.</p>'
      : '';

    appEl.innerHTML =
      '<div class="guarantee-page">' +
      '<section class="guarantee-hero">' +
      '<div class="guarantee-hero-copy">' +
      '<span class="badge guarantee-hero-badge">🛡️ Pass Guarantee</span>' +
      '<h1>Pass, or get ' + refundFailurePercent + '% back.</h1>' +
      '<p class="page-intro-text">We only sell prep we\'d stake our reputation on. Practice to the threshold, sit your ' +
      'official exam, and if you still don\'t pass, you get ' + refundFailurePercent + '% of your purchase back. Changed ' +
      'your mind early instead? A 7-day, no-questions-asked refund covers that too.</p>' +
      '<div class="guarantee-hero-cta">' +
      '<a class="btn-primary hub-hero-btn" href="/">Browse guaranteed tracks</a>' +
      '<a class="btn-secondary hub-hero-btn" href="' + refundRoute + '#/refund">I need to file a claim</a>' +
      '</div>' +
      '</div>' +
      '<div class="guarantee-stat-card">' +
      '<div class="guarantee-stat-icon">🛡️</div>' +
      '<div class="guarantee-stat-value">' + refundFailurePercent + '%</div>' +
      '<p class="muted">money back if you meet the practice requirement and still don\'t pass</p>' +
      passRateNote +
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

var HUB_EXAMS = [
  {
    examType: 'ca_notary', shortName: 'California Notary', stateCode: 'CA', examKind: 'Notary',
    title: 'California Notary Public Exam', category: 'State Licensing', active: true, route: '/notary',
    duration: '60 Minutes', questions: '45 Multiple Choice', passScore: '70% (Scaled Score 70+)',
    description: 'Practice questions covering the California notary handbook: statutory fees, thumbprint rules, journal requirements, and civil/criminal misconduct exposure.',
    breakdown: [['Fees, Misconduct & Conflict of Interest', '35%'], ['Common Questions & Scenarios', '20%'], ['Acknowledgment, Jurat & Journal', '30%'], ['Application, Commission & Misc', '15%']],
  },
  {
    examType: 'ca_driver', shortName: 'California Driver', stateCode: 'CA', examKind: 'Driver',
    title: 'California Driver Knowledge Test (Class C)', category: 'Driver & Vehicle Safety (DMV)', active: true, route: '/ca_driver',
    duration: 'Untimed', questions: '46 Multiple Choice', passScore: '38/46 Correct (~83%)',
    description: 'Practice questions covering the California Driver Handbook: right-of-way rules, signs and signals, safe driving practices, and DUI/financial responsibility laws for the Class C written permit test.',
    breakdown: [['Laws & Rules of the Road', '31%'], ['Navigating the Roads (Signs, Signals & Markings)', '25%'], ['Safe Driving, Alcohol & Drugs', '24%'], ['Licensing & Introduction to Driving', '20%']],
  },
  {
    examType: 'ca_cdl', shortName: 'California CDL', stateCode: 'CA', examKind: 'Commercial Driver (CDL)',
    title: 'California CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', active: true, route: '/cdl',
    duration: 'Untimed', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the California Commercial Driver Handbook: general knowledge, air brakes, combination vehicles, and endorsement topics for Class A/B commercial permits.',
    breakdown: [['General Knowledge (CDL Rules, Safe Driving & Cargo)', '33%'], ['Air Brakes & Combination Vehicles', '16%'], ['Passenger, School Bus, Tank & HazMat Endorsements', '34%'], ['Vehicle Inspection & Skills Testing', '17%']],
  },
  {
    examType: 'ca_motorcycle', shortName: 'California Motorcycle', stateCode: 'CA', examKind: 'Motorcycle',
    title: 'California Motorcycle Knowledge Test (M1/M2)', category: 'Driver & Vehicle Safety (DMV)', active: true, route: '/motorcycle',
    duration: 'Untimed', questions: '25 Multiple Choice', passScore: '20/25 Correct (80%)',
    description: 'Practice questions covering the California Motorcycle Handbook: safe riding techniques, hazard avoidance, licensing requirements, and DUI law for the M1/M2 written knowledge test.',
    breakdown: [['Basic Control, Lane Position & SEE Strategy', '24%'], ['Collision Avoidance, Hazards & Mechanical Problems', '22%'], ['License Requirements & Preparing to Ride', '28%'], ['Alcohol, DUI & Insurance Law', '26%']],
  },
  {
    examType: 'tx_driver', shortName: 'Texas Driver', stateCode: 'TX', examKind: 'Driver',
    title: 'Texas Driver License Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', active: true, route: '/tx_driver',
    duration: 'Untimed', questions: '30 Multiple Choice', passScore: '21/30 Correct (70%)',
    description: 'Practice questions covering the Texas Driver Handbook: licensing and application steps, right-of-way and vehicle equipment rules, traffic signs and signals, and alcohol/drug and crash-safety laws.',
    breakdown: [['Licensing, Application & Restrictions', '30%'], ['Vehicle Equipment & Right-of-Way Rules', '20%'], ['Traffic Signs, Signals & Special Situations', '26%'], ['Alcohol, Crashes & Pedestrian/Bicycle Safety', '24%']],
  },
  {
    examType: 'tx_cdl', shortName: 'Texas CDL', stateCode: 'TX', examKind: 'Commercial Driver (CDL)',
    title: 'Texas CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', active: true, route: '/tx_cdl',
    duration: 'Untimed', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Texas Commercial Motor Vehicle Driver Handbook: general knowledge, air brakes, combination vehicles, and endorsement topics for Class A/B commercial permits.',
    breakdown: [['Licensing & Vehicle Control Fundamentals', '27%'], ['Air Brakes & Combination Vehicles', '12%'], ['Cargo, Passenger, HazMat & Specialty Vehicles', '36%'], ['Adverse Conditions & Skills/Inspection Testing', '25%']],
  },
  {
    examType: 'fl_driver', shortName: 'Florida Driver', stateCode: 'FL', examKind: 'Driver',
    title: 'Florida Class E Knowledge Exam', category: 'Driver & Vehicle Safety (DMV)', active: true, route: '/fl_driver',
    duration: 'Untimed', questions: '50 Multiple Choice', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Florida Driver License Handbook: licensing and ID requirements, driver fitness, traffic controls, rules of the road, and insurance/DUI law for the Class E Knowledge Exam.',
    breakdown: [['Driver Licenses, IDs & Testing', '25%'], ['Driver Fitness & Traffic Controls', '28%'], ['Driving Safety, Rules of the Road & Special Situations', '34%'], ['Your Driving Privilege (Insurance, DUI, Points & Suspensions)', '13%']],
  },
  {
    examType: 'fl_cdl', shortName: 'Florida CDL', stateCode: 'FL', examKind: 'Commercial Driver (CDL)',
    title: 'Florida CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', active: true, route: '/fl_cdl',
    duration: 'Untimed', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Florida Commercial Driver License Handbook: general knowledge, air brakes, combination vehicles, and endorsement topics for Class A/B commercial permits.',
    breakdown: [['Licensing, Testing & CDL Rules', '18%'], ['Vehicle Control, Air Brakes & Combination Vehicles', '25%'], ['Hazardous Materials & Adverse Conditions/Emergencies', '39%'], ['Cargo, Passenger, School Bus & Specialty Vehicles', '18%']],
  },
  {
    examType: 'ny_driver', shortName: 'New York Driver', stateCode: 'NY', examKind: 'Driver',
    title: 'New York Driver License Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', active: true, route: '/ny_driver',
    duration: 'Untimed', questions: '20 Multiple Choice', passScore: '14/20 Correct (70%)',
    description: 'Practice questions covering the New York State Driver\'s Manual: licensing and learner permit rules, right-of-way and traffic control, passing/parking/defensive driving, and impairment and crash-reporting law for the Class D written knowledge test.',
    breakdown: [['Driver Licensing & Learner Permits', '17%'], ['License Sanctions, Vehicle Ownership & Right-of-Way', '27%'], ['Passing, Parking & Defensive Driving', '20%'], ['Impairment, Special Conditions & Sharing the Road', '36%']],
  },
  {
    examType: 'ny_cdl', shortName: 'New York CDL', stateCode: 'NY', examKind: 'Commercial Driver (CDL)',
    title: 'New York CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', active: true, route: '/ny_cdl',
    duration: 'Untimed', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the New York State Commercial Driver\'s Manual: general knowledge, air brakes, combination vehicles, and endorsement topics for Class A/B commercial permits.',
    breakdown: [['Licensing & Skills Testing Overview', '18%'], ['Vehicle Control, Air Brakes & Combination Vehicles', '30%'], ['Hazardous Materials & Adverse Conditions/Driver Fitness', '33%'], ['Cargo, Passenger, School Bus & Specialty Vehicles', '19%']],
  },
  {
    examType: 'ny_notary', shortName: 'New York Notary', stateCode: 'NY', examKind: 'Notary',
    title: 'New York Notary Public Exam', category: 'State Licensing', active: true, route: '/ny_notary',
    duration: '60 Minutes', questions: '40 Multiple Choice', passScore: '70% (28/40 Correct)',
    description: 'Practice questions covering the New York Notary Public License Law: appointment and professional conduct, powers and duties, statutory fees, real property acknowledgments, and the rules and regulations governing notaries.',
    breakdown: [['Appointment, Qualifications & Professional Conduct', '18%'], ['Powers, Duties, Fees & Electronic Notarization', '22%'], ['Rules & Regulations (19 NYCRR Part 182) and Definitions/Fees', '39%'], ['Real Property Law, Restrictions & Criminal Liability', '21%']],
  },
  {
    examType: 'il_driver', shortName: 'Illinois Driver', stateCode: 'IL', examKind: 'Driver',
    title: 'Illinois Driver License Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', active: true, route: '/il_driver',
    duration: 'Untimed', questions: '35 Multiple Choice', passScore: '28/35 Correct (80%)',
    description: 'Practice questions covering the Illinois Rules of the Road: licensing and exam procedures, roadway signs and signals, traffic laws, safe driving and vehicle ownership, sharing the road, and young-driver/DUI license sanctions for the Class D written knowledge test.',
    breakdown: [['Licensing & Exams', '17%'], ['Roadway Signs, Signals & Traffic Laws', '35%'], ['Safe Driving, Equipment & Vehicle Ownership', '17%'], ['Sharing the Road, Crash Procedures, Young Drivers & DUI', '31%']],
  },
  {
    examType: 'il_real_estate', shortName: 'Illinois Real Estate', stateCode: 'IL', examKind: 'Real Estate',
    title: 'Illinois Real Estate Broker Exam', category: 'Real Estate Licensing', active: true, route: '/il_real_estate',
    duration: '90 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '75% (30/40 Correct)',
    description: 'Practice questions covering the Illinois Real Estate License Act of 2000 (225 ILCS 454): licensing requirements, the License Act itself, additional Illinois laws affecting real estate practice, and required disclosures — the state-specific portion of the Broker exam.',
    breakdown: [['Licensing Requirements', '10%'], ['Illinois Real Estate License Act', '40%'], ['Additional Illinois Laws & Regulations', '25%'], ['Disclosures', '25%']],
  },
  {
    examType: 'il_managing_broker', shortName: 'Illinois Managing Broker', stateCode: 'IL', examKind: 'Real Estate',
    title: 'Illinois Managing Broker Exam', category: 'Real Estate Licensing', active: true, route: '/il_managing_broker',
    duration: '90 Minutes', questions: '50 Multiple Choice', passScore: '75% or Higher',
    description: 'Practice questions covering the Illinois Real Estate License Act of 2000 (225 ILCS 454) for the Managing Broker upgrade credential: brokerage administration and supervision, agency relationships, financing and calculations, disciplinary provisions, and escrow handling.',
    breakdown: [['Licensing Requirements & Disclosures', '15%'], ['Agency Relationships & Brokerage Practices', '18%'], ['Managing Broker Supervisory Duties, Financing & Calculations', '39%'], ['Disciplinary Provisions, Escrow & Additional IL Laws', '28%']],
  },
  {
    examType: 'pa_driver', shortName: 'Pennsylvania Driver', stateCode: 'PA', examKind: 'Driver',
    title: 'Pennsylvania Driver\'s License Knowledge Test', category: 'Driver & Vehicle Safety (DMV)', active: true, route: '/pa_driver',
    duration: 'Untimed', questions: '18 Multiple Choice', passScore: '15/18 Correct (83.3%)',
    description: 'Practice questions covering the Pennsylvania Driver\'s Manual (PennDOT, PUB 95): licensing and permit basics, traffic signals/signs/pavement markings, everyday driving skills, special circumstances and emergencies, driving record and DUI law, and related safety laws for the non-commercial written knowledge test.',
    breakdown: [['Introduction, Learner\'s Permit & Driving Record', '20%'], ['Signals, Signs & Pavement Markings', '20%'], ['Everyday Driving Skills', '28%'], ['Special Circumstances, Emergencies & Related Laws', '32%']],
  },
  {
    examType: 'pa_cdl', shortName: 'Pennsylvania CDL', stateCode: 'PA', examKind: 'Commercial Driver (CDL)',
    title: 'Pennsylvania CDL (Commercial Driver\'s License) Exam & Endorsements', category: 'Driver & Vehicle Safety (DMV)', active: true, route: '/pa_cdl',
    duration: 'Untimed', questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)',
    description: 'Practice questions covering the Pennsylvania Commercial Driver\'s Manual (PennDOT, PUB223): general knowledge, cargo and passenger safety, vehicle control and hazard awareness, adverse conditions and emergencies, air brakes and combination vehicles, hazardous materials, and skills/road testing for Class A/B/C commercial permits.',
    breakdown: [['General Knowledge, Cargo & Passenger Safety', '16%'], ['Vehicle Control, Air Brakes & Combination Vehicles', '36%'], ['Hazardous Materials & Adverse Conditions/Emergencies', '32%'], ['Skills & Road Testing', '16%']],
  },
  {
    examType: 'pa_real_estate', shortName: 'Pennsylvania Real Estate', stateCode: 'PA', examKind: 'Real Estate',
    title: 'Pennsylvania Real Estate Salesperson Exam', category: 'Real Estate Licensing', active: true, route: '/pa_real_estate',
    duration: '60 Minutes', questions: '40 Multiple Choice (State-Specific Portion)', passScore: '75% (30/40 Correct)',
    description: 'Practice questions covering 49 Pa. Code Chapter 35 (State Real Estate Commission regulations): the Real Estate Commission, licensure, agency and disclosure, regulations governing licensee activities, and miscellaneous topics — the state-specific portion of the Salesperson exam.',
    breakdown: [['Real Estate Commission & Licensure', '33%'], ['Agency and Disclosure', '25%'], ['Regulations Governing the Activities of Licensees', '27%'], ['Miscellaneous', '15%']],
  },
  {
    examType: 'ca_dre', shortName: 'California DRE', stateCode: 'CA', examKind: 'Real Estate',
    title: 'California DRE Real Estate Salesperson Exam', category: 'Real Estate Licensing', active: true, route: '/ca_dre',
    duration: '3 Hours 15 Minutes', questions: '150 Multiple Choice', passScore: '70% (105/150 Correct)',
    description: 'Practice questions covering the California Real Estate Law (Business and Professions Code, Division 4), scoped to DRE\'s own official RE 425 exam content outline: property ownership and land use, agency and fiduciary duties, valuation, financing, transfer of property, practice/disclosures, and contracts.',
    breakdown: [['Property Ownership & Land Use Controls', '15%'], ['Agency & Fiduciary Duties', '17%'], ['Valuation, Financing & Transfer of Property', '31%'], ['Practice of Real Estate, Disclosures & Contracts', '37%']],
  },
  {
    examType: 'mlo', shortName: 'National MLO', stateCode: 'US', examKind: 'Mortgage Loan Origination',
    title: 'NMLS SAFE National MLO Exam', category: 'Mortgage Loan Origination', active: false, route: '#',
    duration: '190 Minutes', questions: '125 Questions (115 Scored)', passScore: '75%',
    description: 'The NMLS National Test Component: federal lending regulations, origination activities, and ethics.',
    breakdown: [['Origination Activities', '27%'], ['Federal Laws & Rules', '24%'], ['General Mortgage Knowledge', '20%'], ['Ethics & Fair Lending', '18%']],
  },
];

// Display name for each HUB_EXAMS stateCode -- 'US' covers genuinely national (non-state-specific)
// tracks like MLO, shown as its own filter option rather than lumped into "All" invisibly. Add an
// entry here whenever a new state's first track is added (e.g. TX, FL, NY).
var STATE_LABELS = { CA: 'California', TX: 'Texas', FL: 'Florida', NY: 'New York', IL: 'Illinois', PA: 'Pennsylvania', US: 'National' };

// Given a hub route string ('/notary', etc.), returns the matching ACTIVE track's HUB_EXAMS entry,
// or null. Inactive tracks use route:'#' (shared/non-unique) so they're deliberately excluded --
// only an active track can ever be matched to a real page.
function activeTrackForPath(pathname) {
  var matches = HUB_EXAMS.filter(function (e) { return e.active && e.route !== '#' && pathname.indexOf(e.route) === 0; });
  return matches.length ? matches[0] : null;
}
// The single active track, used as a fallback wherever a track needs to be assumed before the
// router has matched a specific one (e.g. the hub page's own footer/CTA links).
function firstActiveTrack() {
  var matches = HUB_EXAMS.filter(function (e) { return e.active; });
  return matches.length ? matches[0] : null;
}
// exam_type naming convention: {state}_{category}, e.g. tx_driver, fl_notary -- national
// (non-state-specific) exams like the NMLS MLO stay unprefixed.
function trackByExamType(examType) {
  var matches = HUB_EXAMS.filter(function (e) { return e.examType === examType; });
  return matches.length ? matches[0] : null;
}

// Per-track compliance/legal copy -- deliberately NOT auto-genericized from one template, since the
// underlying facts differ per track (who administers the real exam, what education/training
// requirement exists, if any). Add a real entry here before flipping a new track to active:true.
var TRACK_COMPLIANCE = {
  ca_notary: {
    orgLine: 'the California Secretary of State, CPS HR Consulting,',
    footerRequirement: "do not fulfill California's mandatory notary education requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy California\'s state-mandated 6-hour ' +
      '(or 3-hour refresher) notary public education requirement under Government Code § 8201, and does not issue an official ' +
      'Proof of Completion certificate — our content is a supplementary study aid only. Completing practice exams here also does ' +
      'not register you for, or schedule, the official proctored California Notary Public Examination; official exam scheduling ' +
      'and candidate registration must be conducted through the California Secretary of State and its designated exam vendor, ' +
      'CPS HR Consulting. While we strive to align our content with current California notary laws, handbook guidance, and ' +
      'statutory regulations, it is provided "as-is" for self-study and does not constitute legal advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real proctored exam or California\'s mandatory notary education requirement.',
    passScoreNote: 'a practice approximation of the real scaled-score-70 requirement',
  },
  ca_driver: {
    orgLine: 'the California Department of Motor Vehicles (DMV)',
    footerRequirement: "do not fulfill any California driver education or behind-the-wheel training requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy any California driver ' +
      'education or behind-the-wheel training requirement, and does not issue any official course-completion certificate — our ' +
      'content is a supplementary study aid only. Completing practice exams here also does not register you for, or schedule, the ' +
      'official DMV written knowledge test; official testing must be scheduled directly through the California Department of Motor ' +
      'Vehicles. While we strive to align our content with the current California Driver Handbook, it is provided "as-is" for ' +
      'self-study and does not constitute legal or driving-instruction advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real DMV written knowledge test or any required driver education course.',
    passScoreNote: 'the same threshold as the real DMV test — 38 of 46 correct',
  },
  ca_cdl: {
    orgLine: 'the California Department of Motor Vehicles (DMV) or the Federal Motor Carrier Safety Administration (FMCSA)',
    footerRequirement: "do not fulfill the FMCSA Entry-Level Driver Training (ELDT) requirement or any California CDL/endorsement training requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the federal Entry-Level Driver ' +
      'Training (ELDT) requirement or any California CDL/endorsement training requirement, and does not issue any official ' +
      'course-completion certificate — our content is a supplementary study aid only. Completing practice exams here also does not ' +
      'register you for, or schedule, the official DMV CDL knowledge test, skills test, or road test; official testing must be ' +
      'scheduled directly through the California Department of Motor Vehicles, and ELDT must be completed through an FMCSA-registered ' +
      'training provider. While we strive to align our content with the current California Commercial Driver Handbook, it is provided ' +
      '"as-is" for self-study and does not constitute legal or driving-instruction advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real DMV CDL knowledge, skills, or road test, or any required Entry-Level Driver Training (ELDT).',
    passScoreNote: 'the same threshold as the real DMV CDL General Knowledge test — 40 of 50 correct',
  },
  ca_motorcycle: {
    orgLine: 'the California Department of Motor Vehicles (DMV) or the California Motorcyclist Safety Program (CMSP)',
    footerRequirement: "do not fulfill the CMSP training course requirement (mandatory for riders under 21) or any other license training requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the California Motorcyclist ' +
      'Safety Program (CMSP) training course requirement — mandatory for riders under 21, and a common way to satisfy the skills-test ' +
      'requirement for riders of any age — and does not issue any official course-completion certificate — our content is a ' +
      'supplementary study aid only. Completing practice exams here also does not register you for, or schedule, the official DMV ' +
      'M1/M2 written knowledge test or skills test; official testing must be scheduled directly through the California Department of ' +
      'Motor Vehicles, and CMSP courses must be scheduled through an approved CMSP provider. While we strive to align our content with ' +
      'the current California Motorcycle Handbook, it is provided "as-is" for self-study and does not constitute legal or ' +
      'riding-instruction advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real DMV M1/M2 written knowledge test, skills test, or any required California Motorcyclist Safety Program (CMSP) training course.',
    passScoreNote: 'the same threshold as the real DMV M1/M2 test — 20 of 25 correct',
  },
  tx_driver: {
    orgLine: 'the Texas Department of Public Safety (DPS)',
    footerRequirement: "do not fulfill the Texas driver education course requirement (mandatory for first-time applicants under 25) or any behind-the-wheel training requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the Texas driver education ' +
      'course requirement — mandatory for first-time applicants under 25 (teens 14-17 complete the Graduated Driver License program; ' +
      'adults 18-24 complete a 6-hour adult driver education course) — and does not issue any official course-completion certificate ' +
      '— our content is a supplementary study aid only. Completing practice exams here also does not register you for, or schedule, ' +
      'the official DPS written knowledge test; official testing must be scheduled directly through the Texas Department of Public ' +
      'Safety, and driver education must be completed through a TDLR-approved provider. While we strive to align our content with the ' +
      'current Texas Driver Handbook, it is provided "as-is" for self-study and does not constitute legal or driving-instruction ' +
      'advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real DPS written knowledge test or any required Texas driver education course.',
    passScoreNote: 'the same threshold as the real DPS test — 21 of 30 correct',
  },
  tx_cdl: {
    orgLine: 'the Texas Department of Public Safety (DPS) or the Federal Motor Carrier Safety Administration (FMCSA)',
    footerRequirement: "do not fulfill the FMCSA Entry-Level Driver Training (ELDT) requirement or any Texas CDL/endorsement training requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the federal Entry-Level Driver ' +
      'Training (ELDT) requirement or any Texas CDL/endorsement training requirement, and does not issue any official ' +
      'course-completion certificate — our content is a supplementary study aid only. Completing practice exams here also does not ' +
      'register you for, or schedule, the official DPS CDL knowledge test, skills test, or road test; official testing must be ' +
      'scheduled directly through the Texas Department of Public Safety, and ELDT must be completed through an FMCSA-registered ' +
      'training provider. While we strive to align our content with the current Texas Commercial Motor Vehicle Driver Handbook, it is ' +
      'provided "as-is" for self-study and does not constitute legal or driving-instruction advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real DPS CDL knowledge, skills, or road test, or any required Entry-Level Driver Training (ELDT).',
    passScoreNote: 'the same threshold as the real DPS CDL General Knowledge test — 40 of 50 correct',
  },
  fl_driver: {
    orgLine: 'the Florida Department of Highway Safety and Motor Vehicles (FLHSMV)',
    footerRequirement: "do not fulfill the Traffic Law and Substance Abuse Education (TLSAE) or Driver Education Traffic Safety (DETS) course requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the Traffic Law and ' +
      'Substance Abuse Education (TLSAE) course requirement — mandatory for first-time applicants age 18 and older — or the Driver ' +
      'Education Traffic Safety (DETS) course required instead for first-time applicants ages 15-17 — and does not issue any official ' +
      'course-completion certificate — our content is a supplementary study aid only. Completing practice exams here also does not ' +
      'register you for, or schedule, the official Class E Knowledge Exam; official testing must be scheduled directly through the ' +
      'Florida Department of Highway Safety and Motor Vehicles, and TLSAE/DETS must be completed through an FLHSMV-approved provider. ' +
      'While we strive to align our content with the current Florida Driver License Handbook, it is provided "as-is" for self-study ' +
      'and does not constitute legal or driving-instruction advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real FLHSMV Class E Knowledge Exam or any required TLSAE/DETS driver education course.',
    passScoreNote: 'the same threshold as the real FLHSMV Class E Knowledge Exam — 40 of 50 correct',
  },
  fl_cdl: {
    orgLine: 'the Florida Department of Highway Safety and Motor Vehicles (FLHSMV) or the Federal Motor Carrier Safety Administration (FMCSA)',
    footerRequirement: "do not fulfill the FMCSA Entry-Level Driver Training (ELDT) requirement or any Florida CDL/endorsement training requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the federal Entry-Level Driver ' +
      'Training (ELDT) requirement or any Florida CDL/endorsement training requirement, and does not issue any official ' +
      'course-completion certificate — our content is a supplementary study aid only. Completing practice exams here also does not ' +
      'register you for, or schedule, the official FLHSMV CDL knowledge test, skills test, or road test; official testing must be ' +
      'scheduled directly through the Florida Department of Highway Safety and Motor Vehicles, and ELDT must be completed through an ' +
      'FMCSA-registered training provider. While we strive to align our content with the current Florida CDL Handbook, it is provided ' +
      '"as-is" for self-study and does not constitute legal or driving-instruction advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real FLHSMV CDL knowledge, skills, or road test, or any required Entry-Level Driver Training (ELDT).',
    passScoreNote: 'the same threshold as the real FLHSMV CDL General Knowledge test — 40 of 50 correct',
  },
  ny_driver: {
    orgLine: 'the New York State Department of Motor Vehicles (DMV)',
    footerRequirement: "do not fulfill the New York 5-Hour Pre-Licensing Course requirement (mandatory before the road test) or the Driver Education program alternative",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the New York 5-Hour ' +
      'Pre-Licensing Course requirement — mandatory before scheduling the road test — or the alternative Driver Education program, ' +
      'and does not issue any official course-completion certificate — our content is a supplementary study aid only. Completing ' +
      'practice exams here also does not register you for, or schedule, the official DMV written knowledge test; official testing ' +
      'must be scheduled directly through the New York State DMV, and the 5-Hour Course must be completed through a DMV-approved ' +
      'provider. While we strive to align our content with the current New York State Driver\'s Manual, it is provided "as-is" for ' +
      'self-study and does not constitute legal or driving-instruction advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real DMV written knowledge test or any required 5-Hour Pre-Licensing Course.',
    passScoreNote: 'the same threshold as the real DMV test — 14 of 20 correct',
  },
  ny_cdl: {
    orgLine: 'the New York State Department of Motor Vehicles (DMV) or the Federal Motor Carrier Safety Administration (FMCSA)',
    footerRequirement: "do not fulfill the FMCSA Entry-Level Driver Training (ELDT) requirement or any New York CDL/endorsement training requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the federal Entry-Level Driver ' +
      'Training (ELDT) requirement or any New York CDL/endorsement training requirement, and does not issue any official ' +
      'course-completion certificate — our content is a supplementary study aid only. Completing practice exams here also does not ' +
      'register you for, or schedule, the official DMV CDL knowledge test, skills test, or road test; official testing must be ' +
      'scheduled directly through the New York State DMV, and ELDT must be completed through an FMCSA-registered training provider. ' +
      'While we strive to align our content with the current New York State Commercial Driver\'s Manual, it is provided "as-is" for ' +
      'self-study and does not constitute legal or driving-instruction advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real DMV CDL knowledge, skills, or road test, or any required Entry-Level Driver Training (ELDT).',
    passScoreNote: 'the same threshold as the real DMV CDL General Knowledge test — 40 of 50 correct',
  },
  ny_notary: {
    orgLine: 'the New York Department of State',
    footerRequirement: "do not register you for, or substitute for, the official New York notary public exam or commission application",
    termsParagraph2: '<p class="muted">New York does not require a mandatory education course before the notary exam — unlike some ' +
      'other states, candidates are expected to study the Notary Public License Law independently. Using this site\'s practice ' +
      'questions or mock exams does not register you for, or schedule, the official Department of State notary exam, and does not ' +
      'substitute for, or guarantee results on, your notary commission application — our content is a supplementary study aid only. ' +
      'Official exam scheduling and commission applications must be conducted through the New York Department of State. While we ' +
      'strive to align our content with the current Notary Public License Law booklet, it is provided "as-is" for self-study and ' +
      'does not constitute legal advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real Department of State notary exam or notary commission application.',
    passScoreNote: 'the same threshold as the real Department of State exam — 28 of 40 correct',
  },
  il_driver: {
    orgLine: 'the Illinois Secretary of State',
    footerRequirement: "do not fulfill the Illinois driver education course requirement (mandatory under age 18, or for first-time applicants ages 18-20) or any behind-the-wheel training requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the Illinois driver ' +
      'education course requirement — a state-approved course (30 classroom + 6 behind-the-wheel hours) for applicants under 18, or ' +
      'a six-hour Adult Driver Education Course for first-time applicants ages 18-20 who never completed one — and does not issue ' +
      'any official course-completion certificate — our content is a supplementary study aid only. Completing practice exams here ' +
      'also does not register you for, or schedule, the official Secretary of State written knowledge test; official testing must ' +
      'be scheduled directly through the Illinois Secretary of State, and driver education must be completed through a ' +
      'state-certified provider. While we strive to align our content with the current Illinois Rules of the Road, it is provided ' +
      '"as-is" for self-study and does not constitute legal or driving-instruction advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real Secretary of State written knowledge test or any required Illinois driver education course.',
    passScoreNote: 'the same threshold as the real Secretary of State test — 28 of 35 correct',
  },
  il_real_estate: {
    orgLine: 'the Illinois Department of Financial and Professional Regulation (IDFPR)',
    footerRequirement: "do not fulfill the 75-hour pre-license education requirement or any Illinois real estate broker training requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the 75-hour pre-license ' +
      'education requirement for an Illinois broker license (15 hours of which must be situational/case-study instruction), and does ' +
      'not issue any official course-completion certificate — our content is a supplementary study aid only, and covers only the ' +
      'state-specific portion of the exam, not the separate national/general portion. Completing practice exams here also does not ' +
      'register you for, or schedule, the official licensing exam; official testing is administered by PSI on behalf of IDFPR, and ' +
      'pre-license education must be completed through an IDFPR-approved provider. While we strive to align our content with the ' +
      'current Real Estate License Act of 2000 (225 ILCS 454), it is provided "as-is" for self-study and does not constitute legal ' +
      'advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real IDFPR broker exam or the required 75-hour pre-license education.',
    passScoreNote: 'the same threshold as the real state-specific portion — 30 of 40 correct',
  },
  il_managing_broker: {
    orgLine: 'the Illinois Department of Financial and Professional Regulation (IDFPR)',
    footerRequirement: "do not fulfill the 45 additional hours of managing-broker-specific education required on top of an active broker license, or any other Illinois managing broker training requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the education ' +
      'requirements for an Illinois managing broker license — at least 165 total hours, including 45 additional hours of brokerage ' +
      'administration/management education completed within the year before applying, on top of already holding an active Illinois ' +
      'broker license for at least 2 of the preceding 3 years — and does not issue any official course-completion certificate — our ' +
      'content is a supplementary study aid only. Completing practice exams here also does not register you for, or schedule, the ' +
      'official licensing exam; official testing is administered by PSI on behalf of IDFPR, and education must be completed through ' +
      'an IDFPR-approved provider. While we strive to align our content with the current Real Estate License Act of 2000 (225 ILCS ' +
      '454), it is provided "as-is" for self-study and does not constitute legal advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real IDFPR managing broker exam or the required managing-broker education hours.',
    passScoreNote: 'the same threshold as the real state-specific IDFPR exam — 75% or higher',
  },
  pa_driver: {
    orgLine: 'the Pennsylvania Department of Transportation (PennDOT)',
    footerRequirement: "do not fulfill the driver training course requirement (approved by the PA Department of Education, needed to upgrade from a junior to a regular license before age 18) or any other driver education requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the Pennsylvania driver ' +
      'training course requirement — approved by the PA Department of Education, one of the conditions to upgrade from a junior ' +
      'driver\'s license to a regular license before age 18 — and does not issue any official course-completion certificate — our ' +
      'content is a supplementary study aid only. Completing practice exams here also does not register you for, or schedule, the ' +
      'official PennDOT written knowledge test; official testing must be scheduled directly through the Pennsylvania Department of ' +
      'Transportation, and driver training must be completed through an approved provider. While we strive to align our content with ' +
      'the current Pennsylvania Driver\'s Manual, it is provided "as-is" for self-study and does not constitute legal or ' +
      'driving-instruction advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real PennDOT written knowledge test or any required driver training course.',
    passScoreNote: 'the same threshold as the real PennDOT test — 15 of 18 correct',
  },
  pa_cdl: {
    orgLine: 'the Pennsylvania Department of Transportation (PennDOT) or the Federal Motor Carrier Safety Administration (FMCSA)',
    footerRequirement: "do not fulfill the FMCSA Entry-Level Driver Training (ELDT) requirement or any Pennsylvania CDL/endorsement training requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the federal Entry-Level Driver ' +
      'Training (ELDT) requirement or any Pennsylvania CDL/endorsement training requirement, and does not issue any official ' +
      'course-completion certificate — our content is a supplementary study aid only. Completing practice exams here also does not ' +
      'register you for, or schedule, the official PennDOT CDL knowledge test, skills test, or road test; official testing must be ' +
      'scheduled directly through the Pennsylvania Department of Transportation, and ELDT must be completed through an ' +
      'FMCSA-registered training provider. While we strive to align our content with the current Pennsylvania Commercial Driver\'s ' +
      'Manual, it is provided "as-is" for self-study and does not constitute legal or driving-instruction advice or a guaranteed exam ' +
      'outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real PennDOT CDL knowledge, skills, or road test, or any required Entry-Level Driver Training (ELDT).',
    passScoreNote: 'the same threshold required by federal law for every state\'s CDL General Knowledge test — 40 of 50 correct',
  },
  pa_real_estate: {
    orgLine: 'the Pennsylvania Real Estate Commission (PA Department of State)',
    footerRequirement: "do not fulfill the 240-hour pre-license education requirement or any Pennsylvania real estate salesperson training requirement",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the 240-hour (16-credit) ' +
      'real estate pre-license education requirement, and does not issue any official course-completion certificate — our content is ' +
      'a supplementary study aid only, and covers only the state-specific portion of the exam, not the separate national/general ' +
      'portion. Completing practice exams here also does not register you for, or schedule, the official licensing exam; official ' +
      'testing is administered by Pearson VUE on behalf of the Real Estate Commission, and pre-license education must be completed ' +
      'through a Commission-approved provider. While we strive to align our content with 49 Pa. Code Chapter 35 (State Real Estate ' +
      'Commission regulations), it is provided "as-is" for self-study and does not constitute legal advice or a guaranteed exam ' +
      'outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real Real Estate Commission exam or the required 240-hour pre-license education.',
    passScoreNote: 'the same threshold as the real state-specific portion — 30 of 40 correct',
  },
  ca_dre: {
    orgLine: 'the California Department of Real Estate (DRE)',
    footerRequirement: "do not fulfill the three-course college-level education requirement (Real Estate Principles, Real Estate Practice, and one approved elective) required before the exam",
    termsParagraph2: '<p class="muted">Using this site\'s practice questions or mock exams does not satisfy the pre-license education ' +
      'requirement for a California real estate salesperson license — three college-level courses (Real Estate Principles, Real ' +
      'Estate Practice, and one approved elective), each a 3-semester-unit course completed at an accredited institution — and does ' +
      'not issue any official course-completion certificate — our content is a supplementary study aid only. Completing practice ' +
      'exams here also does not register you for, or schedule, the official licensing exam; official testing is administered ' +
      'directly by the California Department of Real Estate (not outsourced to a testing vendor), and pre-license courses must be ' +
      'completed through an accredited institution or DRE-approved provider. While we strive to align our content with the current ' +
      'California Real Estate Law (Business and Professions Code, Division 4), it is provided "as-is" for self-study and does not ' +
      'constitute legal advice or a guaranteed exam outcome.</p>',
    examIntroDisclaimer: 'register you for, or count toward, the real DRE Salesperson exam or the required pre-license education courses.',
    passScoreNote: 'the same threshold as the real DRE exam — 105 of 150 correct',
  },
};
function trackCompliance(examType) {
  return TRACK_COMPLIANCE[examType] || TRACK_COMPLIANCE.ca_notary;
}
// Resolves to whichever active track we're currently inside (state.examType, set by the router on
// a track page), or the single active track as a sensible fallback for chrome rendered on the hub
// itself (e.g. the footer), where no specific track is in context yet.
function currentOrFirstActiveTrack() {
  var current = trackByExamType(state.examType);
  return (current && current.active) ? current : firstActiveTrack();
}

var HUB_TRACKS_COLLAPSED_COUNT = 4;
var hubTracksExpanded = false;
var hubStateFilter = ''; // '' = All states; otherwise a STATE_LABELS key (e.g. 'CA')
var hubKindFilter = ''; // '' = All exam kinds; otherwise a HUB_EXAMS examKind value (e.g. 'Driver')

// A track matches the current filter pair if it satisfies whichever of state/kind is active --
// the two filters combine (AND), not just one at a time.
function hubExamMatchesFilters(e, stateFilter, kindFilter) {
  return (!stateFilter || e.stateCode === stateFilter) && (!kindFilter || e.examKind === kindFilter);
}

// One pill per distinct stateCode present in HUB_EXAMS, plus "All" -- same pattern as the quiz
// difficulty picker (renderQuizDifficultyPicker). A single-state catalog (today: CA + National)
// still renders fine, just with 2-3 pills; this is prep for once TX/FL/NY tracks exist, not
// something that needs a minimum track count to make sense. Counts respect the current kind
// filter too, so a pill never claims more tracks than would actually show once clicked.
function renderHubStateFilterPills() {
  var codes = [];
  HUB_EXAMS.forEach(function (e) { if (codes.indexOf(e.stateCode) === -1) codes.push(e.stateCode); });
  codes.sort(function (a, b) { return (STATE_LABELS[a] || a).localeCompare(STATE_LABELS[b] || b); });
  var allCount = HUB_EXAMS.filter(function (e) { return hubExamMatchesFilters(e, '', hubKindFilter); }).length;
  var options = [['', 'All States (' + allCount + ')']].concat(codes.map(function (c) {
    var count = HUB_EXAMS.filter(function (e) { return hubExamMatchesFilters(e, c, hubKindFilter); }).length;
    return [c, (STATE_LABELS[c] || c) + ' (' + count + ')'];
  }));
  if (options.length <= 2) return ''; // nothing to filter yet (e.g. only one state so far)
  return '<div class="hub-state-filter-pill" role="group" aria-label="Filter by state">' +
    options.map(function (o) {
      var active = hubStateFilter === o[0];
      return '<button type="button" class="' + (active ? 'active' : '') + '" data-act="filter-hub-state" data-state="' + o[0] + '"' +
        (active ? ' aria-current="true"' : '') + '>' + o[1] + '</button>';
    }).join('') + '</div>';
}

// Same pattern as renderHubStateFilterPills, filtering by examKind (Driver, Commercial Driver
// (CDL), Motorcycle, Notary, etc.) instead of state -- counts respect the current state filter too.
function renderHubKindFilterPills() {
  var kinds = [];
  HUB_EXAMS.forEach(function (e) { if (kinds.indexOf(e.examKind) === -1) kinds.push(e.examKind); });
  kinds.sort(function (a, b) { return a.localeCompare(b); });
  var allCount = HUB_EXAMS.filter(function (e) { return hubExamMatchesFilters(e, hubStateFilter, ''); }).length;
  var options = [['', 'All Types (' + allCount + ')']].concat(kinds.map(function (k) {
    var count = HUB_EXAMS.filter(function (e) { return hubExamMatchesFilters(e, hubStateFilter, k); }).length;
    return [k, k + ' (' + count + ')'];
  }));
  if (options.length <= 2) return ''; // nothing to filter yet
  return '<div class="hub-state-filter-pill" role="group" aria-label="Filter by exam type">' +
    options.map(function (o) {
      var active = hubKindFilter === o[0];
      return '<button type="button" class="' + (active ? 'active' : '') + '" data-act="filter-hub-kind" data-kind="' + o[0] + '"' +
        (active ? ' aria-current="true"' : '') + '>' + o[1] + '</button>';
    }).join('') + '</div>';
}

function hubTracksGridHtml() {
  var filtered = HUB_EXAMS.filter(function (e) { return hubExamMatchesFilters(e, hubStateFilter, hubKindFilter); });
  var cardsArr = hubTrackCards(filtered);
  var truncated = !hubTracksExpanded && cardsArr.length > HUB_TRACKS_COLLAPSED_COUNT;
  var visible = truncated ? cardsArr.slice(0, HUB_TRACKS_COLLAPSED_COUNT) : cardsArr;
  var toggleHtml = cardsArr.length > HUB_TRACKS_COLLAPSED_COUNT
    ? '<div class="hub-tracks-toggle-wrap"><button class="btn-secondary btn-sm" type="button" data-act="toggle-hub-tracks">' +
      (truncated ? 'Show all ' + cardsArr.length + ' tracks ▾' : 'Show fewer ▴') + '</button></div>'
    : '';
  var emptyHtml = !cardsArr.length ? '<p class="muted">No tracks yet for this filter.</p>' : '';
  // Kicked off here (not awaited) so every caller that re-renders this grid (initial hub render,
  // the state/kind filter handlers, the show-all toggle) gets pricing filled in for free, without
  // each one needing to remember to call it separately. Safe regardless of caller: this function
  // returns its HTML string (and gets assigned to innerHTML) synchronously, before any of these
  // fetches can resolve.
  fillHubPricing(truncated ? filtered.slice(0, HUB_TRACKS_COLLAPSED_COUNT) : filtered);
  return '<div class="exam-track-grid">' + visible.join('') + '</div>' + emptyHtml + toggleHtml;
}

// Smaller catalog card (Round 2 redesign decision): category/name/state/price/CTA only -- full
// stats, breakdown, and buy details now live on the track's own page instead of duplicating them
// here, since every track now has a real detail surface to click through to.
function hubTrackCards(tracks) {
  return (tracks || HUB_EXAMS).map(function (exam) {
    var statusBadge = exam.active
      ? '<span class="status-badge active"><span class="pulse-dot"></span>Active</span>'
      : '<span class="status-badge">Coming Soon</span>';
    var priceHtml = exam.active
      ? '<span class="exam-track-price" data-price-for="' + exam.examType + '">…</span>'
      : '<span class="exam-track-price muted">—</span>';
    var body = '<div class="exam-track-body">' +
      '<div class="exam-track-top"><span class="badge">' + exam.category + '</span>' + statusBadge + '</div>' +
      '<h3>' + escapeHtml(exam.shortName || exam.title) + '</h3>' +
      '<div class="exam-track-state muted">' + escapeHtml(STATE_LABELS[exam.stateCode] || exam.stateCode) + '</div>' +
      priceHtml +
      '</div><div class="exam-track-footer">' +
      (exam.active ? '<span class="exam-track-view-link">View details →</span>' : '<span class="muted exam-track-view-link">Coming soon</span>') +
      '</div>';
    return exam.active
      ? '<a class="exam-track-card is-active" href="' + exam.route + '">' + body + '</a>'
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

function renderHub() {
  var activeCount = HUB_EXAMS.filter(function (e) { return e.active; }).length;
  var upcomingCount = HUB_EXAMS.length - activeCount;
  var heroTrackRoute = (firstActiveTrack() || {}).route || '/';

  appEl.innerHTML =
    renderNewsBanner() +
    '<div id="home-promotions-wrap" class="promotions-wrap"></div>' +
    '<div class="hub-hero">' +
    '<h1>Pass Your Licensing Exams on the First Try</h1>' +
    '<p>Practice question sets modeled after official state and national licensing standards, with ' +
    'voice-enabled practice and instant online access.</p>' +
    '<div class="hub-trust-badges">' +
    '<span class="hub-trust-badge">✓ 2026 Handbook Aligned</span>' +
    '<span class="hub-trust-badge">✓ Voice-Enabled Practice</span>' +
    '<span class="hub-trust-badge">✓ Instant Access</span>' +
    '</div>' +
    '<div class="hub-hero-cta">' +
    '<a class="btn-primary hub-hero-btn" href="' + heroTrackRoute + '#/sample">Try Free Sample</a>' +
    '<button class="btn-secondary hub-hero-btn" type="button" data-act="scroll-to-tracks">Browse All Tracks</button>' +
    '</div>' +
    '<p class="muted hub-hero-subtext">Already have a code? <a href="' + heroTrackRoute + '">Enter it here</a></p>' +
    '<p class="muted hub-hero-subtext">No code yet? <a href="' + heroTrackRoute + '#/buy">Buy instant access</a> or <a href="' + heroTrackRoute + '#/refer">refer friends for free access</a></p>' +
    '</div>' +
    trustStripHtml() +
    howItWorksHtml() +
    '<div class="hub-section-header" id="tracks"><h2>Licensing Tracks</h2>' +
    '<span class="badge">' + activeCount + ' Active • ' + upcomingCount + ' Upcoming</span></div>' +
    '<div id="hub-state-filter-wrap">' + renderHubStateFilterPills() + '</div>' +
    '<div id="hub-kind-filter-wrap">' + renderHubKindFilterPills() + '</div>' +
    '<div id="hub-tracks-grid-wrap">' + hubTracksGridHtml() + '</div>' +
    comparisonTableHtml() +
    outcomesStripHtml() +
    guaranteeCtaBandHtml();

  // Rendered above synchronously so the page itself never waits on this -- promos fill in a
  // moment later once fetched, same "progressive enhancement" idea as the admin Stats page's
  // accuracy table.
  Promise.all([apiFetch('/promotions?placement=home'), loadSiteConfig()]).then(function (results) {
    var r = results[0];
    var wrap = document.getElementById('home-promotions-wrap');
    if (wrap) wrap.innerHTML = promoBannersHtml(r.promotions || [], true, false);
  }).catch(function () { /* best-effort -- a promo banner failing to load shouldn't break the hub page */ });
  fillOutcomesStrip();
  // The guarantee band renders synchronously with whatever refundFailurePercent already holds
  // (the pre-fetch default until some earlier page has loaded real config) -- patches itself once
  // the real value is in, rather than a second fetch just for this.
  loadSiteConfig().then(function () {
    document.querySelectorAll('.js-refund-pct').forEach(function (el) { el.textContent = refundFailurePercent; });
  });
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

// refundFailurePercent shows its pre-fetch default (50) at first paint here, then gets patched by
// the .js-refund-pct sweep in renderHub() once real config loads -- see the comment there.
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
// difficulty-filtered practice, timed exam mode, per-topic progress, guarantee). DMV Genie's
// checkmarks were verified against its current App Store/Play Store listings before this shipped
// (Aug 2026) -- re-verify before reusing this table later, app feature sets drift over time.
// "Free Practice Sites" is a generic category, not one named product, so its marks describe the
// category rather than claim something about any specific site -- 'varies' where free sites
// commonly differ rather than a flat yes/no.
var COMPARISON_FEATURES = [
  // [feature, "Free Practice Sites", "DMV Genie", "PassExamHQ"]
  ['State-specific, 2026-current content', 'varies', true, true],
  ['Unlimited practice questions', true, true, true],
  ['Full timed mock exam simulator', 'varies', true, true],
  ['Voice-enabled answering & read-aloud', false, false, true],
  ['Weak-topic progress tracking', false, true, true],
  ['Explanation on every question', 'varies', true, true],
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
    '<p class="muted comparison-subheading">How PassExamHQ stacks up against typical DMV prep options.</p>' +
    '<div class="comparison-table-scroll"><table class="comparison-table">' +
    '<thead><tr><th></th><th>Free Practice Sites</th><th>DMV Genie</th><th class="comparison-us-col">PassExamHQ</th></tr></thead>' +
    '<tbody>' +
    COMPARISON_FEATURES.map(function (f) {
      return '<tr><td class="comparison-feature">' + f[0] + '</td>' +
        comparisonCell(f[1]) + comparisonCell(f[2]) + comparisonCell(f[3], true) + '</tr>';
    }).join('') +
    '</tbody></table></div>' +
    '<p class="comparison-footnote muted">Comparison based on publicly available information as of August 2026 — ' +
    'PassExamHQ is not affiliated with or endorsed by DMV Genie.</p>' +
    '</section>';
}

// ---- Home page: outcomes strip (Round 2 redesign decision) ----------------
// Real numbers pulled from /stats/public (see examprep-api), not invented -- deliberately omits
// the raw "students served" count for now: at this site's current scale that number reads as
// thin rather than reassuring, and nothing requires showing every computed stat. Not fabrication
// either way -- just an editorial choice of which real numbers to feature.
function outcomesStripHtml() {
  return '<section class="outcomes-section" id="outcomes-section">' +
    '<h2 class="comparison-heading">Real Results, Not Marketing Copy</h2>' +
    '<p class="muted comparison-subheading">Pulled live from our own database.</p>' +
    '<div class="outcomes-grid" id="outcomes-grid-wrap"><p class="muted">Loading…</p></div>' +
    '</section>';
}
function fillOutcomesStrip() {
  var wrap = document.getElementById('outcomes-grid-wrap');
  if (!wrap) return;
  apiFetch('/stats/public').then(function (s) {
    var radialHtml = (s.passRate != null)
      ? '<div class="outcome-tile">' + radialProgressSvg(s.passRate, { size: 108, strokeWidth: 10, color: 'var(--highlight)', label: 'Pass Rate' }) + '</div>'
      : '';
    var numberTiles = [
      { value: s.totalQuestions, label: 'Practice Questions' },
      { value: s.examsCompleted, label: 'Mock Exams Completed' },
      { value: s.tracksLive, label: 'Live Exam Tracks' },
    ];
    wrap.innerHTML = radialHtml + numberTiles.map(function (t) {
      return '<div class="outcome-tile"><div class="outcome-tile-value">' + Number(t.value || 0).toLocaleString() +
        '</div><div class="outcome-tile-label">' + t.label + '</div></div>';
    }).join('');
  }).catch(function () {
    // Best-effort -- hides the whole section rather than showing an empty/broken one, since there
    // are no safe placeholder numbers to fall back to here (unlike the promo ribbon's guarantee
    // tagline fallback).
    var section = document.getElementById('outcomes-section');
    if (section) section.classList.add('hidden');
  });
}

function renderRedeem(error) {
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
    '<p class="muted redeem-sample-hint">No code yet? <a href="#/sample">Try a free sample</a> or ' +
    '<a href="#/buy">buy one instantly →</a></p>' +
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
    if (el) window.turnstile.render(el, { sitekey: TURNSTILE_SITE_KEY });
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
  var tabs = [['resources', 'Resources'], ['quiz', 'Quiz'], ['exam', 'Exam'], ['toughest45', 'Toughest 45'], ['progress', 'Progress'], ['info', 'Info']];
  var trackHeading = loggedIn ? '<div class="track-heading">' + escapeHtml((trackByExamType(state.examType) || {}).shortName || '') + '</div>' : '';
  return renderNewsBanner() + trackHeading + '<nav class="tabs">' + tabs.map(function (t) {
    var locked = gated[t[0]] && !loggedIn;
    return '<a href="#/' + t[0] + '"' + (active === t[0] ? ' aria-current="page"' : '') + '>' +
      (locked ? '🔒 ' : '') + t[1] + '</a>';
  }).join('') + '</nav>';
}

// ---- Study resources (audio/video/pdf/image guides, per exam type) --------

// Notarial fee schedule per California Government Code § 8211 et seq. "Journal Entry
// Requirements" and "Source" are identical for every row in the original data, so they're
// pulled out as shared notes below the table instead of being repeated in every row.
var NOTARY_FEE_TABLE = {
  headers: ['Notarial Service or Document Type', 'Maximum Statutory Fee', 'Legal Exceptions or Conditions', 'Applicable Code Section'],
  rows: [
    ['Acknowledgments', '$15 for each signature', 'No fee shall be collected by notaries appointed to military/naval reservations; no fee for voting materials.', 'Government Code section 8211(a)'],
    ['Jurats', '$15 for each signature', 'No fee for signatures on vote by mail ballot identification envelopes or other voting materials.', 'Government Code section 8211(b)'],
    ['Oaths/Affirmations', '$15', "No fee for veterans' benefits claims or pension-related affidavits for public entity employees.", 'Government Code section 8211(b)'],
    ['Deposition Services (Administering Oath, Certificate, and Other Services)', '$7 for oath; $7 for certificate; $30 for all other services', 'Total deposition services capped; see Code for full breakdown.', 'Government Code section 8211(c)'],
    ['Certifying a copy of a Power of Attorney', '$15', 'Certified under Probate Code section 4307.', 'Government Code section 8211(e)'],
    ['Immigration Forms', '$15 per individual per set of forms', 'Only if qualified/bonded as an immigration consultant; not applicable to attorneys rendering professional services.', 'Government Code section 8223'],
    ['Voting Materials', '$0', 'Prohibited for vote by mail ballot identification envelopes or other voting materials.', 'Government Code section 8211(d) and Elections Code section 8080'],
    ["Veteran's Benefits", '$0', 'Prohibited for application/claim for pension, allotment, allowance, compensation, or insurance.', 'Government Code section 6107'],
    ['Military/Naval Reservation Notaries', '$0', 'No fees shall be collected for service rendered within the reservation.', 'Government Code section 8203.6'],
  ],
  journalNote: 'Journal entry requirement (every row above): the fee charged must be entered in the journal; if no fee is charged, enter "no fee" or "0".',
  sourceNote: 'Source: [1] California Government Code, as compiled in the official CA Notary Public Handbook.',
};

var NOTARY_FINES_TABLE = {
  headers: ['Violation Type', 'Administrative Sanction', 'Civil Penalty Amount', 'Criminal Classification', 'Grounds for Discipline'],
  rows: [
    ['Willfully stating as true any material fact known to be false in a certificate of acknowledgment', 'Revocation or suspension of commission', 'Up to $10,000', 'Misdemeanor or Felony', 'Execution of a certificate containing a statement known to be false'],
    ['Failure to obtain satisfactory evidence for the identity of a credible witness', 'Revocation or suspension of commission', 'Up to $10,000', 'Not in source', 'Failure to discharge fully and faithfully the duties of a notary public'],
    ['Willful failure to provide access to the sequential journal upon request by a peace officer', 'Revocation or suspension of commission', 'Up to $2,500', 'Not in source', 'Willful failure to provide access to journal'],
    ['Failure to obtain required thumbprint in the sequential journal', 'Not in source', 'Up to $2,500', 'Not in source', 'Failure to discharge fully and faithfully the duties of a notary public'],
    ['Illegal advertising in a foreign language or literal translation of "notary public" (non-attorney)', 'Suspension for at least one year (1st offense); Permanent revocation (2nd offense)', 'Up to $1,500', 'Not in source', 'Violation of Section 8219.5; false or misleading advertising'],
    ['Charging more than the fees prescribed by law', 'Revocation or suspension of commission', 'Up to $750', 'Not in source', 'Charging more than fees prescribed'],
    ['Failure to complete acknowledgment at the time the seal and signature are affixed', 'Revocation or suspension of commission', 'Up to $750', 'Not in source', 'Failure to complete acknowledgment at the time of the act'],
    ['Failure to administer the oath or affirmation as required by law', 'Revocation or suspension of commission', 'Up to $750', 'Not in source', 'Failure to administer oath or affirmation'],
    ['Willful failure to notify the Secretary of State of a change of address', 'Not in source', 'Up to $500', 'Infraction', 'Willful failure to notify of change of address'],
    ['Willful failure to notify the Secretary of State of a name change', 'Not in source', 'Up to $500', 'Infraction', 'Willful failure to notify of name change'],
    ['Fraud relating to a deed of trust on a single-family residence', 'Revocation of commission', 'Not in source', 'Felony', 'Knowing and willful intent to defraud'],
    ['Willful failure to deliver notarial records to the county clerk within 30 days of commission end', 'Personal liability for damages', 'Not in source', 'Misdemeanor', 'Willful failure or refusal to deliver records'],
    ['Willful failure to keep the seal under direct and exclusive control', 'Revocation or suspension of commission', 'Not in source', 'Misdemeanor', 'Failure to secure official seal'],
  ],
  sourceNote: 'Source: [1] California Government Code and Civil Code, as compiled in the official CA Notary Public Handbook.',
};

var NOTARY_POA_TABLE = {
  headers: ['Act Type', 'Requirement or Description', 'Maximum Fee', 'Legal Code Reference', 'Thumbprint Required (Inferred)'],
  rows: [
    ['Acknowledgment (Power of Attorney)', 'Notaries may take the acknowledgment of powers of attorney. The signer must personally appear and be identified via satisfactory evidence. The notary must include a specific boxed notice at the top of the certificate.', '$15 for each signature', 'Government Code section 8205(a)(2); Government Code section 8211(a); Civil Code section 1189', 'Yes'],
    ['Journal Entry (Power of Attorney)', 'The notary public shall require the party signing a power of attorney document to place their right thumbprint (or other finger if unavailable) in the sequential journal.', 'Not in source', 'Government Code section 8206(a)(2)(G)', 'Yes'],
    ['Certifying Copies of Power of Attorney', "A notary public can certify copies of powers of attorney. The notary must examine the original and the copy to certify that the copy is true and correct. The certification must state the notary's name, the date of appearance, and that they compared the documents.", '$15', 'Probate Code section 4307; Government Code section 8211(e)', 'No'],
    ['Subscribing Witness Restriction', 'A proof of execution by a subscribing witness cannot be used in conjunction with any power of attorney.', 'N/A', 'Civil Code section 1195(b)(1); Government Code section 27287', 'No'],
  ],
  sourceNote: 'Source: [1] California Government Code, Civil Code, and Probate Code, as compiled in the official CA Notary Public Handbook.',
};

var NOTARY_TANGIBLE_COPY_TABLE = {
  headers: ['Certified Entity', 'Custodian Requirements', 'Certification Content', 'Execution Method', 'Legal Basis'],
  rows: [
    ['Tangible copy of an electronic record', 'A disinterested custodian who does not directly benefit from the electronic record and is not a grantee or beneficiary.', 'Document title, date of document, and page count; statement that the copy is an accurate reproduction; confirmation that the electronic record was accessed with tamper-evident security procedures intact; statement that no changes or errors occurred after creation, execution, or notarization; signed under penalty of perjury.', 'The certification must be subscribed and sworn to, or affirmed, by the disinterested custodian before a notary public and accompanied by a jurat.', 'California Government Code sections 27201.1 and 8202'],
  ],
  sourceNote: 'Source: [1] California Government Code, as compiled in the official CA Notary Public Handbook.',
};

var NOTARY_IMMIGRATION_TABLE = {
  headers: ['Regulation Type', 'Permitted Actions', 'Prohibited Actions', 'Maximum Fee', 'Legal Authority/Code Reference', 'Penalty for Violation'],
  rows: [
    ['Data Entry on Forms', 'A notary public qualified and bonded as an immigration consultant may enter data, provided by the client, on immigration forms provided by a federal or state agency.', 'A notary public who is not qualified and bonded as an immigration consultant may not enter data provided by a client on immigration forms nor otherwise perform the services of an immigration consultant.', '$15 per individual for each set of forms', 'Government Code section 8223; Business and Professions Code section 22440', 'Revocation or suspension of commission'],
    ['Advertising Restrictions', 'Notarizing immigration documents is not prohibited.', 'A notary public is legally barred from advertising in any manner whatsoever as a notary public if the notary public promotes themself as an immigration specialist or consultant.', 'Not in source', 'Government Code section 8223', 'Revocation or suspension of commission'],
    ['Foreign Language Advertising', 'Non-attorney notaries advertising in a language other than English must post a notice in English and the other language stating they are not an attorney and cannot give legal advice about immigration.', 'A notary public may not translate into Spanish the term "Notary Public" as "notario publico" or "notario," even if the prescribed notice is posted.', 'Must list the fees set by statute that a notary public may charge', 'Government Code section 8219.5', 'First offense: suspension or revocation of commission. Second offense: permanent revocation of commission.'],
    ['Deferred Action for Childhood Arrivals (DACA)', 'Notaries public are authorized to charge fees for providing notary public services associated with filing a DACA application.', 'Participating in price gouging (pressuring clients to purchase services immediately to avoid higher future prices).', '$15 per signature (statutory notary fee)', 'Business and Professions Code section 22449', 'Revocation or suspension of commission'],
  ],
  sourceNote: 'Source: [1] California Government Code and Business and Professions Code, as compiled in the official CA Notary Public Handbook.',
};

var NOTARY_STATUTORY_CODE_TABLE = {
  headers: ['Code Section', 'Subject', 'Key Provisions', 'Relevant Code Type'],
  rows: [
    ['8200', 'Appointment and commission; number; jurisdiction', 'The Secretary of State appoints and commissions notaries public; notaries may act in any part of the state.', 'Government Code'],
    ['8201', 'Qualifications to be a notary public; proof of course completion; reappointment', 'Requirements include being a legal resident, aged 18+ years, completing a 6-hour approved course (3-hour for renewals), and passing a written exam.', 'Government Code'],
    ['8201.1', 'Additional qualifications; determination; identification; fingerprints', 'The Secretary of State must determine applicant honesty and integrity; requires fingerprinting for background checks.', 'Government Code'],
    ['8202', 'Execution of jurat; administration of oath or affirmation to affiant; attachment to affidavit', 'Requires administering an oath or affirmation, verifying identity via satisfactory evidence, and using a specific boxed notice.', 'Government Code'],
    ['8205', 'Duties', 'Notaries may demand payment of bills (financial institutions only), take acknowledgments and proofs, take depositions, and certify powers of attorney.', 'Government Code'],
    ['8206', 'Sequential journal; contents; thumbprint; loss of journal', 'Notaries must maintain one active sequential journal in a locked area; includes specific data requirements and thumbprints for real property or power of attorney transactions.', 'Government Code'],
    ['8207', 'Seal', 'Notaries must keep and use an official seal; the seal must be photographically reproducible and kept in a secured, locked area.', 'Government Code'],
    ['8209', 'Resignation, disqualification or removal; records delivered to clerk', 'All notary records must be delivered to the county clerk within 30 days of commission termination or resignation.', 'Government Code'],
    ['8211', 'Fees', 'Sets maximum fees for acknowledgments ($15), jurats ($15), and other services; $0 fee is required for voting materials.', 'Government Code'],
    ['8213', 'Bonds and oaths; filing; transfer to new county', 'Notaries must file a $15,000 bond and oath of office with the county clerk within 30 days of commission commencement.', 'Government Code'],
    ['8214.1', 'Grounds for refusal, revocation or suspension of commission', 'Establishes 21 grounds for discipline, including misstatements on applications, felony convictions, and failure to perform duties.', 'Government Code'],
    ['8219.5', 'Advertising in language other than English', 'Establishes a required notice for non-attorneys and prohibits the literal translation of "Notary Public" into "Notario".', 'Government Code'],
    ['8224', 'Conflict of interest; financial or beneficial interest', 'Prohibits notarizing documents if the notary is named individually as a principal in financial or real property transactions.', 'Government Code'],
    ['1185', 'Acknowledgments; requisites', 'Establishes that taking an acknowledgment requires satisfactory evidence of identity via identification documents or the oaths of credible witnesses.', 'Civil Code'],
    ['1189', 'Certificate of acknowledgment; form', 'Specifies the required wording and mandatory boxed notice for acknowledgment certificates performed within California.', 'Civil Code'],
    ['1195', 'Proof of execution; methods; certificate form', 'Establishes procedures for proving execution by a subscribing witness; restricted for certain real property documents.', 'Civil Code'],
    ['14', 'Words and phrases; signature by mark', 'Defines signature to include a mark if witnessed by two people who sign the document as witnesses.', 'Civil Code'],
    ['1935', 'Subscribing witness defined', 'Defines a subscribing witness as one who sees a writing executed and signs as a witness at the party\'s request.', 'Code of Civil Procedure'],
    ['8080', 'Fee for verification', 'Prohibits collecting a fee for verifying nomination documents or circulator\'s affidavits.', 'Elections Code'],
    ['4307', 'Certified copies of power of attorney', 'Authorizes notaries public to certify copies of power of attorney documents.', 'Probate Code'],
    ['115.5', 'Filing false or forged documents; false statement to notary', 'Establishes that making a false statement to a notary to induce an improper act regarding a single-family residence is a felony.', 'Penal Code'],
  ],
  sourceNote: 'Source: [1] California Government Code, Civil Code, Code of Civil Procedure, Elections Code, Probate Code, and Penal Code, as compiled in the official CA Notary Public Handbook.',
};

var NOTARY_SIGNATURE_BY_MARK_TABLE = {
  headers: ['Signer Capability', 'Requirement Type', 'Detailed Instruction', 'Witness Involvement', 'Journal Entry Requirements'],
  rows: [
    ['Unable to write name', 'Identity and Verification',
      'The signer by mark must be identified by the notary public through satisfactory evidence as described in Civil Code section 1185. Witnesses are only verifying that they witnessed the individual make their mark on the document.',
      'Two witnesses must subscribe their own names to the document. One witness writes the signer\'s name next to the mark and then signs their own name. A notary is not required to identify the witnesses or have them sign the journal unless they act as credible witnesses.',
      'The signer must include their mark in the journal. An individual must write the signer\'s name next to the mark and sign their own name as a witness to the journal mark. Witness signatures are only required in the journal if they are also serving as credible witnesses to establish the signer\'s identity.'],
  ],
  sourceNote: 'Source: [1] California Civil Code, as compiled in the official CA Notary Public Handbook.',
};

var NOTARY_SUBSCRIBING_WITNESS_TABLE = {
  headers: ['Term/Party Name', 'Definition/Role', 'Legal Requirements', 'Establishment of Identity', 'Restricted Document Types', 'Authorized Form/Wording'],
  rows: [
    ['Subscribing Witness',
      'A person who appears on the principal\'s behalf to prove the principal signed (executed) the document.',
      'Must see the principal sign or hear them acknowledge the signature; must be requested by the principal to sign as a witness and do so; must sign the notary\'s journal; must take an oath/affirmation before the notary.',
      'Established by the oath of a credible witness whom the notary personally knows and who personally knows the subscribing witness.',
      'Power of attorney, quitclaim deed, grant deed (except certain foreclosure/reconveyance deeds), mortgage, deed of trust, security agreement, any instrument affecting real property, or documents requiring a thumbprint.',
      'Must swear/affirm that they personally know the principal, saw the principal sign (or heard acknowledgment), and signed at the principal\'s request.'],
    ['Proof of Execution Certificate',
      'The statutory notarial certificate attached to the document to verify the execution by a subscribing witness.',
      'Must include the boxed consumer notice at the top; must be executed under penalty of perjury; must be signed and sealed by the notary.',
      'Not in source', 'Not in source',
      '"A notary public or other officer completing this certificate verifies only the identity of the individual who signed the document to which this certificate is attached, and not the truthfulness, accuracy, or validity of that document. ... personally appeared [Name of subscribing witness], proved to me to be the person whose name is subscribed to the within instrument, as a witness thereto, on the oath of [Name of credible witness]..."'],
    ['Principal',
      'The person who has signed a document but does not personally appear before a notary public.',
      'Must have signed the document; must request the subscribing witness to sign the document as a witness; must either be seen signing by the witness or acknowledge the signature to the witness in person.',
      'Proved by the subscribing witness under oath, who must swear they personally know the principal.',
      'Not in source', 'Not in source'],
    ['Credible Witness',
      'An individual used to establish the identity of the subscribing witness to the notary public.',
      'Must be personally known by the notary public; must personally know the subscribing witness; must not have a financial interest and not be named in the document; must sign the notary\'s journal.',
      'Must present an identification document satisfying Civil Code section 1185(b)(3) or (4) (e.g., current driver\'s license or passport).',
      'Not in source',
      'Under oath or affirmation, the witness swears or affirms that they personally know the subscribing witness, that said witness signed the document as a subscribing witness, and the credible witness does not have a financial interest and is not named in the document.'],
  ],
  sourceNote: 'Source: [1] California Civil Code, as compiled in the official CA Notary Public Handbook.',
};

// `free: true` = viewable/playable without an access code (a hand-picked promotional sample).
// This flag is presentation-only -- the real gate is the server's own FREE_RESOURCES allowlist
// in examprep-api, which must be kept in sync with this list by filename.
// `topic` maps each resource to the closest matching exam-breakdown category from HUB_EXAMS
// below (or 'General Reference' for resources that span everything) -- a best-effort call based
// on title/description, not verified against the actual audio/video content, so treat it as a
// starting point to adjust rather than an authoritative tag.
var RESOURCES = {
  ca_notary: [
    { title: 'Official California Notary Public Handbook', type: 'pdf', url: 'https://notary.cdn.sos.ca.gov/forms/notary-handbook-current.pdf',
      desc: 'The official handbook published by the California Secretary of State — the authoritative source the exam is based on.',
      topic: 'General Reference', free: true },
    { title: 'The Power Behind California Notary Stamps', type: 'audio', file: 'The_Power_Behind_California_Notary_Stamps.m4a',
      desc: 'A guided audio walkthrough of what your notary seal legally represents and how it’s misused.',
      topic: 'Notary Public Seal', sizeBytes: 109485209 },
    { title: 'Legal Minefields for California Notaries', type: 'audio', file: 'Legal_Minefields_for_California_Notaries.m4a',
      desc: 'Common notarial mistakes that carry civil or criminal exposure, explained in plain language.',
      topic: 'Rule Book', sizeBytes: 104504457 },
    { title: 'Surprising Rules for California Notaries', type: 'video', file: 'Surprising_Rules_for_California_Notaries.mp4',
      desc: 'A short video on lesser-known notary rules that trip up first-time applicants.',
      topic: 'Rule Book', sizeBytes: 9272787 },
    { title: 'California Notary Fees', type: 'video', file: 'California_Notary_Fees.mp4',
      desc: 'A breakdown of statutory notary fees and how the exam tests them.',
      topic: 'Fees, Misconduct & Conflict of Interest', free: true, sizeBytes: 28354255 },
    { title: 'California Notary Blueprint', type: 'pdf', file: 'California_Notary_Blueprint.pdf',
      desc: 'A structured study reference covering the full exam blueprint.',
      topic: 'General Reference' },
    { title: 'California Notary 2026 Quick Guide', type: 'image', file: 'California_Notary_2026_Quick_Guide.png',
      desc: 'A one-page visual cheat sheet for last-minute review.',
      topic: 'General Reference', free: true },
    { title: 'Inside the 2026 California Notary Handbook', type: 'audio', file: 'Inside_the_2026_California_Notary_Handbook.m4a',
      desc: 'A guided walkthrough of the current handbook\'s key sections and what changed for 2026.',
      topic: 'General Reference', sizeBytes: 99783675 },
    { title: 'The Notary Toolkit', type: 'video', file: 'The_Notary_Toolkit.mp4',
      desc: 'A video tour of the tools and records every California notary is required to keep.',
      topic: 'Acknowledgment, Jurat & Journal', sizeBytes: 45767555 },
    { title: 'Why Your California Notary Stamp Is Dangerous', type: 'audio', file: 'Why_your_California_notary_stamp_is_dangerous.m4a',
      desc: 'The liability exposure behind misusing or mishandling your official seal.',
      topic: 'Notary Public Seal', sizeBytes: 101147484 },
    { title: 'Why Your Signature Is Just Ink', type: 'audio', file: 'Why_your_signature_is_just_ink.m4a',
      desc: 'What actually makes a notarization legally valid beyond the signature itself.',
      topic: 'Acknowledgment, Jurat & Journal', sizeBytes: 77632701 },
    { title: 'California Notary Fee Schedule', type: 'table', table: NOTARY_FEE_TABLE,
      desc: 'Maximum statutory fees by service type, with legal exceptions and code citations — a common exam topic.',
      topic: 'Fees, Misconduct & Conflict of Interest', free: true },
    { title: 'California Notary Violations & Enforcement Table', type: 'table', table: NOTARY_FINES_TABLE,
      desc: 'Common violations with legal references, administrative sanctions, civil penalties, and criminal classifications — a common exam topic.',
      topic: 'Fines and Enforcements' },
    { title: 'Power of Attorney Notarial Acts and Requirements', type: 'table', table: NOTARY_POA_TABLE,
      desc: 'Notarial acts involving powers of attorney — acknowledgment, journal entry, and certified-copy requirements, with legal code references.',
      topic: 'Powers Of Attorney' },
    { title: 'Tangible Copy of an Electronic Record Certification', type: 'table', table: NOTARY_TANGIBLE_COPY_TABLE,
      desc: 'Custodian and certification requirements for producing a tangible copy of an electronic record, with legal code references.',
      topic: 'Tangible Copy Certification' },
    { title: 'How Digital Deeds Become Physical Property Records', type: 'audio', file: 'How_digital_deeds_become_physical_property_records.m4a',
      desc: 'A guided audio walkthrough of how an electronic record is turned into a certified tangible copy.',
      topic: 'Tangible Copy Certification', sizeBytes: 57287269 },
    { title: 'Tangible Copy Certification', type: 'video', file: 'Tangible_Copy_Certification.mp4',
      desc: 'A video overview of the custodian and certification requirements for tangible copies of electronic records.',
      topic: 'Tangible Copy Certification', sizeBytes: 28459208 },
    { title: 'Immigration Document Regulations', type: 'table', table: NOTARY_IMMIGRATION_TABLE,
      desc: 'Permitted and prohibited notary conduct around immigration documents — data entry, advertising, and DACA fee rules — with legal code references.',
      topic: 'Immigration Documents' },
    { title: 'Notary Statutory Code Reference', type: 'table', table: NOTARY_STATUTORY_CODE_TABLE,
      desc: 'Key California Government Code, Civil Code, and other statutory provisions governing notaries public, section by section.',
      topic: 'Statutory Code' },
    { title: 'California Notary Laws Prevent Property Fraud', type: 'audio', file: 'California_Notary_Laws_Prevent_Property_Fraud.m4a',
      desc: 'A guided audio walkthrough of how notarial statutes are designed to prevent property fraud.',
      topic: 'Statutory Code', sizeBytes: 97109843 },
    { title: 'CA Notary Public Lifecycle', type: 'video', file: 'CA_Notary_Public_Lifecycle.mp4',
      desc: 'A video overview of the statutory lifecycle of a California notary commission — appointment through resignation or removal.',
      topic: 'Statutory Code', sizeBytes: 43566439 },
    { title: 'Signature by Mark Requirements', type: 'table', table: NOTARY_SIGNATURE_BY_MARK_TABLE,
      desc: 'Identity verification, witness, and journal requirements when a signer cannot write their name.',
      topic: 'Signature By Mark' },
    { title: 'Signature by Mark', type: 'video', file: 'Signature_by_Mark.mp4',
      desc: 'A video overview of the witness and journal requirements when a signer cannot write their name.',
      topic: 'Signature By Mark', sizeBytes: 29428193 },
    { title: 'How an X Becomes a Legal Signature', type: 'audio', file: 'How_an_X_becomes_a_legal_signature.m4a',
      desc: 'A guided audio walkthrough of what makes a signature by mark legally valid.',
      topic: 'Signature By Mark', sizeBytes: 62293420 },
    { title: 'Subscribing Witness Requirements', type: 'table', table: NOTARY_SUBSCRIBING_WITNESS_TABLE,
      desc: 'Roles, requirements, and authorized wording for proof of execution by a subscribing witness.',
      topic: 'Subscribing Witness' },
    { title: 'California Notary Rules for Absent Signers', type: 'audio', file: 'California_Notary_Rules_for_Absent_Signers.m4a',
      desc: 'A guided audio walkthrough of proof of execution by a subscribing witness when the principal can\'t appear.',
      topic: 'Subscribing Witness', sizeBytes: 41295591 },
    { title: 'Proof of Execution', type: 'video', file: 'Proof_of_Execution.mp4',
      desc: 'A video overview of proof of execution by a subscribing witness.',
      topic: 'Subscribing Witness', sizeBytes: 34309797 },
    { title: 'Rules for Immigration Documents', type: 'audio', file: 'Rules_for_Immigration_Documents.m4a',
      desc: 'A guided audio walkthrough of what California notaries can and cannot do with immigration documents.',
      topic: 'Immigration Documents', sizeBytes: 73243720 },
    { title: 'Immigration Documents - Trust Guardians', type: 'video', file: 'Immigration_Documents_-_Trust_Guardians.mp4',
      desc: 'A video overview of the advertising and conduct restrictions notaries face when handling immigration documents.',
      topic: 'Immigration Documents', sizeBytes: 37166925 },
    { title: 'California Notary Rules', type: 'video', file: 'California_Notary_Rules.mp4',
      desc: 'A video overview of key California notary rules every applicant should know.',
      topic: 'Rule Book', sizeBytes: 29605729 },
    { title: 'Why California Notaries Demand Your Thumbprint', type: 'audio', file: 'Why_California_Notaries_Demand_Your_Thumbprint.m4a',
      desc: 'A guided audio walkthrough of when and why California notaries require a right thumbprint in the journal.',
      topic: 'Powers Of Attorney', sizeBytes: 46611248 },
    { title: 'California Powers of Attorney', type: 'video', file: 'CA_Powers_of_Attorney.mp4',
      desc: 'A video overview of notarial acts involving powers of attorney — acknowledgment, journal entry, and certified-copy rules.',
      topic: 'Powers Of Attorney', sizeBytes: 34638651 },
  ],
  ca_driver: [
    { title: 'Official California Driver Handbook', type: 'pdf', url: 'https://www.dmv.ca.gov/portal/file/california-driver-handbook-pdf/',
      desc: 'The official handbook published by the California DMV (DL 600) — the authoritative source the written knowledge test is based on.',
      topic: 'General Reference', free: true },
  ],
  ca_cdl: [
    { title: 'Official California Commercial Driver Handbook', type: 'pdf', url: 'https://www.dmv.ca.gov/portal/file/california-commercial-driver-handbook-pdf/',
      desc: 'The official handbook published by the California DMV (DL 650) — the authoritative source the CDL knowledge and endorsement tests are based on.',
      topic: 'General Reference', free: true },
  ],
  ca_motorcycle: [
    { title: 'Official California Motorcycle Handbook', type: 'pdf', url: 'https://www.dmv.ca.gov/portal/file/motorcycle-driver-handbook-pdf/',
      desc: 'The official handbook published by the California DMV (DL 665) — the authoritative source the M1/M2 written knowledge test is based on.',
      topic: 'General Reference', free: true },
  ],
  tx_driver: [
    { title: 'Official Texas Driver Handbook', type: 'pdf', url: 'https://www.dps.texas.gov/internetforms/forms/dl-7.pdf',
      desc: 'The official handbook published by the Texas Department of Public Safety (DL-7) — the authoritative source the written knowledge test is based on.',
      topic: 'General Reference', free: true },
  ],
  tx_cdl: [
    { title: 'Official Texas Commercial Motor Vehicle Driver\'s Handbook', type: 'pdf', url: 'https://www.dps.texas.gov/internetforms/Forms/DL-7C.pdf',
      desc: 'The official handbook published by the Texas Department of Public Safety (DL-7C) — the authoritative source the CDL knowledge and endorsement tests are based on.',
      topic: 'General Reference', free: true },
  ],
  fl_driver: [
    { title: 'Official Florida Driver License Handbook', type: 'pdf', url: 'https://www.flhsmv.gov/pdf/handbooks/englishdriverhandbook.pdf',
      desc: 'The official handbook published by the Florida Department of Highway Safety and Motor Vehicles — the authoritative source the Class E Knowledge Exam is based on.',
      topic: 'General Reference', free: true },
  ],
  fl_cdl: [
    { title: 'Official Florida CDL Handbook', type: 'pdf', url: 'https://www.flhsmv.gov/pdf/handbooks/englishcdlhandbook.pdf',
      desc: 'The official handbook published by the Florida Department of Highway Safety and Motor Vehicles — the authoritative source the CDL knowledge and endorsement tests are based on.',
      topic: 'General Reference', free: true },
  ],
  ny_driver: [
    { title: 'Official New York State Driver\'s Manual', type: 'pdf', url: 'https://dmv.ny.gov/brochure/mv21.pdf',
      desc: 'The official manual published by the New York DMV (MV-21) — the authoritative source the written knowledge test is based on.',
      topic: 'General Reference', free: true },
  ],
  ny_cdl: [
    { title: 'Official New York State Commercial Driver\'s Manual', type: 'pdf', url: 'https://dmv.ny.gov/driver-license/commercial-drivers/new-york-state-commercial-drivers-manual',
      desc: 'The official manual page published by the New York DMV (CDL-10, 12 sections) — the authoritative source the CDL knowledge and endorsement tests are based on.',
      topic: 'General Reference', free: true },
  ],
  ny_notary: [
    { title: 'Official Notary Public License Law', type: 'pdf', url: 'https://dos.ny.gov/system/files/documents/2026/03/notary-public-license-law_03.2026.pdf',
      desc: 'The official booklet published by the New York Department of State — the authoritative source the notary exam is based on.',
      topic: 'General Reference', free: true },
  ],
  il_driver: [
    { title: 'Illinois Rules of the Road', type: 'pdf', url: 'https://www.ilsos.gov/content/dam/publications/pdf_publications/dsd_a112.pdf',
      desc: 'The official manual published by the Illinois Secretary of State — the authoritative source the written knowledge test is based on.',
      topic: 'General Reference', free: true },
  ],
  il_real_estate: [
    { title: 'Illinois Real Estate License Act of 2000', type: 'pdf', url: 'https://www.ilga.gov/legislation/ILCS/details?MajorTopic=&Chapter=&ActName=Real+Estate+License+Act+of+2000.&ActID=1364&ChapterID=24&SeqStart=&ChapAct=FullText',
      desc: 'The official statute (225 ILCS 454) published by the Illinois General Assembly — the authoritative source the state-specific portion of the exam is based on.',
      topic: 'General Reference', free: true },
    { title: 'PSI Candidate Information Booklet', type: 'pdf', url: 'https://test-takers.psiexams.com/api/content/bulletin/4655',
      desc: 'The official exam scheduling and content-outline reference from PSI, the IDFPR-contracted exam vendor.',
      topic: 'General Reference', free: true },
  ],
  il_managing_broker: [
    { title: 'Illinois Real Estate License Act of 2000', type: 'pdf', url: 'https://www.ilga.gov/legislation/ILCS/details?MajorTopic=&Chapter=&ActName=Real+Estate+License+Act+of+2000.&ActID=1364&ChapterID=24&SeqStart=&ChapAct=FullText',
      desc: 'The official statute (225 ILCS 454) published by the Illinois General Assembly — the authoritative source the state-specific exam is based on.',
      topic: 'General Reference', free: true },
    { title: 'PSI Candidate Information Booklet', type: 'pdf', url: 'https://test-takers.psiexams.com/api/content/bulletin/4655',
      desc: 'The official exam scheduling and content-outline reference from PSI, the IDFPR-contracted exam vendor.',
      topic: 'General Reference', free: true },
  ],
  pa_driver: [
    { title: 'Pennsylvania Driver\'s Manual', type: 'pdf', url: 'https://www.pa.gov/content/dam/copapwp-pagov/en/penndot/documents/public/dvspubsforms/bdl/bdl-manuals/pa-drivers-manual-non-commercial/english/pub%2095.pdf',
      desc: 'The official manual published by PennDOT (PUB 95) — the authoritative source the written knowledge test is based on.',
      topic: 'General Reference', free: true },
  ],
  pa_cdl: [
    { title: 'Pennsylvania Commercial Driver\'s Manual', type: 'pdf', url: 'https://www.pa.gov/content/dam/copapwp-pagov/en/penndot/documents/public/dvspubsforms/bdl/bdl-manuals/commercial-drivers-manual/pub223.pdf',
      desc: 'The official manual published by PennDOT (PUB223) — the authoritative source the CDL knowledge and endorsement tests are based on.',
      topic: 'General Reference', free: true },
  ],
  pa_real_estate: [
    { title: '49 Pa. Code Chapter 35 (State Real Estate Commission)', type: 'pdf', url: 'https://www.pacodeandbulletin.gov/secure/pacode/data/049/chapter35/049_0035.pdf',
      desc: 'The official regulations published by the Pennsylvania Code and Bulletin — the authoritative source the state-specific portion of the exam is based on.',
      topic: 'General Reference', free: true },
    { title: 'Pearson VUE Candidate Handbook', type: 'pdf', url: 'https://www.pearsonvue.com/content/dam/VUE/vue/en/documents/publications/093900.pdf',
      desc: 'The official exam scheduling and content-outline reference from Pearson VUE, the Real Estate Commission\'s contracted exam vendor.',
      topic: 'General Reference', free: true },
  ],
  ca_dre: [
    { title: 'California Real Estate Law', type: 'pdf', url: 'https://www.dre.ca.gov/files/pdf/relaw/relaw.pdf',
      desc: 'The official statute (Business and Professions Code, Division 4), published annually by the California Department of Real Estate — the authoritative source the exam is based on.',
      topic: 'General Reference', free: true },
    { title: 'DRE Examination Description (RE 425)', type: 'pdf', url: 'https://www.dre.ca.gov/files/pdf/forms/re425.pdf',
      desc: 'DRE\'s own official exam content outline — the 7 major subject areas and their exam-weight percentages.',
      topic: 'General Reference', free: true },
  ],
};

var RESOURCE_TYPE_LABEL = {
  audio: { icon: '🎧', label: 'Audio' }, video: { icon: '🎥', label: 'Video' },
  pdf: { icon: '📄', label: 'PDF Guide' }, image: { icon: '🖼️', label: 'Quick Reference' },
  table: { icon: '📊', label: 'Reference Table' },
};
function resourceTypeCellHtml(type) {
  var t = RESOURCE_TYPE_LABEL[type];
  return '<span class="resource-type-cell"><span>' + t.icon + '</span><span>' + t.label + '</span></span>';
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
  '<a class="btn-secondary btn-sm" href="#/sample">Try 5 sample questions →</a>' +
  '</div></div>';

// Resources are listed as one sortable table (not a card grid) — Type/Name/Topic/Length/Status,
// with an expandable row for whichever item is currently open. Module-level so the sort/expand
// click handlers (delegated, see the document click listener) can re-render without re-fetching.
var resourcesRowsCache = [];
var resourcesSort = { key: 'status', dir: -1 }; // dir:-1 so unlocked/free rows (higher value) sort first
var resourcesOpenIndex = null;
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
      var actionLabel = isOpen ? 'Hide' : row.type === 'table' ? 'Show' : row.type === 'image' ? 'View' : 'Play';
      var actionIcon = isOpen ? '✕' : row.type === 'table' ? '📊' : row.type === 'image' ? '👁' : '▶';
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
var examAttemptsSort = { key: 'date', dir: 'desc' }; // newest first by default; click a header to re-sort (e.g. by Mode, to group Toughest 45 attempts together)
var EXAM_ATTEMPTS_COLLAPSED_COUNT = 2;
var EXAM_ATTEMPT_MODE_LABELS = { standard: 'Standard', toughest45: 'Toughest 45' };

// Per-attempt exam history for the Progress tab -- same attempts list as the Exam/Toughest 45
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

// Standard and Toughest 45 attempts merged into one sortable table (a Mode column tells them
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

// ---- Track landing/sales page (logged-out visitors) -----------------------
// Consolidated single sales page (Round 2 redesign decision) -- replaces the previous four
// per-tab locked-preview mockups (one each for Quiz/Exam/Toughest45/Progress, each showing a
// blurred fake preview of that tab) with one persuasive page shown for ANY of those routes while
// logged out, or logged in for a different track. Reuses the same specs/breakdown markup the hub
// cards used to show before they were shrunk (kept in style.css for exactly this) and the
// checkout page's two-column .buy-layout pattern.
function renderTrackLanding() {
  var exam = trackByExamType(state.examType);
  if (!exam) { renderHub(); return; }
  var specsHtml = '<div class="exam-specs">' +
    '<div>⏱️ <strong>Duration:</strong> ' + exam.duration + '</div>' +
    '<div>📄 <strong>Questions:</strong> ' + exam.questions + '</div>' +
    '<div>🏆 <strong>Passing Score:</strong> ' + exam.passScore + '</div>' +
    '</div>';
  var breakdownHtml = '<div class="breakdown-label">Key Breakdown</div><div class="breakdown-list">' +
    exam.breakdown.map(function (b) {
      var pct = parseInt(b[1], 10) || 0;
      return '<div class="breakdown-row">' +
        '<div class="breakdown-row-top"><span>' + b[0] + '</span><span>' + b[1] + '</span></div>' +
        '<div class="breakdown-bar"><div class="breakdown-bar-fill pct-' + pct + '"></div></div>' +
        '</div>';
    }).join('') + '</div>';
  var infoLinks = ADDITIONAL_INFO_LINKS[exam.examType] || [];
  var officialLinkHtml = infoLinks.length
    ? '<a class="btn-secondary hub-cta" href="' + infoLinks[0].url + '" target="_blank" rel="noopener noreferrer">Official exam info ↗</a>'
    : '';
  var compliance = trackCompliance(exam.examType);

  appEl.innerHTML =
    '<div class="track-landing">' +
    '<nav class="track-landing-breadcrumb muted" aria-label="Breadcrumb"><a href="/#tracks">Exams</a> / ' +
    escapeHtml(STATE_LABELS[exam.stateCode] || exam.stateCode) + '</nav>' +
    '<div class="exam-track-top"><span class="badge">' + exam.category + '</span>' +
    '<span class="status-badge active"><span class="pulse-dot"></span>Active</span></div>' +
    '<h1>' + exam.title + '</h1>' +
    '<p class="muted page-intro-text">' + exam.description + '</p>' +
    '<div class="buy-layout">' +
    '<div class="buy-value-col"><div class="card">' + specsHtml + breakdownHtml + '</div></div>' +
    '<div class="card">' +
    '<div class="exam-track-price" id="landing-price">…</div>' +
    '<ul class="buy-feature-list">' +
    '<li>✓ Full question bank, unlimited practice</li>' +
    '<li>✓ Timed mock exam &amp; Toughest 45 drills</li>' +
    '<li>✓ Voice-enabled answering &amp; read-aloud</li>' +
    '<li>✓ Per-topic progress tracking</li>' +
    '<li>✓ Pass-or-money-back guarantee</li>' +
    '</ul>' +
    '<a class="btn-primary hub-cta" href="#/buy">Get Instant Access →</a>' +
    '<a class="btn-secondary hub-cta" href="#/sample">Try a free sample →</a>' +
    '<p class="muted redeem-sample-hint">Already have a code? <a href="#/redeem">Redeem it →</a></p>' +
    (officialLinkHtml ? '<div class="track-landing-official">' + officialLinkHtml + '</div>' : '') +
    '<p class="muted track-landing-disclaimer">Not affiliated with, authorized by, sponsored by, or endorsed by ' + compliance.orgLine + '.</p>' +
    '</div>' +
    '</div>' +
    '<section class="track-landing-preview-section">' +
    '<h2>Preview the study hub</h2>' +
    '<p class="muted">Here\'s what Quiz, Exam, and Progress look like inside this track — unlock to start.</p>' +
    trackLandingPreviewHtml(exam) +
    '</section>' +
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
}

// Tabbed Quiz/Exam/Progress teaser, embedded directly on the landing page (client-side tab switch,
// no navigation) -- ports v0's locked-preview.tsx as a widget rather than the separate routed
// pages this site used to have (see the Stage 6 consolidation note above). Blurred + overlaid with
// an unlock CTA, same as before -- the example content inside is illustrative (what the UI looks
// like), not a claim about the viewer's own data, same category as the sample question mockups
// this site has always shown to logged-out visitors.
function trackLandingPreviewHtml(exam) {
  var firstTopic = (exam.breakdown && exam.breakdown[0] && exam.breakdown[0][0]) || 'the exam topics';
  var quizPanel = '<div class="locked-preview-quiz">' +
    '<p class="muted locked-preview-meta">Question 4 of ' + exam.questions + ' · ' + escapeHtml(firstTopic) + '</p>' +
    '<h4>Sample question about ' + escapeHtml(firstTopic) + '</h4>' +
    '<div class="options-grid">' + ['A', 'B', 'C', 'D'].map(function (k) {
      return optionButtonHtml(k, 'Answer choice ' + k, 'option-btn', 'disabled');
    }).join('') + '</div>' +
    '</div>';
  var examPanel = '<div class="locked-preview-exam">' +
    '<div class="locked-preview-exam-bar"><span>Mock exam in progress</span><span>28:14</span></div>' +
    '<div class="breakdown-bar locked-preview-exam-track"><div class="breakdown-bar-fill pct-33"></div></div>' +
    '<p class="muted">' + exam.questions + ' · ' + exam.duration + ' · pass at ' + exam.passScore + '</p>' +
    '<div class="card"><p>No feedback until you finish — just like the real thing.</p></div>' +
    '</div>';
  var progressPanel = '<div class="locked-preview-progress-panel">' +
    radialProgressSvg(82, { size: 96, strokeWidth: 9, label: 'Accuracy' }) +
    radialProgressSvg(64, { size: 96, strokeWidth: 9, label: 'Coverage', color: 'var(--highlight)' }) +
    '</div>';

  return '<div class="locked-preview-tabs-wrap">' +
    '<div class="locked-preview-tabs" role="tablist">' +
    '<button type="button" class="active" data-act="landing-preview-tab" data-tab="quiz">Quiz</button>' +
    '<button type="button" data-act="landing-preview-tab" data-tab="exam">Exam</button>' +
    '<button type="button" data-act="landing-preview-tab" data-tab="progress">Progress</button>' +
    '</div>' +
    '<div class="locked-preview-body">' +
    '<div class="locked-preview-mockup" data-preview-panel="quiz">' + quizPanel + '</div>' +
    '<div class="locked-preview-mockup" data-preview-panel="exam" hidden>' + examPanel + '</div>' +
    '<div class="locked-preview-mockup" data-preview-panel="progress" hidden>' + progressPanel + '</div>' +
    '<div class="locked-preview-overlay">' +
    '<div class="locked-preview-icon">🔒</div>' +
    '<p id="landing-preview-unlock-text">Unlock the full quiz for this track</p>' +
    '<a class="btn-primary hub-cta" href="#/buy">Unlock for <span id="landing-preview-price">…</span></a>' +
    '</div>' +
    '</div>' +
    '</div>';
}

// ---- Additional information (official external links, per exam type) -----

var ADDITIONAL_INFO_LINKS = {
  ca_notary: [
    { title: 'Secretary of State Site for Notary', url: 'https://www.sos.ca.gov/notary',
      desc: 'The California Secretary of State\'s official notary public program page.' },
    { title: 'Exam Registration', url: 'https://www.sos.ca.gov/notary/checklist/registration/',
      desc: 'Official checklist and registration process for the state notary exam.' },
    { title: 'Notary Exam Information', url: 'https://cpshr.us/services/california-notary-exam-2/notary-exam-information',
      desc: 'CPS HR Consulting, the vendor that administers the exam on behalf of the state — format, scheduling, and testing-day details.' },
  ],
};

function renderAdditionalInfo() {
  var links = ADDITIONAL_INFO_LINKS[state.examType] || [];
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

// ---- Timed mock exam (+ "Toughest 45", a harder variant) ------------------
// A single-sitting, timed simulation of the real exam -- no per-question feedback, free
// navigation between questions, and a countdown clock computed from the server's own
// startedAt (not a client-only timer), so a refresh mid-sitting resumes in place rather than
// restarting the clock or handing out a fresh question set.
//
// Both the regular exam and "Toughest 45" (same timed format, but every question is drawn from
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
  var isToughest = mode === 'toughest45';
  var config = await apiFetch('/exam/config');
  examState.config = config;
  var compliance = trackCompliance(state.examType);
  var questionSourceLine = isToughest
    ? '<li>Built <strong>entirely from questions you\'ve gotten wrong before</strong> -- up to ' + config.questionCount +
      ', but could be fewer if you currently have less than that missed (no filler questions)</li>'
    : '<li><strong>' + config.questionCount + ' questions</strong>, drawn at random from the full question bank</li>';
  appEl.innerHTML = renderTabs(examTabKey(mode)) +
    '<h1>' + (isToughest ? 'Toughest 45' : 'Timed Practice Exam') + '</h1>' +
    (isToughest ? '<p class="muted page-intro-text">Same timed format as the practice exam, but every question is one you\'ve missed before -- a focused drill on your actual weak spots.</p>' : '') +
    '<div class="card mockexam-intro-card">' +
    '<p>This mimics the real exam format as closely as possible:</p>' +
    '<ul class="mockexam-intro-list">' +
    questionSourceLine +
    '<li><strong>' + Math.round(config.durationSec / 60) + '-minute</strong> timer, running continuously in one sitting</li>' +
    '<li>No answer feedback until you finish — just like the real thing</li>' +
    '<li>Need <strong>' + config.passPercent + '%</strong> to pass (' + compliance.passScoreNote + ')</li>' +
    '</ul>' +
    '<p class="muted">Once started, the clock keeps running even if you close this tab — reopening it will resume ' +
    'right where you left off, not restart. There\'s no pausing.</p>' +
    '<p class="exam-disclaimer-callout">This is an independent practice tool, not the official state exam. Completing it does not ' +
    compliance.examIntroDisclaimer + '</p>' +
    (isToughest ? '' :
      '<label class="auto-advance-toggle">' +
      '<input type="checkbox" data-act="toggle-exam-unseen-only"' + (examUnseenOnly ? ' checked' : '') + '> ' +
      'Only questions I haven\'t seen before (exam may run shorter than ' + config.questionCount + ')</label>') +
    '<button class="btn-primary" type="button" data-act="exam-begin" data-mode="' + mode + '">Begin Exam →</button>' +
    '<a class="btn-secondary exam-history-link" href="' + examHistoryHash(mode) + '">View past attempts →</a>' +
    '</div>';
}

async function renderExamHistory(mode) {
  mode = mode || 'standard';
  var examLabel = mode === 'toughest45' ? 'Toughest 45 exam' : 'practice exam';
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
    var attempt = await apiFetch('/exam/start', { method: 'POST', body: { mode: mode, unseenOnly: unseenOnly } });
    enterExamSitting(attempt, mode);
  } catch (e) {
    // Toughest 45 has no backfill -- a user with nothing currently wrong gets 'no_questions' here,
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
    '<div class="mockexam-timer" id="exam-timer-display">' + formatClock(examSecondsRemaining()) + '</div>' +
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
    (examState.mode === 'toughest45' ? 'Toughest 45' : 'Exam') + '</a>';
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
      (mode === 'toughest45' ? 'Toughest 45 exam' : 'practice exam') + ' →</button>';

  appEl.innerHTML = renderTabs(examTabKey(mode)) +
    '<h1>' + (result.passed ? 'You passed! 🎉' : 'Not quite — keep studying') + '</h1>' +
    dateNote +
    '<div class="stats-bar">' +
    '<div class="stat-box"><div class="label">Score</div><div class="val">' + result.correct + ' / ' + result.total + '</div></div>' +
    '<div class="stat-box"><div class="label">Percent</div><div class="val ' + (result.passed ? 'correct' : 'wrong') + '">' + result.percent + '%</div></div>' +
    '<div class="stat-box"><div class="label">Time used</div><div class="val">' + formatClock(result.timeTakenSec) + '</div></div>' +
    '</div>' +
    '<p class="muted mockexam-result-note">Practice score only — the real exam reports a proprietary scaled score, not raw percent-correct.</p>' +
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

function renderBuy() {
  var trackTitle = (trackByExamType(state.examType) || {}).title || 'PassExamHQ';
  appEl.innerHTML = '<h1>Get Instant Access</h1><p class="buy-track-subtitle">' + escapeHtml(trackTitle) + '</p><p class="muted">Loading price…</p>';
  Promise.all([apiFetch('/pricing?examType=' + encodeURIComponent(state.examType)), loadSiteConfig()]).then(function (results) {
    var p = results[0];
    buyPricing = p;
    drawBuyForm(p);
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

function drawBuyForm(pricing) {
  var priceLabel = '$' + (pricing.priceCents / 100).toFixed(2);
  var trackTitle = (trackByExamType(state.examType) || {}).title || 'PassExamHQ';
  buyPromoCode = null;
  buyPromoDiscountCents = 0;
  appEl.innerHTML =
    '<h1>Get Instant Access</h1>' +
    '<p class="buy-track-subtitle">' + escapeHtml(trackTitle) + '</p>' +
    '<div id="checkout-promotions-wrap" class="promotions-wrap"></div>' +
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
    '<div class="card buy-guarantee-card">' +
    '<div class="buy-guarantee-item"><strong>🎯 Pass or ' + refundFailurePercent + '% of Your Money Back</strong>' +
    '<p class="muted">Take the real exam and don\'t pass? Get ' + refundFailurePercent + '% of your money back ' +
    '(as long as you maintain a minimum of ' + progressAccuracyPassPct + '% Accuracy and ' + progressCoveragePassPct + '% Coverage).</p></div>' +
    '<p class="muted buy-guarantee-footnote"><a href="' + (trackByExamType(state.examType) || {}).route + '#/refund">Refund request →</a></p>' +
    '</div>' +
    '</div>' +
    '<div class="buy-payment-col">' +
    '<div class="card">' +
    '<label class="muted buy-email-label">Email Address (to send your instant access receipt & code)</label>' +
    '<input type="email" id="buy-email" placeholder="you@example.com">' +
    '<button class="btn-secondary btn-sm" type="button" data-act="check-points">Check my points</button>' +
    '<div id="points-result"></div>' +
    '<label class="muted buy-email-label buy-promo-label">Promo code (optional)</label>' +
    '<div class="buy-promo-row">' +
    '<input type="text" id="buy-promo-input" placeholder="e.g. SAVE20">' +
    '<button class="btn-secondary btn-sm" type="button" data-act="apply-promo-code">Apply</button>' +
    '</div>' +
    '<div id="buy-promo-result"></div>' +
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
    '<p class="muted redeem-sample-hint">Already have a code? <a href="' + (trackByExamType(state.examType) || {}).route + '">Enter it here</a></p>' +
    '<div id="buy-other-tracks-wrap"></div>';
  renderTurnstileWidget();
  loadOtherTracksPricing();
  // Re-quotes on email blur (not just on Apply/points-toggle) so a codeless, domain-gated promo
  // (e.g. a .edu student discount) gets auto-detected the moment a qualifying email is entered --
  // no code to type or Apply button to click for that case.
  var buyEmailEl = document.getElementById('buy-email');
  if (buyEmailEl) buyEmailEl.addEventListener('blur', function () { mountStripePaymentElement(); });
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
function loadOtherTracksPricing() {
  var wrap = document.getElementById('buy-other-tracks-wrap');
  if (!wrap) return;
  var others = HUB_EXAMS.filter(function (e) { return e.active && e.examType !== state.examType; });
  if (!others.length) return;
  Promise.all(others.map(function (t) {
    return apiFetch('/pricing?examType=' + encodeURIComponent(t.examType))
      .then(function (p) { return { track: t, priceCents: p.priceCents }; })
      .catch(function () { return null; });
  })).then(function (results) {
    var rows = results.filter(Boolean).map(function (r) {
      return '<a class="buy-other-track-row" href="' + r.track.route + '#/buy">' +
        '<span>' + escapeHtml(r.track.shortName || r.track.title) + '</span>' +
        '<span class="buy-other-track-price">$' + (r.priceCents / 100).toFixed(2) + '</span>' +
        '</a>';
    }).join('');
    if (!rows) return;
    wrap.innerHTML = '<div class="card buy-other-tracks-card">' +
      '<div class="buy-other-tracks-label">Also studying for something else?</div>' +
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
  waitForTurnstileToken(function (turnstileToken) {
    var emailEl = document.getElementById('buy-email');
    var email = emailEl && emailEl.value.trim() ? emailEl.value.trim() : undefined;
    var applyCheckbox = document.getElementById('apply-points-checkbox');
    var applyPoints = !!(applyCheckbox && applyCheckbox.checked);
    var promoResultEl = document.getElementById('buy-promo-result');
    apiFetch('/stripe/create-intent', {
      method: 'POST', body: { examType: state.examType, turnstileToken: turnstileToken, email: email, applyPoints: applyPoints, promoCode: buyPromoCode || undefined },
    }).then(function (r) {
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
  try {
    var res = await apiFetch('/stripe/confirm', {
      method: 'POST', body: { paymentIntentId: result.paymentIntent.id, examType: state.examType, email: email },
    });
    setToken(res.token);
    renderSiteHeader();
    state.examType = res.examType;
    accountExamType = res.examType;
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

  // Live values from the admin's actual point-rule/price settings, so this copy never drifts
  // out of sync -- falls back to sane defaults if the fetch fails, rather than blocking the page.
  var rules = { referralVerifiedPoints: 25, referralConvertedPoints: 100 };
  var pricing = { priceCents: 499 };
  try {
    var results = await Promise.all([apiFetch('/points/rules'), apiFetch('/pricing?examType=' + encodeURIComponent(state.examType))]);
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
    '</section>' +
    '<div class="narrow-page">' +
    '<h1>Refer friends, earn free access</h1>' +
    '<div id="refer-promotions-wrap" class="promotions-wrap"></div>' +
    '<p class="muted page-intro-text">Earn <strong>' + rules.referralVerifiedPoints + ' points</strong> when a friend confirms their email, ' +
    'plus <strong>' + rules.referralConvertedPoints + ' more</strong> if they go on to buy a course. Reach ' +
    '<strong>' + required + ' points</strong> to unlock the ' + escapeHtml((trackByExamType(state.examType) || {}).title || 'course') + ' completely free.</p>' +
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
    referHowItWorksHtml(rules);
  renderTurnstileWidget();
  Promise.all([apiFetch('/promotions?placement=refer'), loadSiteConfig()]).then(function (results) {
    var r = results[0];
    var wrap = document.getElementById('refer-promotions-wrap');
    if (wrap) wrap.innerHTML = promoBannersHtml(r.promotions || [], true);
  }).catch(function () { /* best-effort */ });
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
      '<a class="btn-primary hub-cta" href="#/sample">Try 5 free sample questions →</a>' +
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
    renderSiteHeader();
    state.examType = res.examType;
    accountExamType = res.examType;
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
      '<a class="btn-primary hub-cta" href="#/buy">Back to checkout →</a>' +
      '<a class="btn-secondary hub-cta" href="#/refer">Back to Refer-a-Friend →</a></div>';
  }).catch(function () {
    appEl.innerHTML = '<div class="narrow-page"><h1>Could not confirm</h1>' +
      '<p class="muted">This link may be invalid or expired (links are good for 7 days). Go back to wherever ' +
      'you applied the code and click Apply again to get a new one.</p>' +
      '<a class="btn-secondary hub-cta" href="#/buy">Back to checkout</a>' +
      '<a class="btn-secondary hub-cta" href="#/refer">Back to Refer-a-Friend</a></div>';
  });
}

// ---- Free sample (no access code needed) -----------------------------------

async function renderSample() {
  appEl.innerHTML = '<h1>Try a free sample</h1>' +
    '<p class="muted">5 questions, no access code needed.</p><p class="muted">Loading…</p>';
  if (!sampleState.questions) {
    try {
      var res = await apiFetch('/sample?examType=' + encodeURIComponent(state.examType));
      sampleState.questions = res.questions;
      sampleState.index = 0;
      sampleState.answered = null;
    } catch (e) {
      appEl.innerHTML = '<p>Could not load the sample. Try again shortly.</p>';
      return;
    }
  }
  drawSampleQuestion();
}

function drawSampleQuestion() {
  if (sampleState.index >= sampleState.questions.length) {
    appEl.innerHTML =
      '<h1>That was the sample</h1>' +
      '<p class="muted">Enter an access code to unlock the full question bank and track your progress.</p>' +
      '<div class="sample-done-cta">' +
      '<a class="btn-primary hub-cta" href="' + (trackByExamType(state.examType) || {}).route + '">Enter access code →</a>' +
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
    }
    return optionButtonHtml(k, q.choices[k], cls,
      'data-act="sample-answer" data-choice="' + k + '"' + (sampleState.answered ? ' disabled' : ''));
  }).join('');

  var explanation = sampleState.answered
    ? '<div class="explanation-box">' +
      '<strong class="' + (sampleState.answered === q.correctChoice ? 'result-correct' : 'result-incorrect') + '">' +
      (sampleState.answered === q.correctChoice ? 'Correct.' : 'Incorrect.') + '</strong> ' + q.explanation + '</div>' +
      '<div class="nav-controls"><button class="btn-primary" data-act="sample-next">' +
      (sampleState.index + 1 < sampleState.questions.length ? 'Next question →' : 'See results →') + '</button></div>'
    : '';

  appEl.innerHTML =
    '<p class="muted">Free sample — question ' + (sampleState.index + 1) + ' of ' + sampleState.questions.length + '</p>' +
    '<div class="card">' +
    '<div class="question-topic">' + q.topic + '</div>' +
    '<div class="question-text">' + q.question + '</div>' +
    '</div>' +
    '<div class="options-grid">' + choiceHtml + '</div>' +
    explanation;
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
  if (view === 'buy') { renderBuy(); return; }
  if (view === 'refer') { renderReferForm(); return; }
  if (view === 'refund') { renderRefundRequest(); return; }
  if (view === 'redeem') { renderRedeem(); return; }
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

function route() {
  closeHeaderMenuIfOpen(); // runs on every hash/pathname change -- the drawer isn't re-rendered
                            // by a route change (renderSiteHeader() only runs a handful of times
                            // per session), so it needs to close itself independently.
  var hashView = (location.hash || '').replace('#/', '');
  if (hashView === 'terms') { renderTerms(); return; }
  if (hashView === 'privacy') { renderPrivacy(); return; }
  if (hashView === 'contact') { renderContact(); return; }
  if (hashView === 'guarantee') { renderGuarantee(); return; }
  if (hashView === 'profile') { renderProfile(); return; }
  if (location.pathname === '/' || location.pathname === '') renderHub();
  else {
    var track = activeTrackForPath(location.pathname);
    if (track) { state.examType = track.examType; renderTrackApp(); }
    else renderHub();
  }
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
  if (act === 'stripe-pay-submit') {
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
      renderSiteHeader();
      state.examType = res.examType;
      accountExamType = res.examType;
      var local = loadLocalPrefs();
      applyTheme(local.theme, local.fontScale);
      location.hash = '#/quiz';
      renderTrackApp();
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
  }
});

document.addEventListener('change', function (e) {
  if (e.target && e.target.name === 'claimType') {
    var failureFields = document.getElementById('refund-failure-fields');
    if (failureFields) failureFields.classList.toggle('shown', e.target.value === 'exam_failure_50pct');
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
  if (act === 'listen') {
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
  } else if (act === 'sample-answer') {
    sampleState.answered = el.getAttribute('data-choice');
    drawSampleQuestion();
  } else if (act === 'sample-next') {
    sampleState.index += 1;
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
  } else if (act === 'toggle-hub-tracks') {
    hubTracksExpanded = !hubTracksExpanded;
    var hubTracksWrap = document.getElementById('hub-tracks-grid-wrap');
    if (hubTracksWrap) hubTracksWrap.innerHTML = hubTracksGridHtml();
  } else if (act === 'filter-hub-state') {
    var newStateFilter = el.getAttribute('data-state');
    if (newStateFilter === hubStateFilter) return;
    hubStateFilter = newStateFilter;
    hubTracksExpanded = false; // fresh filter, start collapsed again rather than carry over stale expand state
    var filterWrap = document.getElementById('hub-state-filter-wrap');
    if (filterWrap) filterWrap.innerHTML = renderHubStateFilterPills();
    var kindFilterWrap = document.getElementById('hub-kind-filter-wrap');
    if (kindFilterWrap) kindFilterWrap.innerHTML = renderHubKindFilterPills(); // its counts depend on the state filter too
    var filteredTracksWrap = document.getElementById('hub-tracks-grid-wrap');
    if (filteredTracksWrap) filteredTracksWrap.innerHTML = hubTracksGridHtml();
  } else if (act === 'filter-hub-kind') {
    var newKindFilter = el.getAttribute('data-kind');
    if (newKindFilter === hubKindFilter) return;
    hubKindFilter = newKindFilter;
    hubTracksExpanded = false;
    var kindWrap = document.getElementById('hub-kind-filter-wrap');
    if (kindWrap) kindWrap.innerHTML = renderHubKindFilterPills();
    var stateFilterWrap = document.getElementById('hub-state-filter-wrap');
    if (stateFilterWrap) stateFilterWrap.innerHTML = renderHubStateFilterPills(); // its counts depend on the kind filter too
    var kindFilteredTracksWrap = document.getElementById('hub-tracks-grid-wrap');
    if (kindFilteredTracksWrap) kindFilteredTracksWrap.innerHTML = hubTracksGridHtml();
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
  } else if (act === 'toggle-theme') {
    var nextTheme = el.getAttribute('data-next');
    var local = loadLocalPrefs();
    saveLocalPrefs(nextTheme, local.fontScale);
    applyTheme(nextTheme, local.fontScale);
    updateThemeButton();
    if (getToken()) apiFetch('/prefs', { method: 'POST', body: { theme: nextTheme } }).catch(function () {});
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
    var unlockTextEl = document.getElementById('landing-preview-unlock-text');
    if (unlockTextEl) unlockTextEl.textContent = 'Unlock the full ' + previewTabKey + ' for this track';
  } else if (act === 'copy-code') {
    var codeVal = el.getAttribute('data-code');
    if (navigator.clipboard) navigator.clipboard.writeText(codeVal).catch(function () {});
    el.textContent = 'Copied!';
    setTimeout(function () { el.textContent = 'Copy code'; }, 1500);
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
    renderResourcesTable();
  } else if (act === 'toggle-resource-media') {
    var toggleIdx = Number(el.getAttribute('data-index'));
    var opening = resourcesOpenIndex !== toggleIdx;
    resourcesOpenIndex = opening ? toggleIdx : null;
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
  loadSiteConfig().then(renderSiteFooter);
  // Must know which track the token (if any) actually belongs to BEFORE the first render, or
  // isLoggedInForCurrentTrack() would wrongly read as "not logged in" for a moment (accountExamType
  // still null) on every fresh page load -- resolves near-instantly when there's no token.
  loadAccountExamType().then(route);
})();
