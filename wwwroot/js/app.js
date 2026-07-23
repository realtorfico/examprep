// Vanilla JS, no framework/bundler. Hash-routed within /notary; pathname-routed at the top level.
var appEl = document.getElementById('app');
var state = { question: null, answered: null, examType: 'notary' };
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

// ---- Shared chrome: top controls (theme/font) + identity bar --------------

function renderTopControls() {
  var local = loadLocalPrefs();
  var nextTheme = local.theme === 'light' ? 'dark' : 'light';
  // Label shows what clicking WILL switch to (the destination), not the current theme —
  // e.g. while in light mode the button shows the moon, inviting a switch to dark.
  return '<div class="top-controls">' +
    '<div class="control-group"><button class="btn-secondary btn-sm" data-act="toggle-theme" data-next="' + nextTheme + '">' +
    (nextTheme === 'dark' ? '🌙 Dark' : '☀️ Light') + '</button></div>' +
    '<div class="control-group"><span class="muted" style="font-size:0.8rem">Font:</span>' +
    '<button class="btn-secondary btn-sm" data-act="font-down">A-</button>' +
    '<button class="btn-secondary btn-sm" data-act="font-up">A+</button></div>' +
    '</div>';
}

function renderUserBar() {
  if (!getToken()) return '';
  return '<div class="user-bar"><div class="user-info"><span class="label">Studying</span>' +
    '<span class="value">California Notary</span></div>' +
    '<button class="btn-secondary btn-sm" data-act="log-out">Log out</button></div>';
}

// ---- Views --------------------------------------------------------------

function renderHub() {
  appEl.innerHTML = renderTopControls() +
    '<h1>ExamPrep</h1>' +
    '<p class="muted">Pick an exam to start practicing.</p>' +
    '<div class="card exam-card"><div><strong>California Notary</strong></div>' +
    '<a class="btn-primary" href="/notary">Start</a></div>' +
    '<div class="card exam-card"><div><strong>California DRE</strong></div>' +
    '<span class="badge">Coming soon</span></div>' +
    '<div class="card exam-card"><div><strong>National MLO</strong></div>' +
    '<span class="badge">Coming soon</span></div>';
}

function renderRedeem(error) {
  appEl.innerHTML = renderTopControls() +
    '<h1>Enter your access code</h1>' +
    (error ? '<p class="error-text">' + error + '</p>' : '') +
    '<form data-act="redeem-submit" class="card">' +
    '<input type="text" name="code" placeholder="XXXXX-XXXXX" autocapitalize="characters" required>' +
    '<div id="turnstile-container"></div>' +
    '<button class="btn-primary" type="submit">Unlock</button>' +
    '</form>';
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
  var tabs = [['quiz', 'Quiz'], ['progress', 'Progress']];
  return '<nav class="tabs">' + tabs.map(function (t) {
    return '<a href="#/' + t[0] + '"' + (active === t[0] ? ' aria-current="page"' : '') + '>' + t[1] + '</a>';
  }).join('') + '</nav>';
}

async function renderQuiz() {
  appEl.innerHTML = renderTopControls() + renderUserBar() + renderTabs('quiz') + '<p class="muted">Loading question…</p>';
  try {
    state.question = await apiFetch('/questions/next');
    state.answered = null;
    drawQuestion();
  } catch (e) {
    appEl.innerHTML = renderTopControls() + renderUserBar() + renderTabs('quiz') + '<p>Could not load a question. Try again shortly.</p>';
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

  appEl.innerHTML = renderTopControls() + renderUserBar() + renderTabs('quiz') +
    '<div class="card">' +
    '<div class="question-topic">' + q.topic + '</div>' +
    '<div class="question-text">' + q.question + '</div>' +
    '<div class="audio-actions" style="margin-top:0.75rem"><button class="btn-secondary btn-sm" data-act="listen">🔊 Read aloud</button></div>' +
    '</div>' +
    '<div class="options-grid">' + choiceHtml + '</div>' +
    explanation + micZone + nav;

  setupMic();
}

async function renderProgress() {
  appEl.innerHTML = renderTopControls() + renderUserBar() + renderTabs('progress') + '<p class="muted">Loading…</p>';
  var p = await apiFetch('/progress');
  var pct = p.totalAnswered ? Math.round((100 * p.totalCorrect) / p.totalAnswered) : 0;
  var wrong = p.totalAnswered - p.totalCorrect;
  var rows = p.byTopic.map(function (t) {
    var tPct = t.total ? Math.round((100 * t.correct) / t.total) : 0;
    return '<div class="card exam-card"><span>' + t.topic + '</span><span>' + tPct + '% (' + t.total + ')</span></div>';
  }).join('');
  appEl.innerHTML = renderTopControls() + renderUserBar() + renderTabs('progress') +
    '<div class="stats-bar">' +
    '<div class="stat-box"><div class="label">Total</div><div class="val">' + p.totalAnswered + '</div></div>' +
    '<div class="stat-box"><div class="label">Correct</div><div class="val correct">' + p.totalCorrect + '</div></div>' +
    '<div class="stat-box"><div class="label">Wrong</div><div class="val wrong">' + wrong + '</div></div>' +
    '<div class="stat-box"><div class="label">Accuracy</div><div class="val accuracy">' + pct + '%</div></div>' +
    '</div>' + rows;
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
  if (!getToken()) { renderRedeem(); return; }
  var view = (location.hash || '#/quiz').replace('#/', '');
  if (view === 'quiz') await renderQuiz();
  else if (view === 'progress') await renderProgress();
  else await renderQuiz();
}

function route() {
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

appEl.addEventListener('submit', async function (e) {
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

appEl.addEventListener('click', async function (e) {
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
    if (getToken()) apiFetch('/prefs', { method: 'POST', body: { theme: nextTheme } }).catch(function () {});
    route();
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
  route();
})();
