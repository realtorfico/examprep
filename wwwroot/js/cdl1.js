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
  // The band is one line of fixed height, so the promo has to fit one: title plus its code chip,
  // nothing else. Returns '' when there's no promo to show, and the server-rendered guarantee
  // tagline stays in place.
  function promoBandHtml(promo) {
    if (!promo || !promo.title) return '';
    var code = promo.promoCode
      ? '<span class="t1-promo-code">' + escapeHtml(promo.promoCode) + '</span>'
      : '';
    return '<a href="' + escapeHtml(buyHref(currentState)) + '">' + escapeHtml(promo.title) + '</a>' + code;
  }
  function formatPrice(cents) {
    return '$' + (cents / 100).toFixed(2);
  }
  var currentState = 'CA';
  window.pickSampleQuestion = pickSampleQuestion;
  // Exposed for test/cdl1-landing.test.js: the empty-coverage-bars bug was invisible to every
  // assertion on the markup, so the renderer itself is exercised directly.
  window.renderStateForTest = function (stateCode) { renderState(stateCode); };
  window.promoBandHtml = promoBandHtml;
  window.stateFactsText = stateFactsText;
  window.buyHref = buyHref;
  window.formatPrice = formatPrice;

  // --- rendering --------------------------------------------------------------------------------

  function text(id, value) { var el = document.getElementById(id); if (el && value) el.textContent = value; }

  function renderState(stateCode) {
    var entry = entryFor(stateCode);
    var name = STATE_NAMES[stateCode] || stateCode;
    currentState = stateCode;
    ['state-name', 'sample-state', 'breakdown-state', 'kicker-state', 'seal-state', 'sticky-state'].forEach(function (id) { text(id, name); });
    if (entry) {
      text('fact-questions', entry.questions);
      text('fact-pass', entry.passScore);
      text('fact-time', entry.duration);
      renderBars(entry.breakdown || []);
    }
    ['buy', 'buy2', 'buy3'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.setAttribute('href', buyHref(stateCode));
    });
    loadPrice(stateCode);
    loadCount(stateCode);
    loadSample(stateCode);
    loadPromo();
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
        ['price', 'price2', 'price3'].forEach(function (id) { text(id, formatPrice(d.priceCents)); });
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

  // One request, once: the promo is the same for the whole category, so switching state doesn't
  // need a new fetch. Scoped to the CDL kind exactly as the live site's ribbon is, so a promo aimed
  // at another track can't show up here.
  var promoLoaded = false;
  function loadPromo() {
    if (promoLoaded) return;
    promoLoaded = true;
    fetch('/api/promotions?placement=home&kind=' + encodeURIComponent('Commercial Driver (CDL)'))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var html = promoBandHtml((d && d.promotions || [])[0]);
        var band = document.getElementById('promo');
        if (html && band) band.innerHTML = html;
      })
      .catch(function () { /* the guarantee tagline stays */ });
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
