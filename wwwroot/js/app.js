// Vanilla JS, no framework/bundler. Hash-routed within /notary; pathname-routed at the top level.
var appEl = document.getElementById('app');
var state = { question: null, answered: null, examType: 'notary', quizDifficulty: localStorage.getItem('examprep_quiz_difficulty') || '' };
var QUIZ_DIFFICULTIES = [['', 'All'], ['easy', 'Easy'], ['moderate', 'Moderate'], ['hard', 'Hard'], ['extremely_hard', 'Extremely Hard']];
// Off by default -- matches pre-existing behavior unless the user opts in. Persisted like the
// difficulty filter. quizRenderToken invalidates any pending auto-advance timer as soon as a new
// question loads through ANY path (manual Next click, tab re-entry, difficulty change, ...), so
// a stale timer can never yank the user forward into a question they didn't mean to skip to.
var quizAutoAdvance = localStorage.getItem('examprep_quiz_autoadvance') === '1';
var quizRenderToken = 0;
var QUIZ_AUTO_ADVANCE_DELAY_MS = 700; // long enough to register "Correct!" before moving on
// Exam mode never reveals correct/incorrect, so this one's simpler: advance regardless of the
// answer, right after the /exam/answer save completes -- no artificial delay needed, the
// network round-trip already gives a brief natural pause before the screen changes.
var examAutoAdvance = localStorage.getItem('examprep_exam_autoadvance') === '1';
var sampleState = { questions: null, index: 0, answered: null };
var recognition = null;
var isRecording = false;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
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

function applyTheme(theme, fontScale) {
  var root = document.documentElement;
  if (theme && theme !== 'system') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  if (fontScale) root.style.setProperty('--font-scale', fontScale);
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

function renderSiteHeader() {
  var logo = '<a href="/" class="site-logo">' +
    '<span class="site-logo-icon">' +
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path>' +
    '</svg></span>' +
    '<span class="site-logo-text"><span class="site-logo-word">EXAM<span class="site-logo-accent">PREP</span></span>' +
    '<span class="site-logo-tagline">Licensing Questionnaire Portal</span></span>' +
    '</a>';

  document.getElementById('site-header').innerHTML =
    '<div class="site-shell top-controls">' +
    logo +
    '<div class="control-group">' +
    '<span class="muted font-label">Font:</span>' +
    '<div class="font-size-pill">' +
    '<button data-act="font-down">A-</button>' +
    '<button data-act="font-up">A+</button>' +
    '</div>' +
    '<button class="btn-secondary btn-sm" id="theme-toggle-btn" data-act="toggle-theme"></button>' +
    '</div></div>';
  updateThemeButton();
}

function updateThemeButton() {
  var local = loadLocalPrefs();
  var nextTheme = local.theme === 'light' ? 'dark' : 'light';
  var btn = document.getElementById('theme-toggle-btn');
  if (!btn) return;
  // Label shows what clicking WILL switch to (the destination), not the current theme.
  btn.textContent = nextTheme === 'dark' ? '🌙 Dark' : '☀️ Light';
  btn.setAttribute('data-next', nextTheme);
}

var SITE_YEAR = 2026; // static — Date.now() isn't reliably available in this build pipeline

function renderSiteFooter() {
  document.getElementById('site-footer').innerHTML =
    '<div class="site-shell footer-content">' +
    '<div>© ' + SITE_YEAR + ' ExamPrep. All rights reserved.</div>' +
    '<div class="muted">Not affiliated with, endorsed by, or sponsored by the California Secretary of State or any state licensing agency. Practice questions only — passing the real exam isn\'t guaranteed, though we back that risk with our 50% refund guarantee.</div>' +
    '<nav class="footer-links"><a href="#/terms">Terms</a><a href="#/privacy">Privacy</a><a href="/notary#/refund">Refund Request</a></nav>' +
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

function renderUserBar() {
  if (!getToken()) return '';
  return '<div class="user-bar"><div class="user-info"><span class="label">Studying</span>' +
    '<span class="value">California Notary</span></div>' +
    '<button class="btn-secondary btn-sm" data-act="log-out">Log out</button></div>';
}

function renderTerms() {
  appEl.innerHTML = '<h1>Terms of Use</h1>' +
    '<p class="muted">ExamPrep provides original, independently-authored practice questions for exam preparation purposes only. ' +
    'It is not affiliated with, endorsed by, or sponsored by the California Secretary of State or any licensing body. ' +
    'Access codes are non-transferable and grant access to one exam track as specified at purchase. ' +
    'We make no guarantee of passing any official exam.</p>' +
    '<p class="muted">Referral points have no cash value and cannot be redeemed, exchanged, or refunded for cash ' +
    'or any other payment method — they may only be applied toward a course through this site. Points may expire ' +
    'or be adjusted, and the referral program itself may be modified, suspended, or discontinued, at any time. ' +
    'We reserve the right to revoke points or access obtained through fraud, abuse, or violation of these terms.</p>' +
    '<button class="btn-secondary btn-sm" data-act="go-back">← Back</button>';
}

function renderPrivacy() {
  appEl.innerHTML = '<h1>Privacy</h1>' +
    '<p class="muted">We store the minimum needed to run your account: your access code\'s redemption status, ' +
    'your quiz progress, and your theme/font preferences. We only collect an email address if you choose to ' +
    'provide one — for an optional backup copy of your access code at purchase, or to take part in the referral ' +
    'program. If you refer a friend, we use their name/email only to send a one-time confirmation email on your ' +
    'behalf; if you\'re referred by a friend, the same applies to you. We never sell or share this data. ' +
    'Payments are processed by Stripe directly; we don\'t see or store your payment details. Contact whoever ' +
    'issued your code with any privacy questions.</p>' +
    '<button class="btn-secondary btn-sm" data-act="go-back">← Back</button>';
}

// ---- Views --------------------------------------------------------------

var HUB_EXAMS = [
  {
    title: 'California Notary Public Exam', category: 'State Licensing', active: true, route: '/notary',
    duration: '60 Minutes', questions: '45 Multiple Choice', passScore: '70% (Scaled Score 70+)',
    description: 'Practice questions covering the California notary handbook: statutory fees, thumbprint rules, journal requirements, and civil/criminal misconduct exposure.',
    breakdown: [['Fees, Misconduct & Conflict of Interest', '35%'], ['Common Questions & Scenarios', '20%'], ['Acknowledgment, Jurat & Journal', '30%'], ['Application, Commission & Misc', '15%']],
  },
  {
    title: 'California DRE Real Estate Salesperson', category: 'Real Estate Licensing', active: false, route: '#',
    duration: '3 Hours', questions: '150 Multiple Choice', passScore: '70%',
    description: 'California real estate law, disclosures, agency relationships, property ownership, and contracts for state licensure.',
    breakdown: [['Practice & Disclosures', '25%'], ['Agency & Fiduciary Duties', '17%'], ['Ownership & Land Use', '15%'], ['Valuation & Finance', '23%']],
  },
  {
    title: 'NMLS SAFE National MLO Exam', category: 'Mortgage Loan Origination', active: false, route: '#',
    duration: '190 Minutes', questions: '125 Questions (115 Scored)', passScore: '75%',
    description: 'The NMLS National Test Component: federal lending regulations, origination activities, and ethics.',
    breakdown: [['Origination Activities', '27%'], ['Federal Laws & Rules', '24%'], ['General Mortgage Knowledge', '20%'], ['Ethics & Fair Lending', '18%']],
  },
];

function renderHub() {
  var activeCount = HUB_EXAMS.filter(function (e) { return e.active; }).length;
  var upcomingCount = HUB_EXAMS.length - activeCount;

  var cards = HUB_EXAMS.map(function (exam) {
    var statusBadge = exam.active
      ? '<span class="status-badge active"><span class="pulse-dot"></span>Active</span>'
      : '<span class="status-badge">Coming Soon</span>';
    var specs = '<div class="exam-specs">' +
      '<div>⏱️ <strong>Duration:</strong> ' + exam.duration + '</div>' +
      '<div>📄 <strong>Questions:</strong> ' + exam.questions + '</div>' +
      '<div>🏆 <strong>Passing Score:</strong> ' + exam.passScore + '</div>' +
      '</div>';
    var breakdown = '<div class="breakdown-label">Key Breakdown</div><div class="breakdown-list">' +
      exam.breakdown.map(function (b) {
        var pct = parseInt(b[1], 10) || 0;
        return '<div class="breakdown-row">' +
          '<div class="breakdown-row-top"><span>' + b[0] + '</span><span>' + b[1] + '</span></div>' +
          '<div class="breakdown-bar"><div class="breakdown-bar-fill" style="width:' + pct + '%"></div></div>' +
          '</div>';
      }).join('') +
      '</div>';
    var cta = exam.active
      ? '<a class="btn-primary hub-cta" href="' + exam.route + '">Start Questionnaire →</a>' +
        '<a class="btn-secondary hub-cta" href="/notary#/sample">Try a free sample</a>'
      : '<button class="btn-secondary hub-cta" disabled>Coming Soon</button>';

    var newsRibbon = exam.title.indexOf('Notary') !== -1 ? '<div class="exam-track-news-ribbon">New</div>' : '';

    return '<div class="exam-track-card' + (exam.active ? ' is-active' : '') + '">' +
      newsRibbon +
      '<div class="exam-track-body">' +
      '<div class="exam-track-top"><span class="badge">' + exam.category + '</span>' + statusBadge + '</div>' +
      '<h3>' + exam.title + '</h3>' +
      '<p class="muted exam-track-desc">' + exam.description + '</p>' +
      specs + breakdown +
      '</div><div class="exam-track-footer">' + cta + '</div></div>';
  }).join('');

  appEl.innerHTML =
    renderNewsBanner() +
    '<div class="hub-hero">' +
    '<h1>Pass Your California Licensing Exams on the First Try</h1>' +
    '<p>Practice question sets modeled after official state and national licensing standards, with ' +
    'voice-enabled practice and instant online access.</p>' +
    '<div class="hub-trust-badges">' +
    '<span class="hub-trust-badge">✓ 2026 Handbook Aligned</span>' +
    '<span class="hub-trust-badge">✓ Voice-Enabled Practice</span>' +
    '<span class="hub-trust-badge">✓ Instant Access</span>' +
    '</div>' +
    '<div class="hub-hero-cta">' +
    '<a class="btn-primary hub-hero-btn" href="/notary#/sample">Try Free Sample</a>' +
    '<button class="btn-secondary hub-hero-btn" type="button" data-act="scroll-to-tracks">Browse All Tracks</button>' +
    '</div>' +
    '<p class="muted hub-hero-subtext">Already have a code? <a href="/notary">Enter it here</a> · ' +
    'No code yet? <a href="/notary#/buy">Buy instant access</a> or <a href="/notary#/refer">refer friends for free access</a></p>' +
    '</div>' +
    '<div class="hub-section-header" id="tracks"><h2>Licensing Tracks</h2>' +
    '<span class="badge">' + activeCount + ' Active • ' + upcomingCount + ' Upcoming</span></div>' +
    '<div class="exam-track-grid">' + cards + '</div>';
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
  // Quiz/Exam/Progress are shown to everyone (with a 🔒 marker when logged out) so an anonymous
  // visitor gets a sense of the layout -- clicking one still only shows a locked preview, never
  // the real content/data (see renderLockedTabPreview and the guard in renderNotaryApp).
  var loggedIn = !!getToken();
  var gated = { quiz: true, exam: true, progress: true };
  var tabs = [['resources', 'Resources'], ['quiz', 'Quiz'], ['exam', 'Exam'], ['progress', 'Progress'], ['info', 'Additional Information']];
  return renderNewsBanner() + '<nav class="tabs">' + tabs.map(function (t) {
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

// `free: true` = viewable/playable without an access code (a hand-picked promotional sample).
// This flag is presentation-only -- the real gate is the server's own FREE_RESOURCES allowlist
// in examprep-api, which must be kept in sync with this list by filename.
// `topic` maps each resource to the closest matching exam-breakdown category from HUB_EXAMS
// below (or 'General Reference' for resources that span everything) -- a best-effort call based
// on title/description, not verified against the actual audio/video content, so treat it as a
// starting point to adjust rather than an authoritative tag.
var RESOURCES = {
  notary: [
    { title: 'Official California Notary Public Handbook', type: 'pdf', url: 'https://notary.cdn.sos.ca.gov/forms/notary-handbook-current.pdf',
      desc: 'The official handbook published by the California Secretary of State — the authoritative source the exam is based on.',
      topic: 'General Reference', free: true },
    { title: 'The Power Behind California Notary Stamps', type: 'audio', file: 'The_Power_Behind_California_Notary_Stamps.m4a',
      desc: 'A guided audio walkthrough of what your notary seal legally represents and how it’s misused.',
      topic: 'Fees, Misconduct & Conflict of Interest', sizeBytes: 109485209 },
    { title: 'Legal Minefields for California Notaries', type: 'audio', file: 'Legal_Minefields_for_California_Notaries.m4a',
      desc: 'Common notarial mistakes that carry civil or criminal exposure, explained in plain language.',
      topic: 'Fees, Misconduct & Conflict of Interest', sizeBytes: 104504457 },
    { title: 'Surprising Rules for California Notaries', type: 'video', file: 'Surprising_Rules_for_California_Notaries.mp4',
      desc: 'A short video on lesser-known notary rules that trip up first-time applicants.',
      topic: 'Application, Commission & Misc', sizeBytes: 9272787 },
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
      topic: 'Fees, Misconduct & Conflict of Interest', sizeBytes: 101147484 },
    { title: 'Why Your Signature Is Just Ink', type: 'audio', file: 'Why_your_signature_is_just_ink.m4a',
      desc: 'What actually makes a notarization legally valid beyond the signature itself.',
      topic: 'Acknowledgment, Jurat & Journal', sizeBytes: 77632701 },
    { title: 'California Notary Fee Schedule', type: 'table', table: NOTARY_FEE_TABLE,
      desc: 'Maximum statutory fees by service type, with legal exceptions and code citations — a common exam topic.',
      topic: 'Fees, Misconduct & Conflict of Interest', free: true },
    { title: 'California Notary Violations & Enforcement Table', type: 'table', table: NOTARY_FINES_TABLE,
      desc: 'Common violations with legal references, administrative sanctions, civil penalties, and criminal classifications — a common exam topic.',
      topic: 'Fines and Enforcements' },
    { title: 'California Notary Rules', type: 'video', file: 'California_Notary_Rules.mp4',
      desc: 'A video overview of key California notary rules every applicant should know.',
      topic: 'Application, Commission & Misc', sizeBytes: 29605729 },
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
    appEl.innerHTML = renderUserBar() + renderTabs('resources') +
      '<p class="muted">No study resources yet for this exam track.</p>';
    return;
  }

  var loggedIn = !!getToken();
  appEl.innerHTML = renderUserBar() + renderTabs('resources') + '<p class="muted">Loading…</p>';

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
    appEl.innerHTML = renderUserBar() + renderTabs('resources') +
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

  var intro = loggedIn
    ? '<p class="muted resources-intro">Guided material to go with your practice questions.</p>'
    : '';
  appEl.innerHTML = renderUserBar() + renderTabs('resources') + intro +
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
    probe.style.cssText = 'position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; top:-9999px;';
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

function sortedResourceRows() {
  var rows = resourcesRowsCache.slice();
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

  var loggedIn = !!getToken();
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
        (row.downloadable ? '' : ' controlsList="nodownload" oncontextmenu="return false"') + ' src="' + row.url + '"></audio>';
    } else if (row.type === 'video') {
      inner = '<video class="resource-player" controls autoplay preload="metadata" data-resource-key="' + row.resourceKey + '" data-resource-type="video"' +
        (row.downloadable ? '' : ' controlsList="nodownload" oncontextmenu="return false"') + ' src="' + row.url + '"></video>';
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

  container.innerHTML = '<div class="resource-table-scroll"><table class="resource-table resources-index-table">' +
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
  appEl.innerHTML = renderUserBar() + renderTabs('quiz') + '<p class="muted">Loading question…</p>';
  try {
    var qs = state.quizDifficulty ? '?difficulty=' + state.quizDifficulty : '';
    state.question = await apiFetch('/questions/next' + qs);
    state.answered = null;
    drawQuestion();
  } catch (e) {
    appEl.innerHTML = renderUserBar() + renderTabs('quiz') + '<p>Could not load a question. Try again shortly.</p>';
  }
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

  appEl.innerHTML = renderUserBar() + renderTabs('quiz') +
    '<div class="quiz-controls-row">' + renderQuizDifficultyPicker() + renderQuizAutoAdvanceToggle() + '</div>' +
    '<div class="card">' +
    '<div class="question-topic">' + q.topic + '</div>' +
    '<div class="question-text">' + q.question + '</div>' +
    '<div class="audio-actions"><button class="btn-secondary btn-sm" data-act="listen">🔊 Read aloud</button></div>' +
    '</div>' +
    '<div class="options-grid">' + choiceHtml + '</div>' +
    explanation + micZone + nav;

  setupMic();
}

var progressByTopic = null; // stashed so the table can be re-sorted without a re-fetch
var progressSort = { key: 'topic', dir: 'asc' };
var progressTopicsExpanded = false; // collapsed by default -- a full topic list (30+ rows for
// notary) otherwise pushes the wrong-questions section below the fold, especially on mobile.
var PROGRESS_TOPICS_COLLAPSED_COUNT = 5;

function progressTopicPct(t) { return t.total ? Math.round((100 * t.correct) / t.total) : 0; }

function progressTopicsTableHtml() {
  var key = progressSort.key, dir = progressSort.dir;
  var sorted = (progressByTopic || []).slice().sort(function (a, b) {
    var av = key === 'pct' ? progressTopicPct(a) : key === 'total' ? a.total : a.topic.toLowerCase();
    var bv = key === 'pct' ? progressTopicPct(b) : key === 'total' ? b.total : b.topic.toLowerCase();
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  var truncated = !progressTopicsExpanded && sorted.length > PROGRESS_TOPICS_COLLAPSED_COUNT;
  var visible = truncated ? sorted.slice(0, PROGRESS_TOPICS_COLLAPSED_COUNT) : sorted;
  var arrow = function (k) { return key === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''; };
  var rows = visible.map(function (t) {
    return '<tr><td>' + t.topic + '</td><td>' + progressTopicPct(t) + '%</td><td>' + t.total + '</td></tr>';
  }).join('');
  var toggleHtml = sorted.length > PROGRESS_TOPICS_COLLAPSED_COUNT
    ? '<button class="btn-secondary btn-sm progress-topics-toggle" type="button" data-act="toggle-progress-topics">' +
      (truncated ? 'Show all ' + sorted.length + ' topics ▾' : 'Show fewer ▴') + '</button>'
    : '';
  return '<table class="progress-topics-table"><thead><tr>' +
    '<th data-act="sort-progress-topics" data-sort-key="topic">Topic' + arrow('topic') + '</th>' +
    '<th data-act="sort-progress-topics" data-sort-key="pct">Accuracy' + arrow('pct') + '</th>' +
    '<th data-act="sort-progress-topics" data-sort-key="total">Questions' + arrow('total') + '</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' + toggleHtml;
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
  appEl.innerHTML = renderUserBar() + renderTabs('progress') + '<p class="muted">Loading…</p>';
  progressResetPending = null; // a fresh load (e.g. after a reset) always starts from the unconfirmed state
  var p = await apiFetch('/progress');
  var pct = p.totalAnswered ? Math.round((100 * p.totalCorrect) / p.totalAnswered) : 0;
  var wrong = p.totalAnswered - p.totalCorrect;
  progressByTopic = p.byTopic;

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
    return '<details class="card mockexam-review-item">' +
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

  appEl.innerHTML = renderUserBar() + renderTabs('progress') +
    '<div class="stats-bar">' +
    '<div class="stat-box"><div class="label">Total</div><div class="val">' + p.totalAnswered + '</div></div>' +
    '<div class="stat-box"><div class="label">Correct</div><div class="val correct">' + p.totalCorrect + '</div></div>' +
    '<div class="stat-box"><div class="label">Wrong</div><div class="val wrong">' + wrong + '</div></div>' +
    '<div class="stat-box"><div class="label">Accuracy</div><div class="val accuracy">' + pct + '%</div></div>' +
    '</div>' +
    '<div id="progress-topics-wrap">' + progressTopicsTableHtml() + '</div>' +
    wrongQuestionsSection +
    '<div id="progress-reset-wrap">' + progressResetSectionHtml() + '</div>';
}

// ---- Locked previews (Quiz/Exam/Progress, logged-out visitors) -----------
// Real content/data always requires a token -- these are non-interactive mockups purely so an
// anonymous visitor can see what each tab looks like before buying/referring their way in.

function renderLockedTabPreview(tabKey, title, mockupHtml, blurb, extraCta) {
  appEl.innerHTML = renderUserBar() + renderTabs(tabKey) +
    '<h1>' + title + '</h1>' +
    '<div class="locked-preview-wrap">' +
    '<div class="locked-preview-mockup" aria-hidden="true" inert>' + mockupHtml + '</div>' +
    '<div class="locked-preview-overlay">' +
    '<div class="locked-preview-icon">🔒</div>' +
    '<p>' + blurb + '</p>' +
    '<div class="sample-done-cta">' +
    '<a class="btn-primary hub-cta" href="#/buy">Unlock full access →</a>' +
    '<a class="btn-secondary hub-cta" href="#/refer">Refer & earn free access →</a>' +
    (extraCta || '') +
    '</div>' +
    '</div>' +
    '</div>';
}

function renderLockedQuizPreview() {
  var mockup = '<div class="card">' +
    '<div class="question-topic">Sample Topic</div>' +
    '<div class="question-text">This is what a real practice question looks like — topic, question text, then four lettered choices.</div>' +
    '</div>' +
    '<div class="options-grid">' + ['A', 'B', 'C', 'D'].map(function (k) {
      return optionButtonHtml(k, 'Answer choice ' + k, 'option-btn', 'disabled');
    }).join('') + '</div>' +
    '<div class="mic-zone"><button class="btn-mic" disabled>🎙️ Voice Answer</button></div>';
  renderLockedTabPreview('quiz', 'Quiz',
    mockup,
    'Sign in or unlock full access to start practicing with the real question bank — voice answers included.',
    '<a class="btn-secondary hub-cta" href="#/sample">Try 5 free sample questions →</a>');
}

function renderLockedExamPreview() {
  // Same numbers HUB_EXAMS already shows publicly on the landing page -- no account/API call
  // needed just to preview what the timed exam looks like.
  var mockup = '<div class="card mockexam-intro-card">' +
    '<p>This mimics the real exam format as closely as possible:</p>' +
    '<ul class="mockexam-intro-list">' +
    '<li><strong>45 questions</strong>, drawn at random from the full question bank</li>' +
    '<li><strong>60-minute</strong> timer, running continuously in one sitting</li>' +
    '<li>No answer feedback until you finish — just like the real thing</li>' +
    '<li>Need <strong>70%</strong> to pass (a practice approximation of the real scaled-score-70 requirement)</li>' +
    '</ul>' +
    '<button class="btn-primary" type="button" disabled>Begin Exam →</button>' +
    '</div>';
  renderLockedTabPreview('exam', 'Timed Practice Exam',
    mockup,
    'Sign in or unlock full access to take the real timed mock exam.');
}

function renderLockedProgressPreview() {
  var mockup = '<div class="stats-bar">' +
    '<div class="stat-box"><div class="label">Total</div><div class="val">42</div></div>' +
    '<div class="stat-box"><div class="label">Correct</div><div class="val correct">31</div></div>' +
    '<div class="stat-box"><div class="label">Wrong</div><div class="val wrong">11</div></div>' +
    '<div class="stat-box"><div class="label">Accuracy</div><div class="val accuracy">74%</div></div>' +
    '</div>' +
    '<table class="progress-topics-table"><thead><tr><th>Topic ▲</th><th>Accuracy</th><th>Questions</th></tr></thead>' +
    '<tbody>' +
    '<tr><td>Acknowledgment, Jurat &amp; Journal</td><td>69%</td><td>14</td></tr>' +
    '<tr><td>Fees, Misconduct &amp; Conflict of Interest</td><td>78%</td><td>18</td></tr>' +
    '</tbody></table>' +
    '<h3 class="mockexam-review-heading">Questions you got wrong (11)</h3>' +
    '<details class="card mockexam-review-item"><summary>Fees — A notary is asked to notarize…</summary></details>';
  renderLockedTabPreview('progress', 'Progress',
    mockup,
    'Sign in or unlock full access to track your own real progress by topic, and review every question you got wrong.');
}

// ---- Additional information (official external links, per exam type) -----

var ADDITIONAL_INFO_LINKS = {
  notary: [
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
  appEl.innerHTML = renderUserBar() + renderTabs('info') +
    '<h1>Additional Information</h1>' +
    '<p class="muted page-intro-text">Official, outside resources for the real exam — registration, scheduling, and state program details.</p>' +
    linkCards;
}

// ---- Timed mock exam --------------------------------------------------
// A single-sitting, timed simulation of the real exam -- no per-question feedback, free
// navigation between questions, and a countdown clock computed from the server's own
// startedAt (not a client-only timer), so a refresh mid-sitting resumes in place rather than
// restarting the clock or handing out a fresh question set.

var examState = { attempt: null, config: null, currentIndex: 0, timerHandle: null };

async function renderExam() {
  appEl.innerHTML = renderUserBar() + renderTabs('exam') + '<p class="muted">Loading…</p>';
  try {
    var current = await apiFetch('/exam/current');
    if (current.attempt) { enterExamSitting(current.attempt); return; }
    await renderExamIntro();
  } catch (e) {
    appEl.innerHTML = renderUserBar() + renderTabs('exam') + '<p>Could not load the exam. Try again shortly.</p>';
  }
}

async function renderExamIntro() {
  var config = await apiFetch('/exam/config');
  examState.config = config;
  appEl.innerHTML = renderUserBar() + renderTabs('exam') +
    '<h1>Timed Practice Exam</h1>' +
    '<div class="card mockexam-intro-card">' +
    '<p>This mimics the real exam format as closely as possible:</p>' +
    '<ul class="mockexam-intro-list">' +
    '<li><strong>' + config.questionCount + ' questions</strong>, drawn at random from the full question bank</li>' +
    '<li><strong>' + Math.round(config.durationSec / 60) + '-minute</strong> timer, running continuously in one sitting</li>' +
    '<li>No answer feedback until you finish — just like the real thing</li>' +
    '<li>Need <strong>' + config.passPercent + '%</strong> to pass (a practice approximation of the real scaled-score-70 requirement)</li>' +
    '</ul>' +
    '<p class="muted">Once started, the clock keeps running even if you close this tab — reopening it will resume ' +
    'right where you left off, not restart. There\'s no pausing.</p>' +
    '<button class="btn-primary" type="button" data-act="exam-begin">Begin Exam →</button>' +
    '<a class="btn-secondary exam-history-link" href="#/exam-history">View past attempts →</a>' +
    '</div>';
}

async function renderExamHistory() {
  appEl.innerHTML = renderUserBar() + renderTabs('exam') + '<p class="muted">Loading past attempts…</p>';
  try {
    var res = await apiFetch('/exam/history');
    if (!res.attempts.length) {
      appEl.innerHTML = renderUserBar() + renderTabs('exam') + '<h1>Past Attempts</h1>' +
        '<p class="muted">You haven\'t completed a practice exam yet.</p>' +
        '<a class="btn-primary hub-cta" href="#/exam">Take one now →</a>';
      return;
    }
    var rows = res.attempts.map(function (a) {
      var date = new Date(a.submittedAt * 1000).toLocaleString();
      return '<a class="card exam-history-row" href="#/exam-history/' + a.attemptId + '">' +
        '<span>' + date + '</span>' +
        '<span>' + a.correct + ' / ' + a.total + '</span>' +
        '<span class="' + (a.passed ? 'result-correct' : 'result-incorrect') + '">' + a.percent + '% — ' + (a.passed ? 'Passed' : 'Not passed') + '</span>' +
        '</a>';
    }).join('');
    appEl.innerHTML = renderUserBar() + renderTabs('exam') +
      '<h1>Past Attempts</h1>' +
      '<p class="muted page-intro-text">Every practice exam you\'ve completed, most recent first. Tap one to review your answers.</p>' +
      '<div class="exam-history-list">' + rows + '</div>' +
      '<a class="btn-secondary hub-cta" href="#/exam">← Back to exam</a>';
  } catch (e) {
    appEl.innerHTML = renderUserBar() + renderTabs('exam') + '<p>Could not load your past attempts. Try again shortly.</p>';
  }
}

async function renderExamAttemptDetailView(attemptId) {
  appEl.innerHTML = renderUserBar() + renderTabs('exam') + '<p class="muted">Loading…</p>';
  try {
    var result = await apiFetch('/exam/attempt?attemptId=' + encodeURIComponent(attemptId));
    renderExamResults(result, { fromHistory: true });
  } catch (e) {
    appEl.innerHTML = renderUserBar() + renderTabs('exam') + '<p>Could not load this attempt.</p>' +
      '<a class="btn-secondary hub-cta" href="#/exam-history">← Back to past attempts</a>';
  }
}

async function beginExam() {
  appEl.innerHTML = renderUserBar() + renderTabs('exam') + '<p class="muted">Starting…</p>';
  try {
    var attempt = await apiFetch('/exam/start', { method: 'POST' });
    enterExamSitting(attempt);
  } catch (e) {
    appEl.innerHTML = renderUserBar() + renderTabs('exam') + '<p>Could not start the exam. Try again shortly.</p>';
  }
}

function enterExamSitting(attempt) {
  examState.attempt = attempt;
  examState.currentIndex = 0;
  drawExamSitting();
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

function drawExamSitting() {
  var attempt = examState.attempt;
  var q = attempt.questions[examState.currentIndex];
  var answeredCount = Object.keys(attempt.answers).length;

  var navGrid = attempt.questions.map(function (question, i) {
    var cls = 'mockexam-nav-btn';
    if (i === examState.currentIndex) cls += ' current';
    if (attempt.answers[question.id]) cls += ' answered';
    return '<button type="button" class="' + cls + '" data-act="exam-goto" data-index="' + i + '">' + (i + 1) + '</button>';
  }).join('');

  var choiceHtml = ['A', 'B', 'C', 'D'].map(function (k) {
    var cls = 'option-btn';
    if (attempt.answers[q.id] === k) cls += ' selected';
    return optionButtonHtml(k, q.choices[k], cls, 'type="button" data-act="exam-answer" data-choice="' + k + '"');
  }).join('');

  appEl.innerHTML = renderUserBar() + renderTabs('exam') +
    '<div class="mockexam-header">' +
    '<div>Question ' + (examState.currentIndex + 1) + ' of ' + attempt.questions.length +
    ' — <span class="muted">' + answeredCount + ' answered</span></div>' +
    '<div class="mockexam-timer" id="exam-timer-display">' + formatClock(examSecondsRemaining()) + '</div>' +
    '<label class="auto-advance-toggle">' +
    '<input type="checkbox" data-act="toggle-exam-autoadvance"' + (examAutoAdvance ? ' checked' : '') + '> ' +
    'Auto-advance after I answer</label>' +
    '</div>' +
    '<div class="mockexam-nav-grid">' + navGrid + '</div>' +
    '<div class="card">' +
    '<div class="question-topic">' + q.topic + '</div>' +
    '<div class="question-text">' + q.question + '</div>' +
    '</div>' +
    '<div class="options-grid">' + choiceHtml + '</div>' +
    '<div class="nav-controls mockexam-controls">' +
    '<button class="btn-secondary" type="button" data-act="exam-prev"' + (examState.currentIndex === 0 ? ' disabled' : '') + '>← Previous</button>' +
    '<button class="btn-secondary" type="button" data-act="exam-next"' + (examState.currentIndex === attempt.questions.length - 1 ? ' disabled' : '') + '>Next →</button>' +
    '<button class="btn-primary" type="button" data-act="exam-submit-confirm">Submit Exam</button>' +
    '</div>';
}

async function selectExamAnswer(choice) {
  var attempt = examState.attempt;
  var q = attempt.questions[examState.currentIndex];
  attempt.answers[q.id] = choice;
  drawExamSitting();
  try {
    await apiFetch('/exam/answer', { method: 'POST', body: { attemptId: attempt.attemptId, questionId: q.id, choice: choice } });
  } catch (e) {
    // Best-effort -- if this was a time_expired rejection, the next timer tick (or Submit)
    // will surface it; the locally-saved answer still gets included in the final submit call.
  }
  // Regardless of right/wrong -- the exam never reveals that anyway -- just moves navigation
  // forward one step, same as manually clicking Next →. Stays put on the last question (nothing
  // to advance to; Submit is the natural next action there).
  if (examAutoAdvance && examState.currentIndex < attempt.questions.length - 1) {
    examState.currentIndex++;
    drawExamSitting();
  }
}

async function submitExam() {
  var attempt = examState.attempt;
  if (examState.timerHandle) { clearInterval(examState.timerHandle); examState.timerHandle = null; }
  appEl.innerHTML = renderUserBar() + renderTabs('exam') + '<p class="muted">Scoring your exam…</p>';
  try {
    var result = await apiFetch('/exam/submit', { method: 'POST', body: { attemptId: attempt.attemptId } });
    renderExamResults(result);
  } catch (e) {
    appEl.innerHTML = renderUserBar() + renderTabs('exam') + '<p>Could not submit the exam. Try again shortly.</p>';
  }
}

function renderExamResults(result, opts) {
  opts = opts || {};
  var reviewHtml = result.review.map(function (r, i) {
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
  }).join('');

  var dateNote = opts.fromHistory && result.submittedAt
    ? '<p class="muted">Taken ' + new Date(result.submittedAt * 1000).toLocaleString() + '</p>' : '';
  var ctaHtml = opts.fromHistory
    ? '<a class="btn-secondary hub-cta" href="#/exam-history">← Back to past attempts</a>'
    : '<button class="btn-primary hub-cta" type="button" data-act="exam-restart">Take another practice exam →</button>';

  appEl.innerHTML = renderUserBar() + renderTabs('exam') +
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

function renderBuy() {
  appEl.innerHTML = '<h1>Get instant access</h1><p class="muted">Loading price…</p>';
  apiFetch('/pricing?examType=notary').then(function (p) {
    buyPricing = p;
    drawBuyForm(p);
  }).catch(function () {
    appEl.innerHTML = '<h1>Get instant access</h1><p>Could not load pricing. Try again shortly.</p>';
  });
}

function drawBuyForm(pricing) {
  var priceLabel = '$' + (pricing.priceCents / 100).toFixed(2);
  appEl.innerHTML =
    '<h1>Get instant access</h1>' +
    '<div class="buy-layout">' +
    '<div class="buy-value-col">' +
    '<div class="card buy-order-summary">' +
    '<div class="buy-order-summary-top"><span>California Notary — Full Access</span><span class="buy-order-price">' + priceLabel + '</span></div>' +
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
    '<div class="buy-guarantee-item"><strong>🔄 7-Day, No Questions Asked</strong>' +
    '<p class="muted">Not satisfied? Full refund within 7 days of purchase — no reason needed.</p></div>' +
    '<div class="buy-guarantee-item"><strong>🎯 Pass or 50% Back</strong>' +
    '<p class="muted">Take the real exam and don\'t pass? Get half your money back.</p></div>' +
    '<p class="muted buy-guarantee-footnote"><a href="/notary#/refund">Refund request →</a></p>' +
    '</div>' +
    '</div>' +
    '<div class="buy-payment-col">' +
    '<div class="card">' +
    '<label class="muted buy-email-label">Email Address (to send your instant access receipt & code)</label>' +
    '<input type="email" id="buy-email" placeholder="you@example.com">' +
    '<button class="btn-secondary btn-sm" type="button" data-act="check-points">Check my points</button>' +
    '<div id="points-result"></div>' +
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
    '<p class="muted redeem-sample-hint">Already have a code? <a href="/notary">Enter it here</a></p>';
  renderTurnstileWidget();
  if (STRIPE_PUBLISHABLE_KEY.indexOf('REPLACE') !== -1) {
    var el = document.getElementById('stripe-payment-element');
    if (el) el.innerHTML = '<p class="muted">Payments aren\'t configured yet.</p>';
    return;
  }
  loadStripeSdk(function () { mountStripePaymentElement(); });
}

function updateBuyTotalDisplay() {
  var totalEl = document.getElementById('buy-total');
  if (!totalEl || !buyPricing) return;
  var checkbox = document.getElementById('apply-points-checkbox');
  var applying = !!(checkbox && checkbox.checked);
  var pointsAvailable = checkbox ? Number(checkbox.getAttribute('data-points-available') || 0) : 0;
  var pointsApplied = pointsAvailable;
  var finalCents = buyPricing.priceCents;
  if (applying) {
    finalCents = Math.max(0, buyPricing.priceCents - pointsAvailable);
    // Mirrors the server's floor (see quoteCheckout) so the preview matches what actually gets
    // charged -- a partial discount can't leave less than this payable through the processor.
    var minCents = buyPricing.minPaypalChargeCents || 0;
    if (finalCents > 0 && finalCents < minCents) {
      pointsApplied = Math.max(0, buyPricing.priceCents - minCents);
      finalCents = buyPricing.priceCents - pointsApplied;
    }
  }
  totalEl.textContent = '$' + (finalCents / 100).toFixed(2) + (applying ? ' (' + pointsApplied + ' points applied)' : '');
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
    apiFetch('/stripe/create-intent', {
      method: 'POST', body: { examType: 'notary', turnstileToken: turnstileToken, email: email, applyPoints: applyPoints },
    }).then(function (r) {
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
    }).catch(function () {
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
      method: 'POST', body: { paymentIntentId: result.paymentIntent.id, examType: 'notary', email: email },
    });
    setToken(res.token);
    state.examType = res.examType;
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
    '<p class="muted redeem-sample-hint">Covered by our 7-day refund and pass-or-50%-back guarantees — ' +
    '<a href="#/refund">request one anytime →</a></p>';
}

// ---- Refund requests (7-day unconditional + pass-or-50%-back) -------------

function renderRefundRequest() {
  appEl.innerHTML =
    '<div class="refer-page">' +
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
    '<span><strong>Pass or 50% Back</strong><br><span class="muted">Half refund if you took and failed the real exam.</span></span></label>' +
    '</div>' +
    '<div id="refund-failure-fields" class="refund-failure-fields" style="display:none">' +
    '<label class="muted buy-email-label">Exam date</label>' +
    '<input type="date" name="examDate">' +
    '<label class="muted buy-email-label refund-field-spacing">Confirmation/candidate ID (optional)</label>' +
    '<input type="text" name="confirmationNote" placeholder="e.g. your CPS HR confirmation number">' +
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

function renderReferFriendRow(idx) {
  return '<div class="referred-friend-row" data-row-index="' + idx + '">' +
    '<input type="text" class="referred-friend-name" placeholder="Friend\'s name">' +
    '<input type="email" class="referred-friend-email" placeholder="friend@example.com" required>' +
    (idx > 0
      ? '<button type="button" class="btn-secondary btn-sm" data-act="remove-referred-friend" data-row-index="' + idx + '">✕</button>'
      : '') +
    '</div>';
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
    var results = await Promise.all([apiFetch('/points/rules'), apiFetch('/pricing?examType=notary')]);
    rules = results[0];
    pricing = results[1];
  } catch (e) { /* use the fallback defaults above */ }
  var required = pricing.priceCents;

  appEl.innerHTML =
    '<div class="refer-page">' +
    '<h1>Refer friends, earn free access</h1>' +
    '<p class="muted page-intro-text">Earn <strong>' + rules.referralVerifiedPoints + ' points</strong> when a friend confirms their email, ' +
    'plus <strong>' + rules.referralConvertedPoints + ' more</strong> if they go on to buy a course. Reach ' +
    '<strong>' + required + ' points</strong> to unlock the California Notary course completely free.</p>' +
    '<div class="refer-progress">' +
    '<div class="refer-progress-bar"><div class="refer-progress-fill" style="width:0%"></div></div>' +
    '<div class="refer-progress-label muted">0 / ' + required + ' points — <a href="#/buy">check your real balance →</a></div>' +
    '</div>' +
    '<form data-act="refer-submit" class="card">' +
    '<div class="refer-name-email-grid">' +
    '<div><label class="muted buy-email-label">Your name</label>' +
    '<input type="text" name="referrerName" placeholder="Your name" value="' + escapeHtml(referrerInfo.name) + '"></div>' +
    '<div><label class="muted buy-email-label">Your email</label>' +
    '<input type="email" name="referrerEmail" placeholder="you@example.com" value="' + escapeHtml(referrerInfo.email) + '" required></div>' +
    '</div>' +
    '<label class="muted buy-email-label">Friends to refer</label>' +
    '<div id="referred-friends-list">' + renderReferFriendRow(0) + '</div>' +
    '<button class="btn-secondary btn-sm" type="button" data-act="add-referred-friend">+ Add another friend</button>' +
    '<div id="turnstile-container"></div>' +
    '<button class="btn-primary" type="submit">Send referrals</button>' +
    '</form>' +
    '</div>';
  renderTurnstileWidget();
}

function renderReferVerify(token) {
  appEl.innerHTML = '<h1>Confirming…</h1><p class="muted">One moment.</p>';
  apiFetch('/referrals/verify?token=' + encodeURIComponent(token)).then(function (res) {
    var msg = res.alreadyVerified
      ? 'This referral was already confirmed — thanks!'
      : 'Thanks for confirming — your friend just earned points because of you.';
    appEl.innerHTML =
      '<div class="card refer-confirmed-card">' +
      '<div class="refer-confirmed-emoji">🎉</div>' +
      '<h1>You\'re confirmed!</h1>' +
      '<p class="muted">' + msg + '</p>' +
      '<div class="sample-done-cta">' +
      '<a class="btn-primary hub-cta" href="#/sample">Try 5 free sample questions →</a>' +
      '<a class="btn-secondary hub-cta" href="#/refer">Refer your own friends & earn free access →</a>' +
      '</div></div>';
  }).catch(function () {
    appEl.innerHTML = '<h1>Something went wrong</h1><p class="muted">This link may be invalid or expired.</p>';
  });
}

function renderPointsRedeemVerify(token) {
  appEl.innerHTML = '<h1>Confirming…</h1><p class="muted">One moment.</p>';
  apiFetch('/points/redeem-verify?token=' + encodeURIComponent(token)).then(function (res) {
    setToken(res.token);
    state.examType = res.examType;
    var local = loadLocalPrefs();
    applyTheme(local.theme, local.fontScale);
    renderPurchaseSuccess(res.code);
  }).catch(function (err) {
    var code = err.data && err.data.error;
    var msg = code === 'insufficient_points'
      ? 'Your points balance changed before this was confirmed, so it could no longer be redeemed.'
      : 'This link may be invalid, already used, or expired (links are only good for 30 minutes).';
    appEl.innerHTML = '<h1>Could not redeem</h1><p class="muted">' + msg + '</p>' +
      '<a class="btn-secondary hub-cta" href="#/buy">Back to purchase page</a>';
  });
}

// ---- Free sample (no access code needed) -----------------------------------

async function renderSample() {
  appEl.innerHTML = '<h1>Try a free sample</h1>' +
    '<p class="muted">5 questions, no access code needed.</p><p class="muted">Loading…</p>';
  if (!sampleState.questions) {
    try {
      var res = await apiFetch('/sample?examType=notary');
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
      '<a class="btn-primary hub-cta" href="/notary">Enter access code →</a>' +
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

async function renderNotaryApp() {
  var hadExplicitHash = !!location.hash; // so "no hash yet" keeps defaulting to the redeem page,
                                          // not the quiz view's fallback lock-preview, for anon visitors
  var view = (location.hash || '#/quiz').replace('#/', '');
  if (view === 'sample') { await renderSample(); return; }
  if (view === 'buy') { renderBuy(); return; }
  if (view === 'refer') { renderReferForm(); return; }
  if (view === 'refund') { renderRefundRequest(); return; }
  if (view.indexOf('refer-verify/') === 0) { renderReferVerify(view.slice('refer-verify/'.length)); return; }
  if (view.indexOf('points-redeem-verify/') === 0) { renderPointsRedeemVerify(view.slice('points-redeem-verify/'.length)); return; }
  if (view === 'resources') { await renderResources(); return; } // partially public — see renderResources()
  if (view === 'info') { renderAdditionalInfo(); return; } // fully public
  if (!getToken()) {
    if (hadExplicitHash && view === 'quiz') { renderLockedQuizPreview(); return; }
    if (view === 'exam' || view.indexOf('exam-history') === 0) { renderLockedExamPreview(); return; }
    if (view === 'progress') { renderLockedProgressPreview(); return; }
    renderRedeem(); return;
  }
  if (view === 'quiz') await renderQuiz();
  else if (view === 'exam') await renderExam();
  else if (view === 'exam-history') await renderExamHistory();
  else if (view.indexOf('exam-history/') === 0) await renderExamAttemptDetailView(view.slice('exam-history/'.length));
  else if (view === 'progress') await renderProgress();
  else await renderQuiz();
}

function route() {
  var hashView = (location.hash || '').replace('#/', '');
  if (hashView === 'terms') { renderTerms(); return; }
  if (hashView === 'privacy') { renderPrivacy(); return; }
  if (location.pathname === '/' || location.pathname === '') renderHub();
  else if (location.pathname.indexOf('/notary') === 0) renderNotaryApp();
  else renderHub();
}

window.addEventListener('hashchange', route);
window.addEventListener('popstate', route);

// ---- Answer handling (shared by click + voice) -----------------------------

async function submitAnswer(choice) {
  if (state.answered) return;
  var res = await apiFetch('/answer', { method: 'POST', body: { questionId: state.question.id, choice: choice } });
  state.answered = { picked: choice, correct: res.correct, correctChoice: res.correctChoice, explanation: res.explanation };
  drawQuestion();

  if (res.correct && quizAutoAdvance) {
    var tokenAtSchedule = quizRenderToken;
    setTimeout(function () {
      // Only advance if nothing else has already loaded a new question in the meantime (manual
      // Next click, tab switch and back, difficulty change, ...) -- renderQuiz() bumps the token
      // on every call, so a stale timer just becomes a no-op instead of yanking the user forward.
      if (quizRenderToken === tokenAtSchedule) renderQuiz();
    }, QUIZ_AUTO_ADVANCE_DELAY_MS);
  }
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
      state.examType = res.examType;
      var local = loadLocalPrefs();
      applyTheme(local.theme, local.fontScale);
      location.hash = '#/quiz';
      renderNotaryApp();
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
  }
});

document.addEventListener('change', function (e) {
  if (e.target && e.target.name === 'claimType') {
    var failureFields = document.getElementById('refund-failure-fields');
    if (failureFields) failureFields.style.display = e.target.value === 'exam_failure_50pct' ? '' : 'none';
  }
});

document.addEventListener('click', async function (e) {
  var el = e.target.closest && e.target.closest('[data-act]');
  if (!el) return;
  var act = el.getAttribute('data-act');
  if (act === 'listen') {
    var text = state.question.question + '. ' +
      ['A', 'B', 'C', 'D'].map(function (k) { return k + '. ' + state.question.choices[k]; }).join('. ');
    speak(text);
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
  } else if (act === 'toggle-quiz-autoadvance') {
    quizAutoAdvance = el.checked;
    localStorage.setItem('examprep_quiz_autoadvance', quizAutoAdvance ? '1' : '0');
  } else if (act === 'toggle-exam-autoadvance') {
    examAutoAdvance = el.checked;
    localStorage.setItem('examprep_exam_autoadvance', examAutoAdvance ? '1' : '0');
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
  } else if (act === 'sort-progress-topics') {
    var sortKey = el.getAttribute('data-sort-key');
    if (progressSort.key === sortKey) progressSort.dir = progressSort.dir === 'asc' ? 'desc' : 'asc';
    else { progressSort.key = sortKey; progressSort.dir = sortKey === 'topic' ? 'asc' : 'desc'; }
    var topicsWrap = document.getElementById('progress-topics-wrap');
    if (topicsWrap) topicsWrap.innerHTML = progressTopicsTableHtml();
  } else if (act === 'toggle-progress-topics') {
    progressTopicsExpanded = !progressTopicsExpanded;
    var toggleWrap = document.getElementById('progress-topics-wrap');
    if (toggleWrap) toggleWrap.innerHTML = progressTopicsTableHtml();
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
    location.hash = '';
    renderNotaryApp();
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
    await beginExam();
  } else if (act === 'exam-goto') {
    examState.currentIndex = Number(el.getAttribute('data-index'));
    drawExamSitting();
  } else if (act === 'exam-prev') {
    examState.currentIndex = Math.max(0, examState.currentIndex - 1);
    drawExamSitting();
  } else if (act === 'exam-next') {
    examState.currentIndex = Math.min(examState.attempt.questions.length - 1, examState.currentIndex + 1);
    drawExamSitting();
  } else if (act === 'exam-answer') {
    await selectExamAnswer(el.getAttribute('data-choice'));
  } else if (act === 'exam-submit-confirm') {
    var unanswered = examState.attempt.questions.length - Object.keys(examState.attempt.answers).length;
    if (unanswered > 0 && !window.confirm(unanswered + ' question' + (unanswered === 1 ? '' : 's') + ' unanswered. Submit anyway?')) return;
    await submitExam();
  } else if (act === 'toggle-wrong-only') {
    var reviewListEl = document.getElementById('mockexam-review-list');
    if (reviewListEl) reviewListEl.classList.toggle('review-wrong-only', el.checked);
  } else if (act === 'sort-resources') {
    var sortKey = el.getAttribute('data-key');
    if (resourcesSort.key === sortKey) resourcesSort.dir *= -1;
    else { resourcesSort.key = sortKey; resourcesSort.dir = 1; }
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
  } else if (act === 'toggle-apply-points') {
    updateBuyTotalDisplay();
    if (document.getElementById('stripe-payment-form')) mountStripePaymentElement();
  } else if (act === 'check-points') {
    var pointsEmailEl = document.getElementById('buy-email');
    var checkEmail = pointsEmailEl ? pointsEmailEl.value.trim() : '';
    var resultEl = document.getElementById('points-result');
    if (!checkEmail) { if (resultEl) resultEl.innerHTML = '<p class="error-text">Enter your email above first.</p>'; return; }
    if (resultEl) resultEl.innerHTML = '<p class="muted">Checking…</p>';
    try {
      var balanceRes = await apiFetch('/points/balance?email=' + encodeURIComponent(checkEmail));
      if (!resultEl) return;
      var notaryReq = balanceRes.examTypes.filter(function (t) { return t.examType === 'notary'; })[0];
      var required = notaryReq ? notaryReq.pointsRequired : null;
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
        method: 'POST', body: { email: redeemEmail, examType: 'notary', turnstileToken: redeemTurnstileToken },
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

// ---- Boot -------------------------------------------------------------

(function boot() {
  var local = loadLocalPrefs();
  applyTheme(local.theme, local.fontScale);
  renderSiteHeader();
  renderSiteFooter();
  route();
})();
