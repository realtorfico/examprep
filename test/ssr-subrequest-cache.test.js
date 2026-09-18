// The two API subrequests the worker makes before it can answer a landing-page request are cached
// at the edge. Added 2026-09-17.
//
// Every no-store page (the category landing pages, i.e. the Google Ads destinations) waited on
// /promotions and /config through the API service binding before the HTML could start streaming --
// on every single request, with no cache. Measured TTFB from here was 170-360ms, of which ~70-100ms
// is TLS, so those two calls were a real slice of the rest. Nothing about them is per-visitor: the
// promo ribbon and the refund percentage are the same for everyone for minutes at a time.
//
// (Worth writing down: PSI's "Initial Navigation 908ms" and "hero.css 1,061ms" in the network
// dependency tree are Lantern's SIMULATED latencies -- it models the first request at ~562ms of
// latency alone. They are not what the server took. This cache is worth doing on the real
// measurement, not on those numbers.)
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKER = fs.readFileSync(path.join(__dirname, '..', 'wwwroot', '_worker.js'), 'utf8');

// Same sentinel-block trick the other worker tests use: _worker.js is an ES module in a commonjs
// package, so the block is pulled out and eval'd rather than imported.
function loadCacheBlock(fakes) {
  const block = WORKER.match(/\/\/ >>> SSR-CACHE[\s\S]*?\/\/ <<< SSR-CACHE/);
  assert.ok(block, '_worker.js should keep its subrequest cache between "// >>> SSR-CACHE" and "// <<< SSR-CACHE"');
  const exported = {};
  new Function('exports', 'caches', 'Request', 'Response', block[0] + '\nexports.ssrApiJson = ssrApiJson;\n')(
    exported, fakes.caches, fakes.Request, fakes.Response,
  );
  return exported.ssrApiJson;
}

// Minimal stand-ins for the Workers runtime bits the block touches.
function makeFakes(apiResponder) {
  const store = new Map();
  const calls = [];
  class FakeRequest {
    constructor(input, init) {
      // The worker passes a URL object (the real Request constructor stringifies it), a string, or
      // another Request -- cover all three or two different paths can look like the same key here.
      this.url = typeof input === 'string' ? input : (input.href || input.url || String(input));
      this.method = (init && init.method) || 'GET';
      this.headers = new Map();
    }
  }
  class FakeResponse {
    constructor(body, init) {
      this.body = body;
      this.status = (init && init.status) || 200;
      this.ok = this.status >= 200 && this.status < 300;
      const headerInit = (init && init.headers) || {};
      this.headers = {
        _h: Object.assign({}, headerInit._h || headerInit),
        set(k, v) { this._h[String(k).toLowerCase()] = v; },
        get(k) { return this._h[String(k).toLowerCase()]; },
      };
    }
    clone() { return new FakeResponse(this.body, { status: this.status, headers: this.headers }); }
    async json() { return JSON.parse(this.body); }
    async text() { return this.body; }
  }
  const fakes = {
    Request: FakeRequest,
    Response: FakeResponse,
    caches: {
      default: {
        async match(key) { return store.get(key.url) || undefined; },
        async put(key, res) { store.put = true; store.set(key.url, res); },
      },
    },
  };
  const env = {
    API: {
      async fetch(req) {
        calls.push(req.url);
        return apiResponder(req.url, FakeResponse);
      },
    },
  };
  return { fakes, env, calls, store };
}

const OK = (body) => (url, Res) => new Res(JSON.stringify(body), { status: 200 });

test('a cold request fetches through the binding and caches the result', async () => {
  const { fakes, env, calls, store } = makeFakes(OK({ promotions: [{ id: 1 }] }));
  const ssrApiJson = loadCacheBlock(fakes);
  const data = await ssrApiJson(env, new URL('https://passexamhq.com/cdl'), '/promotions?placement=home');
  assert.deepEqual(data, { promotions: [{ id: 1 }] });
  assert.equal(calls.length, 1, 'one call through the service binding');
  assert.equal(store.size, 1, 'and the response is in the edge cache');
});

test('a warm request answers from cache without touching the API', async () => {
  const { fakes, env, calls } = makeFakes(OK({ refundFailurePercent: 50 }));
  const ssrApiJson = loadCacheBlock(fakes);
  const url = new URL('https://passexamhq.com/cdl');
  const first = await ssrApiJson(env, url, '/config');
  const second = await ssrApiJson(env, url, '/config');
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1, 'the second page view adds no subrequest');
});

test('the cache key is per path and per query, so one kind cannot serve another', async () => {
  const { fakes, env, calls } = makeFakes((url, Res) => new Res(JSON.stringify({ url }), { status: 200 }));
  const ssrApiJson = loadCacheBlock(fakes);
  const url = new URL('https://passexamhq.com/cdl');
  const cdl = await ssrApiJson(env, url, '/promotions?placement=home&kind=Commercial%20Driver%20(CDL)');
  const notary = await ssrApiJson(env, url, '/promotions?placement=home&kind=Notary');
  assert.notEqual(cdl.url, notary.url, 'a CDL-scoped promo must not be served on /notary');
  assert.equal(calls.length, 2);
});

test('the cache key is not the public path, so it cannot collide with a real response', async () => {
  // /promotions and /config are also real routes the browser fetches. Caching under those exact
  // URLs would put a server-side copy, with server-side headers, in the way of the client's own
  // request -- so the key is namespaced.
  const { fakes, env, store } = makeFakes(OK({ promotions: [] }));
  const ssrApiJson = loadCacheBlock(fakes);
  await ssrApiJson(env, new URL('https://passexamhq.com/cdl'), '/promotions?placement=home');
  const key = [...store.keys()][0];
  assert.ok(!/passexamhq\.com\/promotions\?/.test(key), 'key should not be the public path, got ' + key);
  assert.match(key, /__ssr-cache/, 'namespaced instead, got ' + key);
});

test('an error response is neither returned as data nor cached', async () => {
  const { fakes, env, store } = makeFakes((url, Res) => new Res('nope', { status: 503 }));
  const ssrApiJson = loadCacheBlock(fakes);
  const data = await ssrApiJson(env, new URL('https://passexamhq.com/cdl'), '/config');
  assert.equal(data, null, 'the caller falls back to its own default');
  assert.equal(store.size, 0, 'a 503 must not be cached for the next minute of visitors');
});

test('a thrown subrequest is swallowed, so the page still renders', async () => {
  const { fakes, env } = makeFakes(() => { throw new Error('binding down'); });
  const ssrApiJson = loadCacheBlock(fakes);
  const data = await ssrApiJson(env, new URL('https://passexamhq.com/cdl'), '/config');
  assert.equal(data, null);
});

test('the ribbon builder goes through the cache, not straight to the binding', () => {
  const body = WORKER.slice(WORKER.indexOf('async function ssrRibbonHtml'));
  const fn = body.slice(0, body.indexOf('\n}'));
  assert.match(fn, /ssrApiJson\(/, 'ssrRibbonHtml should use the cached helper');
  assert.ok(!/env\.API\.fetch/.test(fn), 'and not call the binding directly any more');
});
