// Vanilla JS, no framework/bundler. Hash-routed within /notary; pathname-routed at the top level.
var appEl = document.getElementById('app');
var state = { question: null, answered: null, examType: 'notary', quizDifficulty: localStorage.getItem('examprep_quiz_difficulty') || '' };
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
var sampleState = { questions: null, index: 0, answered: null };
var recognition = null;
var isRecording = false;

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

function renderSiteHeader() {
  var loggedIn = !!getToken();
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
    '<div class="font-size-pill" role="group" aria-label="Font size">' +
    '<button data-act="font-down">A-</button>' +
    '<button data-act="font-up">A+</button>' +
    '</div>' +
    '<button class="btn-secondary btn-sm" id="theme-toggle-btn" data-act="toggle-theme"></button>' +
    (loggedIn ? renderProfileMenu() : '') +
    '</div></div>';
  updateThemeButton();
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

function renderSiteFooter() {
  document.getElementById('site-footer').innerHTML =
    '<div class="site-shell footer-content">' +
    '<div>© ' + SITE_YEAR + ' ExamPrep. All rights reserved.</div>' +
    '<div class="muted">Not affiliated with, endorsed by, or sponsored by the California Secretary of State or any state licensing agency. Practice questions only — passing the real exam isn\'t guaranteed, though we back that risk with our 50% refund guarantee.</div>' +
    '<nav class="footer-links"><a href="#/terms">Terms</a><a href="#/privacy">Privacy</a><a href="/notary#/refund">Refund Request</a><a href="#/contact">Contact Us</a></nav>' +
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

// Account menu: just Log out today, but a real dropdown (not a bare button) so there's somewhere
// to add more account-level actions later without another header redesign.
function renderProfileMenu() {
  return '<div class="profile-menu">' +
    '<button class="profile-menu-btn" type="button" data-act="toggle-profile-menu" aria-label="Account menu" aria-haspopup="true">👤</button>' +
    '<div class="profile-menu-dropdown">' +
    '<button class="profile-menu-item" type="button" data-act="log-out">Log out</button>' +
    '</div></div>';
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

function renderContact() {
  appEl.innerHTML =
    '<div class="refer-page">' +
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
        // CSP blocks inline style="width:X%" -- pct-N classes (see style.css) cover the exact
        // set of breakdown percentages used across HUB_EXAMS instead. Add a new .pct-N rule
        // there if a future breakdown introduces a percentage not already covered.
        return '<div class="breakdown-row">' +
          '<div class="breakdown-row-top"><span>' + b[0] + '</span><span>' + b[1] + '</span></div>' +
          '<div class="breakdown-bar"><div class="breakdown-bar-fill pct-' + pct + '"></div></div>' +
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
  var gated = { quiz: true, exam: true, toughest45: true, progress: true };
  var tabs = [['resources', 'Resources'], ['quiz', 'Quiz'], ['exam', 'Exam'], ['toughest45', 'Toughest 45'], ['progress', 'Progress'], ['info', 'Info']];
  var trackHeading = loggedIn ? '<div class="track-heading">California Notary</div>' : '';
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
  notary: [
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

  var loggedIn = !!getToken();
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

var progressExamAttemptsByMode = { standard: null, toughest45: null }; // stashed per mode so toggling an attempt open/closed doesn't re-fetch
var examAttemptOpenId = null; // attemptId currently expanded, or null (accordion -- one at a time, across both buckets -- attemptIds are globally unique so this is unambiguous)
var examAttemptDetailCache = {}; // attemptId -> { review } | { error: true }, fetched lazily on first open
var examAttemptsExpandedByMode = { standard: false, toughest45: false }; // collapsed by default, same "Show all" pattern as the topics table below
var EXAM_ATTEMPTS_COLLAPSED_COUNT = 2;

function examAttemptsWrapId(mode) { return mode === 'toughest45' ? 'toughest45-attempts-wrap' : 'exam-attempts-wrap'; }

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

function examAttemptsSectionHtml(mode) {
  var attempts = progressExamAttemptsByMode[mode] || [];
  if (!attempts.length) return '';
  var heading = mode === 'toughest45' ? 'Toughest 45 Attempts' : 'Exam Attempts';
  var expanded = examAttemptsExpandedByMode[mode];
  var truncated = !expanded && attempts.length > EXAM_ATTEMPTS_COLLAPSED_COUNT;
  var visible = truncated ? attempts.slice(0, EXAM_ATTEMPTS_COLLAPSED_COUNT) : attempts;
  var rows = visible.map(function (a) {
    var isOpen = examAttemptOpenId === a.attemptId;
    var date = new Date(a.submittedAt * 1000).toLocaleString();
    return '<div class="exam-attempt-item">' +
      '<button class="card exam-history-row exam-attempt-summary" type="button" ' +
      'data-act="toggle-exam-attempt" data-attempt-id="' + a.attemptId + '" data-mode="' + mode + '">' +
      '<span>' + date + '</span>' +
      '<span class="' + (a.passed ? 'exam-attempt-score-passed' : 'exam-attempt-score-failed') + '">' + a.correct + ' / ' + a.total + '</span>' +
      '<span class="exam-attempt-caret">' + (isOpen ? '▲' : '▾') + '</span>' +
      '</button>' +
      (isOpen ? '<div class="exam-attempt-detail">' + examAttemptDetailHtml(a.attemptId) + '</div>' : '') +
      '</div>';
  }).join('');
  var toggleHtml = attempts.length > EXAM_ATTEMPTS_COLLAPSED_COUNT
    ? '<button class="btn-secondary btn-sm progress-topics-toggle" type="button" data-act="toggle-exam-attempts-expanded" data-mode="' + mode + '">' +
      (truncated ? 'Show all ' + attempts.length + ' attempts ▾' : 'Show fewer ▴') + '</button>'
    : '';
  return '<h3 class="mockexam-review-heading">' + heading + ' (' + attempts.length + ')</h3>' +
    '<p class="muted">Tap an attempt to see the questions you missed, with the correct answer and why.</p>' +
    '<div class="exam-history-list exam-attempts-list">' + rows + '</div>' + toggleHtml;
}

var progressByTopic = null; // stashed so the table can be re-sorted without a re-fetch
var progressSort = { key: 'topic', dir: 'asc' };
var progressTopicsExpanded = false; // collapsed by default -- a full topic list (30+ rows for
// notary) otherwise pushes the wrong-questions section below the fold, especially on mobile.
var PROGRESS_TOPICS_COLLAPSED_COUNT = 5;
var PROGRESS_ACCURACY_PASS_PCT = 70; // red/bold below this, green/bold at or above -- matches the exam's own passPercent
var PROGRESS_COVERAGE_PASS_PCT = 50; // same idea, separate threshold, for % of the topic's questions ever attempted

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
    var rowCls = pct < PROGRESS_ACCURACY_PASS_PCT ? 'progress-row-low' : 'progress-row-good';
    // Coverage gets its own cell-level color, independent of the row's accuracy-based color above
    // (a topic can be low-accuracy but well-covered, or vice versa -- two separate signals, can't
    // both be expressed as one row color).
    var coverageCls = coverage < PROGRESS_COVERAGE_PASS_PCT ? 'progress-row-low' : 'progress-row-good';
    return '<tr class="' + rowCls + '"><td>' + t.topic + '</td><td>' + pct + '%</td><td>' + t.total + '</td>' +
      '<td><span class="' + coverageCls + '">' + coverage + '%</span></td></tr>';
  }).join('');
  var toggleHtml = sorted.length > PROGRESS_TOPICS_COLLAPSED_COUNT
    ? '<button class="btn-secondary btn-sm progress-topics-toggle" type="button" data-act="toggle-progress-topics">' +
      (truncated ? 'Show all ' + sorted.length + ' topics ▾' : 'Show fewer ▴') + '</button>'
    : '';
  return '<table class="progress-topics-table"><thead><tr>' +
    '<th data-act="sort-progress-topics" data-sort-key="topic">Topic' + arrow('topic') + '</th>' +
    '<th data-act="sort-progress-topics" data-sort-key="pct">Accuracy' + arrow('pct') + '</th>' +
    '<th data-act="sort-progress-topics" data-sort-key="total">Questions' + arrow('total') + '</th>' +
    '<th data-act="sort-progress-topics" data-sort-key="coverage">Coverage' + arrow('coverage') + '</th>' +
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
  appEl.innerHTML = renderTabs('progress') + '<p class="muted">Loading…</p>';
  progressResetPending = null; // a fresh load (e.g. after a reset) always starts from the unconfirmed state
  examAttemptOpenId = null;
  examAttemptDetailCache = {};
  var results = await Promise.all([apiFetch('/progress'), apiFetch('/exam/history?mode=standard'), apiFetch('/exam/history?mode=toughest45')]);
  var p = results[0];
  var pct = p.totalAnswered ? Math.round((100 * p.totalCorrect) / p.totalAnswered) : 0;
  var wrong = p.totalAnswered - p.totalCorrect;
  progressByTopic = p.byTopic;
  progressExamAttemptsByMode.standard = results[1].attempts || [];
  progressExamAttemptsByMode.toughest45 = results[2].attempts || [];

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
  var coverageValCls = coveragePct < PROGRESS_COVERAGE_PASS_PCT ? 'wrong' : 'correct';

  appEl.innerHTML = renderTabs('progress') +
    '<div class="stats-bar">' +
    '<div class="stat-box"><div class="label">Total</div><div class="val">' + p.totalAnswered + '</div></div>' +
    '<div class="stat-box"><div class="label">Correct</div><div class="val correct">' + p.totalCorrect + '</div></div>' +
    '<div class="stat-box"><div class="label">Wrong</div><div class="val wrong">' + wrong + '</div></div>' +
    '<div class="stat-box"><div class="label">Accuracy</div><div class="val accuracy">' + pct + '%</div></div>' +
    '<div class="stat-box"><div class="label">Coverage</div><div class="val ' + coverageValCls + '">' + coveragePct + '%</div></div>' +
    '</div>' +
    '<p class="muted progress-breakdown-note">' + examBreakdownNote + '</p>' +
    '<div id="progress-topics-wrap">' + progressTopicsTableHtml() + '</div>' +
    '<div id="exam-attempts-wrap">' + examAttemptsSectionHtml('standard') + '</div>' +
    '<div id="toughest45-attempts-wrap">' + examAttemptsSectionHtml('toughest45') + '</div>' +
    wrongQuestionsSection +
    '<div id="progress-reset-wrap">' + progressResetSectionHtml() + '</div>';
}

// ---- Locked previews (Quiz/Exam/Progress, logged-out visitors) -----------
// Real content/data always requires a token -- these are non-interactive mockups purely so an
// anonymous visitor can see what each tab looks like before buying/referring their way in.

function renderLockedTabPreview(tabKey, title, mockupHtml, blurb, extraCta) {
  appEl.innerHTML = renderTabs(tabKey) +
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

function renderLockedToughest45Preview() {
  var mockup = '<div class="card mockexam-intro-card">' +
    '<p>This mimics the real exam format as closely as possible:</p>' +
    '<ul class="mockexam-intro-list">' +
    '<li>Built <strong>entirely from questions you\'ve gotten wrong before</strong> -- up to 45, but could be fewer (no filler questions)</li>' +
    '<li><strong>60-minute</strong> timer, running continuously in one sitting</li>' +
    '<li>No answer feedback until you finish — just like the real thing</li>' +
    '<li>Need <strong>70%</strong> to pass (a practice approximation of the real scaled-score-70 requirement)</li>' +
    '</ul>' +
    '<button class="btn-primary" type="button" disabled>Begin Exam →</button>' +
    '</div>';
  renderLockedTabPreview('toughest45', 'Toughest 45',
    mockup,
    'Sign in or unlock full access to drill on your own weak spots with a focused, timed exam.');
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
    '<li>Need <strong>' + config.passPercent + '%</strong> to pass (a practice approximation of the real scaled-score-70 requirement)</li>' +
    '</ul>' +
    '<p class="muted">Once started, the clock keeps running even if you close this tab — reopening it will resume ' +
    'right where you left off, not restart. There\'s no pausing.</p>' +
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
    examSubmitConfirmHtml(attempt);
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
    renderSiteHeader();
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
    '<div id="refund-failure-fields" class="refund-failure-fields">' +
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
    renderSiteHeader();
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
    if (view === 'toughest45' || view.indexOf('toughest45-history') === 0) { renderLockedToughest45Preview(); return; }
    if (view === 'progress') { renderLockedProgressPreview(); return; }
    renderRedeem(); return;
  }
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
  var hashView = (location.hash || '').replace('#/', '');
  if (hashView === 'terms') { renderTerms(); return; }
  if (hashView === 'privacy') { renderPrivacy(); return; }
  if (hashView === 'contact') { renderContact(); return; }
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
  } else if (act === 'toggle-progress-topics') {
    progressTopicsExpanded = !progressTopicsExpanded;
    var toggleWrap = document.getElementById('progress-topics-wrap');
    if (toggleWrap) toggleWrap.innerHTML = progressTopicsTableHtml();
  } else if (act === 'toggle-exam-attempt') {
    var attemptId = el.getAttribute('data-attempt-id');
    // examAttemptOpenId is shared across both buckets (accordion) -- opening one in either bucket
    // must re-render both wraps, since a previously-open attempt in the OTHER bucket needs to
    // collapse too.
    var rerenderBothAttemptWraps = function () {
      var standardWrap = document.getElementById(examAttemptsWrapId('standard'));
      if (standardWrap) standardWrap.innerHTML = examAttemptsSectionHtml('standard');
      var toughestWrap = document.getElementById(examAttemptsWrapId('toughest45'));
      if (toughestWrap) toughestWrap.innerHTML = examAttemptsSectionHtml('toughest45');
    };
    examAttemptOpenId = examAttemptOpenId === attemptId ? null : attemptId;
    if (examAttemptOpenId && !examAttemptDetailCache[attemptId]) {
      apiFetch('/exam/attempt?attemptId=' + encodeURIComponent(attemptId)).then(function (result) {
        examAttemptDetailCache[attemptId] = { review: result.review };
        if (examAttemptOpenId === attemptId) rerenderBothAttemptWraps();
      }).catch(function () {
        examAttemptDetailCache[attemptId] = { error: true };
        if (examAttemptOpenId === attemptId) rerenderBothAttemptWraps();
      });
    }
    rerenderBothAttemptWraps();
  } else if (act === 'toggle-exam-attempts-expanded') {
    var expandMode = el.getAttribute('data-mode') || 'standard';
    examAttemptsExpandedByMode[expandMode] = !examAttemptsExpandedByMode[expandMode];
    var expandWrap = document.getElementById(examAttemptsWrapId(expandMode));
    if (expandWrap) expandWrap.innerHTML = examAttemptsSectionHtml(expandMode);
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
    renderSiteHeader();
    location.hash = '';
    renderNotaryApp();
  } else if (act === 'toggle-profile-menu') {
    var profileMenuEl = el.closest('.profile-menu');
    if (profileMenuEl) profileMenuEl.classList.toggle('open');
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
      '<span>A new version of ExamPrep is available.</span>' +
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
  route();
})();
