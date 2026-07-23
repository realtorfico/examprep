// Vanilla JS, no framework/bundler. Hash-routed within /notary; pathname-routed at the top level.
var appEl = document.getElementById('app');
var state = { question: null, answered: null, examType: 'notary' };
var sampleState = { questions: null, index: 0, answered: null };
var recognition = null;
var isRecording = false;

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
    '<button class="btn-secondary btn-sm" data-act="font-down">A-</button>' +
    '<button class="btn-secondary btn-sm" data-act="font-up">A+</button>' +
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
    '<div class="muted">Not affiliated with the California Secretary of State or any state licensing agency. Practice questions only — not a guarantee of exam results.</div>' +
    '<nav class="footer-links"><a href="#/terms">Terms</a><a href="#/privacy">Privacy</a></nav>' +
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
    '<button class="btn-secondary btn-sm" data-act="go-back">← Back</button>';
}

function renderPrivacy() {
  appEl.innerHTML = '<h1>Privacy</h1>' +
    '<p class="muted">We store the minimum needed to run your account: your access code\'s redemption status, ' +
    'your quiz progress, and your theme/font preferences. We do not require or collect your name, email, or ' +
    'payment details through this site. Contact whoever issued your code with any privacy questions.</p>' +
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
      exam.breakdown.map(function (b) { return '<div class="breakdown-row"><span>' + b[0] + '</span><span>' + b[1] + '</span></div>'; }).join('') +
      '</div>';
    var cta = exam.active
      ? '<a class="btn-primary hub-cta" href="' + exam.route + '">Start Questionnaire →</a>' +
        '<a class="btn-secondary hub-cta" href="/notary#/sample">Try a free sample</a>'
      : '<button class="btn-secondary hub-cta" disabled>Coming Soon</button>';

    return '<div class="exam-track-card' + (exam.active ? ' is-active' : '') + '">' +
      '<div class="exam-track-body">' +
      '<div class="exam-track-top"><span class="badge">' + exam.category + '</span>' + statusBadge + '</div>' +
      '<h3>' + exam.title + '</h3>' +
      '<p class="muted exam-track-desc">' + exam.description + '</p>' +
      specs + breakdown +
      '</div><div class="exam-track-footer">' + cta + '</div></div>';
  }).join('');

  appEl.innerHTML =
    '<div class="hub-hero"><h1>Professional Licensing Exam Prep</h1>' +
    '<p>Practice question sets modeled after official state and national licensing standards. Select an active exam track below to begin.</p></div>' +
    '<div class="access-banner"><div class="access-banner-text">🔑 <div><strong>Access Token Required</strong>' +
    '<p class="muted access-banner-sub">Need a code, or need yours renewed? Contact whoever issued your access.</p></div></div></div>' +
    '<div class="hub-section-header"><h2>Licensing Tracks</h2>' +
    '<span class="badge">' + activeCount + ' Active • ' + upcomingCount + ' Upcoming</span></div>' +
    '<div class="exam-track-grid">' + cards + '</div>';
}

function renderRedeem(error) {
  appEl.innerHTML =
    '<h1>Enter your access code</h1>' +
    (error ? '<p class="error-text">' + error + '</p>' : '') +
    '<form data-act="redeem-submit" class="card">' +
    '<input type="text" name="code" placeholder="XXXXX-XXXXX" autocapitalize="characters" required>' +
    '<div id="turnstile-container"></div>' +
    '<button class="btn-primary" type="submit">Unlock</button>' +
    '</form>' +
    '<p class="muted redeem-sample-hint">No code yet? <a href="#/sample">Try a free sample</a></p>';
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
  var tabs = [['resources', 'Resources'], ['quiz', 'Quiz'], ['progress', 'Progress']];
  return '<nav class="tabs">' + tabs.map(function (t) {
    return '<a href="#/' + t[0] + '"' + (active === t[0] ? ' aria-current="page"' : '') + '>' + t[1] + '</a>';
  }).join('') + '</nav>';
}

// ---- Study resources (audio/video/pdf/image guides, per exam type) --------

var MEDIA_BASE = 'https://media.softician.com/';

var RESOURCES = {
  notary: [
    { title: 'The Power Behind California Notary Stamps', type: 'audio', file: 'The_Power_Behind_California_Notary_Stamps.m4a',
      desc: 'A guided audio walkthrough of what your notary seal legally represents and how it’s misused.' },
    { title: 'Legal Minefields for California Notaries', type: 'audio', file: 'Legal_Minefields_for_California_Notaries.m4a',
      desc: 'Common notarial mistakes that carry civil or criminal exposure, explained in plain language.' },
    { title: 'Surprising Rules for California Notaries', type: 'video', file: 'Surprising_Rules_for_California_Notaries.mp4',
      desc: 'A short video on lesser-known notary rules that trip up first-time applicants.' },
    { title: 'California Notary Fees', type: 'video', file: 'California_Notary_Fees.mp4',
      desc: 'A breakdown of statutory notary fees and how the exam tests them.' },
    { title: 'California Notary Blueprint', type: 'pdf', file: 'California_Notary_Blueprint.pdf',
      desc: 'A structured study reference covering the full exam blueprint.' },
    { title: 'California Notary 2026 Quick Guide', type: 'image', file: 'California_Notary_2026_Quick_Guide.png',
      desc: 'A one-page visual cheat sheet for last-minute review.' },
  ],
};

var RESOURCE_TYPE_LABEL = { audio: '🎧 Audio', video: '🎥 Video', pdf: '📄 PDF Guide', image: '🖼️ Quick Reference' };

function renderResources() {
  var items = RESOURCES[state.examType] || [];
  if (!items.length) {
    appEl.innerHTML = renderUserBar() + renderTabs('resources') + '<p class="muted">No study resources yet for this exam track.</p>';
    return;
  }
  var cards = items.map(function (r) {
    var url = MEDIA_BASE + r.file;
    var media = '';
    if (r.type === 'audio') media = '<audio class="resource-player" controls preload="none" src="' + url + '"></audio>';
    else if (r.type === 'video') media = '<video class="resource-player" controls preload="none" src="' + url + '"></video>';
    else if (r.type === 'image') media = '<a href="' + url + '" target="_blank" rel="noopener"><img class="resource-thumb" src="' + url + '" alt="' + r.title + '"></a>';
    else media = '<a class="btn-secondary btn-sm" href="' + url + '" target="_blank" rel="noopener">Open PDF ↗</a>';

    return '<div class="card resource-card">' +
      '<div class="resource-card-top"><span class="badge">' + RESOURCE_TYPE_LABEL[r.type] + '</span></div>' +
      '<h3 class="resource-title">' + r.title + '</h3>' +
      '<p class="muted resource-desc">' + r.desc + '</p>' +
      media +
      '</div>';
  }).join('');

  appEl.innerHTML = renderUserBar() + renderTabs('resources') +
    '<p class="muted resources-intro">Guided material to go with your practice questions.</p>' +
    '<div class="resource-grid">' + cards + '</div>';
}

async function renderQuiz() {
  appEl.innerHTML = renderUserBar() + renderTabs('quiz') + '<p class="muted">Loading question…</p>';
  try {
    state.question = await apiFetch('/questions/next');
    state.answered = null;
    drawQuestion();
  } catch (e) {
    appEl.innerHTML = renderUserBar() + renderTabs('quiz') + '<p>Could not load a question. Try again shortly.</p>';
  }
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
    return '<button class="' + cls + '" data-act="answer" data-choice="' + k + '"' +
      (state.answered ? ' disabled' : '') + '>' + k + ') ' + q.choices[k] + '</button>';
  }).join('');

  var explanation = state.answered
    ? '<div class="explanation-box">' +
      '<strong class="' + (state.answered.correct ? 'result-correct' : 'result-incorrect') + '">' +
      (state.answered.correct ? 'Correct.' : 'Incorrect.') + '</strong> ' + state.answered.explanation + '</div>'
    : '';

  var micZone = !state.answered
    ? '<div class="mic-zone">' +
      '<button class="btn-mic" data-act="mic-toggle">🎙️ Speak choice (e.g. "Option A")</button>' +
      '<div class="transcript-box" id="mic-transcript"></div></div>'
    : '';

  var nav = state.answered
    ? '<div class="nav-controls"><button class="btn-primary" data-act="next-question">Next question →</button></div>'
    : '';

  appEl.innerHTML = renderUserBar() + renderTabs('quiz') +
    '<div class="card">' +
    '<div class="question-topic">' + q.topic + '</div>' +
    '<div class="question-text">' + q.question + '</div>' +
    '<div class="audio-actions"><button class="btn-secondary btn-sm" data-act="listen">🔊 Read aloud</button></div>' +
    '</div>' +
    '<div class="options-grid">' + choiceHtml + '</div>' +
    explanation + micZone + nav;

  setupMic();
}

async function renderProgress() {
  appEl.innerHTML = renderUserBar() + renderTabs('progress') + '<p class="muted">Loading…</p>';
  var p = await apiFetch('/progress');
  var pct = p.totalAnswered ? Math.round((100 * p.totalCorrect) / p.totalAnswered) : 0;
  var wrong = p.totalAnswered - p.totalCorrect;
  var rows = p.byTopic.map(function (t) {
    var tPct = t.total ? Math.round((100 * t.correct) / t.total) : 0;
    return '<div class="card exam-card"><span>' + t.topic + '</span><span>' + tPct + '% (' + t.total + ')</span></div>';
  }).join('');
  appEl.innerHTML = renderUserBar() + renderTabs('progress') +
    '<div class="stats-bar">' +
    '<div class="stat-box"><div class="label">Total</div><div class="val">' + p.totalAnswered + '</div></div>' +
    '<div class="stat-box"><div class="label">Correct</div><div class="val correct">' + p.totalCorrect + '</div></div>' +
    '<div class="stat-box"><div class="label">Wrong</div><div class="val wrong">' + wrong + '</div></div>' +
    '<div class="stat-box"><div class="label">Accuracy</div><div class="val accuracy">' + pct + '%</div></div>' +
    '</div>' + rows;
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
      '<a class="btn-primary hub-cta" href="/notary">Enter access code →</a>';
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
    return '<button class="' + cls + '" data-act="sample-answer" data-choice="' + k + '"' +
      (sampleState.answered ? ' disabled' : '') + '>' + k + ') ' + q.choices[k] + '</button>';
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
    if (micBtn) micBtn.textContent = '🎙️ Speak choice (e.g. "Option A")';
  };
}

// ---- Routing --------------------------------------------------------------

async function renderNotaryApp() {
  var view = (location.hash || '#/quiz').replace('#/', '');
  if (view === 'sample') { await renderSample(); return; }
  if (!getToken()) { renderRedeem(); return; }
  if (view === 'quiz') await renderQuiz();
  else if (view === 'progress') await renderProgress();
  else if (view === 'resources') renderResources();
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
}

// ---- Delegated event handling (CSP-safe: no inline handlers) --------------
// Listens on document (not just #app) since the header now lives outside #app.

document.addEventListener('submit', async function (e) {
  var act = e.target.getAttribute && e.target.getAttribute('data-act');
  if (act === 'redeem-submit') {
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
      el.textContent = '🎤 Listening… say "Option A, B, C, or D"';
      recognition.start();
    } else {
      recognition.stop();
    }
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
