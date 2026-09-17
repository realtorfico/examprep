// Behaviour for the /cdl1 prototype (see wwwroot/cdl1.html and test/cdl1-landing.test.js).
//
// Everything this page shows is already in the HTML for California; this script only personalises
// it: swap state facts from the shared catalog, confirm the price and question count from the API,
// and run the free sample question. Nothing here is required for the first paint.
//
// The state facts come from js/content/cdl.js -- the same catalog app.js renders from -- loaded as a
// deferred script before this one, so there is no second copy of per-state exam data to drift.
(function () {
  var STATE_NAMES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
    CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
    IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
    ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
    ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
    UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
    WI: 'Wisconsin', WY: 'Wyoming',
  };

  // js/content/cdl.js calls this as it loads (same contract as app.js's own registerTrackContent).
  var catalog = [];
  window.registerTrackContent = function (slug, entries) { catalog = catalog.concat(entries); };

  function entryFor(stateCode) {
    var examType = String(stateCode).toLowerCase() + '_cdl';
    for (var i = 0; i < catalog.length; i++) if (catalog[i].examType === examType) return catalog[i];
    return null;
  }

  // --- pure helpers, also exercised directly by the tests ---------------------------------------

  // General Knowledge first: it's 48% of the bank and every candidate has to pass it, while the
  // live page showed whatever /api/sample happened to return first (a school-bus endorsement
  // question on the day this was reviewed -- irrelevant to most visitors).
  function pickSampleQuestion(questions) {
    if (!questions || !questions.length) return null;
    for (var i = 0; i < questions.length; i++) {
      if (/general knowledge/i.test(questions[i].topic || '')) return questions[i];
    }
    return questions[0];
  }
  function stateFactsText(entry) {
    if (!entry) return '';
    return [entry.questions, entry.passScore, entry.duration].filter(Boolean).join(' · ');
  }
  function buyHref(stateCode) {
    return '/cdl/' + String(stateCode).toLowerCase() + '#/buy';
  }
  function formatPrice(cents) {
    return '$' + (cents / 100).toFixed(2);
  }
  window.pickSampleQuestion = pickSampleQuestion;
  window.stateFactsText = stateFactsText;
  window.buyHref = buyHref;
  window.formatPrice = formatPrice;

  // --- rendering --------------------------------------------------------------------------------

  function text(id, value) { var el = document.getElementById(id); if (el && value) el.textContent = value; }

  function renderState(stateCode) {
    var entry = entryFor(stateCode);
    var name = STATE_NAMES[stateCode] || stateCode;
    ['state-name', 'sample-state', 'breakdown-state'].forEach(function (id) { text(id, name); });
    if (entry) {
      text('fact-questions', entry.questions);
      text('fact-pass', entry.passScore);
      text('fact-time', entry.duration);
      renderBars(entry.breakdown || []);
    }
    ['buy', 'buy2'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.setAttribute('href', buyHref(stateCode));
    });
    loadPrice(stateCode);
    loadCount(stateCode);
    loadSample(stateCode);
  }

  function renderBars(breakdown) {
    var list = document.getElementById('bars');
    if (!list) return;
    list.innerHTML = breakdown.map(function (row) {
      var pct = String(row[1] || '').replace('%', '');
      return '<li><span class="t1-bar-label">' + escapeHtml(row[0]) + '</span>' +
        '<span class="t1-bar-track"><span class="t1-bar-fill" style="width:' + (Number(pct) || 0) + '%"></span></span>' +
        '<span class="t1-bar-pct">' + escapeHtml(row[1]) + '</span></li>';
    }).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function loadPrice(stateCode) {
    fetch('/api/pricing?examType=' + stateCode.toLowerCase() + '_cdl')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.priceCents) return;
        text('price', formatPrice(d.priceCents));
        text('price2', formatPrice(d.priceCents));
      })
      .catch(function () { /* the server-rendered price stays */ });
  }

  function loadCount(stateCode) {
    fetch('/api/questions/counts')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var examType = stateCode.toLowerCase() + '_cdl';
        var row = (d.counts || []).filter(function (c) { return c.exam_type === examType; })[0];
        if (!row) return;
        var name = STATE_NAMES[stateCode] || stateCode;
        text('sample-count-line', row.count.toLocaleString() + ' more ' + name + ' questions are waiting.');
      })
      .catch(function () {});
  }

  var sampleAnswered = false;
  function loadSample(stateCode) {
    sampleAnswered = false;
    var explain = document.getElementById('sample-explain');
    var after = document.getElementById('sample-after');
    if (explain) { explain.hidden = true; explain.textContent = ''; }
    if (after) after.hidden = true;
    text('sample-topic', 'Loading a question…');
    var choices = document.getElementById('sample-choices');
    if (choices) choices.innerHTML = '';
    text('sample-question', '');

    fetch('/api/sample?examType=' + stateCode.toLowerCase() + '_cdl')
      .then(function (r) { return r.json(); })
      .then(function (d) { renderSample(pickSampleQuestion(d && d.questions)); })
      .catch(function () { text('sample-topic', 'Couldn\'t load a question just now.'); });
  }

  function renderSample(q) {
    if (!q) { text('sample-topic', 'Couldn\'t load a question just now.'); return; }
    text('sample-topic', q.topic || '');
    text('sample-question', q.question || '');
    var wrap = document.getElementById('sample-choices');
    if (!wrap) return;
    var keys = Object.keys(q.choices || {});
    wrap.innerHTML = keys.map(function (k) {
      return '<button type="button" class="t1-choice" data-choice="' + k + '">' +
        '<span class="t1-choice-key">' + k + '</span>' + escapeHtml(q.choices[k]) + '</button>';
    }).join('');
    wrap.onclick = function (e) {
      var btn = e.target.closest ? e.target.closest('.t1-choice') : null;
      if (!btn || sampleAnswered) return;
      sampleAnswered = true;
      var picked = btn.getAttribute('data-choice');
      Array.prototype.forEach.call(wrap.querySelectorAll('.t1-choice'), function (el) {
        var key = el.getAttribute('data-choice');
        if (key === q.correctChoice) el.classList.add('is-correct');
        else if (key === picked) el.classList.add('is-wrong');
      });
      var explain = document.getElementById('sample-explain');
      if (explain) {
        explain.textContent = (picked === q.correctChoice ? 'Correct. ' : 'Not quite. ') + (q.explanation || '');
        explain.hidden = false;
      }
      var after = document.getElementById('sample-after');
      if (after) after.hidden = false;
    };
  }

  function start() {
    var select = document.getElementById('state');
    if (!select) return;
    select.addEventListener('change', function () { renderState(select.value); });
    renderState(select.value || 'CA');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
