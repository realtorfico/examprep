// External file (not inline) so this page can ship a strict path-scoped CSP (script-src 'self',
// no 'unsafe-inline') -- see wwwroot/_headers' /embed/* block.
(function () {
  var params = new URLSearchParams(location.search);
  var examType = params.get('examType');
  var root = document.getElementById('qotd-root');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  if (!examType) {
    root.className = 'qotd-error';
    root.innerHTML = '<p class="qotd-muted">This embed needs an <code>examType</code> in its URL, e.g. ' +
      '<code>?examType=ca_notary</code>.</p><p><a href="https://passexamhq.com/#/embed" target="_blank" rel="noopener">' +
      'Get your embed code →</a></p>';
    return;
  }

  fetch('/api/qotd?examType=' + encodeURIComponent(examType))
    .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
    .then(function (q) { render(q); })
    .catch(function () {
      root.className = 'qotd-error';
      root.innerHTML = '<p class="qotd-muted">Could not load today\'s question. <a href="https://passexamhq.com" target="_blank" rel="noopener">Visit PassExamHQ →</a></p>';
    });

  function render(q) {
    var letters = ['A', 'B', 'C', 'D'];
    var selected = null;
    var answered = false;

    root.className = '';
    root.innerHTML =
      '<p class="qotd-eyebrow">Question of the Day · ' + escapeHtml(q.date) + '</p>' +
      '<div class="qotd-card">' +
      '<div class="qotd-topic">' + escapeHtml(q.topic) + '</div>' +
      '<p class="qotd-question">' + escapeHtml(q.question) + '</p>' +
      '</div>' +
      '<div class="qotd-options" id="qotd-options"></div>' +
      '<button class="qotd-submit" id="qotd-submit" disabled>Submit Answer</button>' +
      '<div id="qotd-explanation"></div>' +
      '<div class="qotd-footer">' +
      '<span class="qotd-muted">Powered by <a href="https://passexamhq.com" target="_blank" rel="noopener">PassExamHQ</a></span>' +
      '<a href="' + escapeHtml(q.trackUrl) + '" target="_blank" rel="noopener">Practice ' + escapeHtml(q.trackLabel) + ' →</a>' +
      '</div>';

    var optionsWrap = document.getElementById('qotd-options');
    var submitBtn = document.getElementById('qotd-submit');

    function draw() {
      optionsWrap.innerHTML = letters.map(function (k) {
        var cls = 'qotd-option';
        if (answered) {
          if (k === q.correctChoice) cls += ' correct';
          else if (k === selected) cls += ' wrong';
        } else if (k === selected) {
          cls += ' selected';
        }
        return '<button type="button" class="' + cls + '" data-choice="' + k + '"' + (answered ? ' disabled' : '') + '>' +
          k + '. ' + escapeHtml(q.choices[k]) + '</button>';
      }).join('');
      Array.prototype.forEach.call(optionsWrap.querySelectorAll('.qotd-option'), function (btn) {
        btn.addEventListener('click', function () {
          if (answered) return;
          selected = btn.getAttribute('data-choice');
          submitBtn.disabled = false;
          draw();
        });
      });
    }

    submitBtn.addEventListener('click', function () {
      if (!selected || answered) return;
      answered = true;
      submitBtn.style.display = 'none';
      var correct = selected === q.correctChoice;
      document.getElementById('qotd-explanation').innerHTML =
        '<div class="qotd-explanation"><span class="qotd-result-label ' + (correct ? 'qotd-result-correct' : 'qotd-result-wrong') + '">' +
        (correct ? 'Correct.' : 'Incorrect.') + '</span> ' + escapeHtml(q.explanation) + '</div>';
      draw();
    });

    draw();
  }
})();
