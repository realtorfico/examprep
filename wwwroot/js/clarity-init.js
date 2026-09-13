(function (c, l, a, r, i) {
  // The queue shim (below) is set up immediately -- any clarity(...) call made before the real
  // script loads is buffered and replayed once it does, same as the stock snippet. Only the actual
  // ~25KB script tag injection is delayed, via requestIdleCallback (falling back to a fixed
  // setTimeout in browsers without it, e.g. older Safari) -- found during a 2026-09-13 PageSpeed
  // investigation that this script was competing with initial render/interactivity on mobile.
  // Trade-off, worth knowing: sessions that bounce before the delay elapses (idle, or up to
  // IDLE_TIMEOUT_MS) won't have a Clarity recording at all -- including some of the very
  // fast-mobile-bounce sessions this investigation cares about. If that blind spot turns out to
  // matter, lower IDLE_TIMEOUT_MS (or remove the delay) rather than leaving it guessed at.
  var IDLE_TIMEOUT_MS = 1500;
  c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
  function inject() {
    var t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
    var y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
  }
  if (window.requestIdleCallback) window.requestIdleCallback(inject, { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(inject, IDLE_TIMEOUT_MS);
})(window, document, 'clarity', 'script', 'ygal1vll40');
