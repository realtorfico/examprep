// Thin fetch wrapper. API_BASE is same-origin — worker.js proxies /api/* to the
// examprep-api Worker via a Service Binding, so there's no CORS to configure.
var API_BASE = '/api';

function getToken() { return localStorage.getItem('examprep_token'); }
function setToken(t) { localStorage.setItem('examprep_token', t); }
function clearToken() { localStorage.removeItem('examprep_token'); }

// Identical GETs that are in flight at the same moment share one network request. A category
// landing page fired /promotions?placement=home&kind=... three times and /questions/counts twice on
// a single load (measured on /cdl, 2026-09-17) -- several independent renderers (header ribbon,
// category promo card, question-count fills) each ask for what they need, which is the right shape
// for the callers but wasted round trips on the critical path of the slowest pages.
//
// Scoped deliberately narrowly: keyed on the full request path, only for GETs with no auth-state
// change in between, and the entry is dropped the moment the request settles -- so this is request
// COALESCING, never a response cache. A later GET of the same path still hits the network and still
// sees fresh data. Writes are never coalesced (two POSTs are two events).
var inFlightGets = {};

async function apiFetch(path, opts) {
  opts = opts || {};
  var method = opts.method || 'GET';
  if (method === 'GET' && !opts.body) {
    var key = path + '|' + (getToken() || '');
    if (inFlightGets[key]) return inFlightGets[key];
    var pending = apiFetchUncoalesced(path, opts);
    inFlightGets[key] = pending;
    // finally-equivalent that works in this file's ES5 style: clear on both paths, then re-throw.
    pending.then(function () { delete inFlightGets[key]; }, function () { delete inFlightGets[key]; });
    return pending;
  }
  return apiFetchUncoalesced(path, opts);
}

async function apiFetchUncoalesced(path, opts) {
  opts = opts || {};
  var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  var token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  var res = await fetch(API_BASE + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { clearToken(); renderSiteHeader(); }
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw Object.assign(new Error(data.error || 'request_failed'), { status: res.status, data: data });
  return data;
}
