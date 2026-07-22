// Thin fetch wrapper. API_BASE is same-origin — worker.js proxies /api/* to the
// examprep-api Worker via a Service Binding, so there's no CORS to configure.
var API_BASE = '/api';

function getToken() { return localStorage.getItem('examprep_token'); }
function setToken(t) { localStorage.setItem('examprep_token', t); }
function clearToken() { localStorage.removeItem('examprep_token'); }

async function apiFetch(path, opts) {
  opts = opts || {};
  var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  var token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  var res = await fetch(API_BASE + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { clearToken(); }
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw Object.assign(new Error(data.error || 'request_failed'), { status: res.status, data: data });
  return data;
}
