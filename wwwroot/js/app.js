// Vanilla JS, no framework/bundler. Hash-routed within /notary; pathname-routed at the top level.
var appEl = document.getElementById('app');
var state = { question: null, answered: null, examType: 'notary' };

function applyTheme(theme, fontScale) {
  var root = document.documentElement;
  if (theme && theme !== 'system') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  if (fontScale) root.style.setProperty('--font-scale', fontScale);
}

function loadLocalPrefs() {
  return {
    theme: localStorage.getItem('examprep_theme') || 'system',
    fontScale: parseFloat(localStorage.getItem('examprep_font') || '1'),
  };
}
function saveLocalPrefs(theme, fontScale) {
  localStorage.setItem('examprep_theme', theme);
  localStorage.setItem('examprep_font', String(fontScale));
}

// ---- Views --------------------------------------------------------------

function renderHub() {
  appEl.innerHTML =
    '<h1>ExamPrep</h1>' +
    '<p class="muted">Pick an exam to start practicing.</p>' +
    '<div class="card exam-card"><div><strong>California Notary</strong></div>' +
    '<a class="btn btn-primary" href="/notary">Start</a></div>' +
    '<div class="card exam-card"><div><strong>California DRE</strong></div>' +
    '<span class="badge">Coming soon</span></div>' +
    '<div class="card exam-card"><div><strong>National MLO</strong></div>' +
    '<span class="badge">Coming soon</span></div>';
}

function renderRedeem(error) {
  appEl.innerHTML =
    '<h1>Enter your access code</h1>' +
    (error ? '<p style="color:var(--incorrect)">' + error + '</p>' : '') +
    '<form data-act="redeem-submit" class="card">' +
    '<input type="text" name="code" placeholder="XXXXX-XXXXX" autocapitalize="characters" required>' +
    '<div id="turnstile-container" style="margin:0.75rem 0"></div>' +
    '<button class="btn btn-primary" type="submit">Unlock</button>' +
    '</form>';
  if (window.turnstile && TURNSTILE_SITE_KEY.indexOf('REPLACE') === -1) {
    window.turnstile.render('#turnstile-container', { sitekey: TURNSTILE_SITE_KEY });
  }
}

function renderTabs(active) {
  var tabs = [['quiz', 'Quiz'], ['progress', 'Progress'], ['settings', 'Settings']];
  return '<nav class="tabs">' + tabs.map(function (t) {
    return '<a href="#/' + t[0] + '"' + (active === t[0] ? ' aria-current="page"' : '') + '>' + t[1] + '</a>';
  }).join('') + '</nav>';
}

async function renderQuiz() {
  appEl.innerHTML = renderTabs('quiz') + '<p class="muted">Loading question…</p>';
  try {
    state.question = await apiFetch('/questions/next');
    state.answered = null;
    drawQuestion();
  } catch (e) {
    appEl.innerHTML = renderTabs('quiz') + '<p>Could not load a question. Try again shortly.</p>';
  }
}

function drawQuestion() {
  var q = state.question;
  var choiceHtml = ['A', 'B', 'C', 'D'].map(function (k) {
    var state_attr = '';
    if (state.answered) {
      if (k === state.answered.correctChoice) state_attr = ' data-state="correct"';
      else if (k === state.answered.picked) state_attr = ' data-state="incorrect"';
    }
    return '<button class="choice" data-act="answer" data-choice="' + k + '"' +
      (state.answered ? ' disabled' : '') + state_attr + '>' + k + '. ' + q.choices[k] + '</button>';
  }).join('');

  var feedback = '';
  if (state.answered) {
    feedback = '<p style="color:var(--' + (state.answered.correct ? 'correct' : 'incorrect') + ')">' +
      (state.answered.correct ? 'Correct.' : 'Incorrect.') + '</p>' +
      '<p class="muted">' + state.answered.explanation + '</p>' +
      '<button class="btn btn-primary" data-act="next-question">Next question</button>';
  }

  appEl.innerHTML = renderTabs('quiz') +
    '<p class="badge">' + q.topic + '</p>' +
    '<h2>' + q.question + '</h2>' +
    '<button class="btn" data-act="listen" style="margin-bottom:1rem">Listen</button>' +
    '<div>' + choiceHtml + '</div>' +
    '<div style="margin-top:1rem">' + feedback + '</div>';
}

async function renderProgress() {
  appEl.innerHTML = renderTabs('progress') + '<p class="muted">Loading…</p>';
  var p = await apiFetch('/progress');
  var pct = p.totalAnswered ? Math.round((100 * p.totalCorrect) / p.totalAnswered) : 0;
  var rows = p.byTopic.map(function (t) {
    var tPct = t.total ? Math.round((100 * t.correct) / t.total) : 0;
    return '<div class="card exam-card"><span>' + t.topic + '</span><span>' + tPct + '% (' + t.total + ')</span></div>';
  }).join('');
  appEl.innerHTML = renderTabs('progress') +
    '<h2>' + pct + '% correct</h2>' +
    '<p class="muted">' + p.totalAnswered + ' questions answered</p>' + rows;
}

async function renderSettings() {
  var local = loadLocalPrefs();
  appEl.innerHTML = renderTabs('settings') +
    '<div class="card">' +
    '<label>Theme<br><select name="theme" data-act="theme-change">' +
    ['system', 'light', 'dark'].map(function (t) {
      return '<option value="' + t + '"' + (t === local.theme ? ' selected' : '') + '>' + t + '</option>';
    }).join('') + '</select></label></div>' +
    '<div class="card"><label>Font size<br>' +
    '<input type="range" min="0.85" max="1.4" step="0.05" value="' + local.fontScale + '" data-act="font-change"></label></div>';
}

// ---- Routing --------------------------------------------------------------

async function renderNotaryApp() {
  if (!getToken()) { renderRedeem(); return; }
  var view = (location.hash || '#/quiz').replace('#/', '');
  if (view === 'quiz') await renderQuiz();
  else if (view === 'progress') await renderProgress();
  else if (view === 'settings') await renderSettings();
  else await renderQuiz();
}

function route() {
  if (location.pathname === '/' || location.pathname === '') renderHub();
  else if (location.pathname.indexOf('/notary') === 0) renderNotaryApp();
  else renderHub();
}

window.addEventListener('hashchange', route);
window.addEventListener('popstate', route);

// ---- Delegated event handling (CSP-safe: no inline handlers) --------------

appEl.addEventListener('submit', async function (e) {
  var act = e.target.getAttribute && e.target.getAttribute('data-act');
  if (act === 'redeem-submit') {
    e.preventDefault();
    var code = e.target.code.value.trim();
    var turnstileToken = window.turnstile ? window.turnstile.getResponse() : '';
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
    var choice = el.getAttribute('data-choice');
    var res = await apiFetch('/answer', { method: 'POST', body: { questionId: state.question.id, choice: choice } });
    state.answered = { picked: choice, correct: res.correct, correctChoice: res.correctChoice, explanation: res.explanation };
    drawQuestion();
  } else if (act === 'next-question') {
    stopSpeaking();
    renderQuiz();
  }
});

appEl.addEventListener('change', async function (e) {
  var act = e.target.getAttribute && e.target.getAttribute('data-act');
  if (act === 'theme-change') {
    var theme = e.target.value;
    var local = loadLocalPrefs();
    saveLocalPrefs(theme, local.fontScale);
    applyTheme(theme, local.fontScale);
    if (getToken()) apiFetch('/prefs', { method: 'POST', body: { theme: theme } }).catch(function () {});
  } else if (act === 'font-change') {
    var fontScale = parseFloat(e.target.value);
    var localT = loadLocalPrefs();
    saveLocalPrefs(localT.theme, fontScale);
    applyTheme(localT.theme, fontScale);
    if (getToken()) apiFetch('/prefs', { method: 'POST', body: { fontScale: fontScale } }).catch(function () {});
  }
});

// ---- Boot -------------------------------------------------------------

(function boot() {
  var local = loadLocalPrefs();
  applyTheme(local.theme, local.fontScale);
  route();
})();
