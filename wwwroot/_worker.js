/**
 * examprep public-site Worker (Cloudflare Pages "Advanced Mode" — this file must be
 * named _worker.js at the root of the deployed directory).
 *
 * /api/* is forwarded to the examprep-api Worker via a Service Binding (env.API) —
 * same-origin from the browser's perspective (so the bearer token in localStorage
 * never has to deal with cross-origin cookie/CORS rules), and no public hostname
 * needed for the backend at all. Everything else falls through to the static
 * assets (Pages provides env.ASSETS automatically alongside _worker.js).
 *
 * /mcp is forwarded the same way, unchanged (no prefix to strip) -- it's the public,
 * unauthenticated remote MCP server (see examprep-api's handleMcp) that AI assistants and
 * Cloudflare's WebMCP bridge script (Dashboard > Agent Readiness > Labs, data-mcp-url="/mcp")
 * call directly, kept at a clean top-level path since that's the conventional MCP endpoint
 * shape external clients/directories look for.
 *
 * Root ("/") state redirect: the hub defaults to a single state's tracks rather than a flat
 * 50-state catalog (cross-state purchase intent is ~nil for a licensing-exam product), so a
 * fresh visitor to "/" needs to land on "/<state>" already. That decision has to happen here,
 * server-side, before any HTML ships -- app.js can't see request.cf, and redirecting client-side
 * after the all-states page has already painted would be a visible flash-then-swap. Precedence:
 * 1) an explicit pxq_state cookie (set by app.js once a visitor has landed on or picked a state)
 *    always wins over geolocation.
 * 2) otherwise, Cloudflare's per-request geolocation (request.cf.regionCode) picks a first-guess
 *    state. app.js sets the cookie itself once it lands on "/<state>", so this redirect only
 *    ever fires once per visitor (or until they clear cookies).
 * 3) no cookie and no usable geolocation (non-US visitor, bot, VPN Cloudflare can't place) -> no
 *    redirect, "/" serves the all-states catalog directly -- there's no user-facing way to reach
 *    that catalog otherwise (no state picker option, no link points at it), it exists purely as
 *    the graceful fallback for "we genuinely don't know your state yet." Also the deliberately-
 *    chosen behavior for crawlers, so Google indexes the full-catalog page at the root.
 * Explicitly marked private/no-store: this is a per-visitor decision (their own cookie or their
 * own IP's geolocation) and must never be cached by Cloudflare's shared edge cache -- a cached
 * redirect would leak one visitor's detected state to every later visitor hitting the same
 * cached edge response. run_worker_first (wrangler.jsonc) guarantees this Worker runs on every
 * request regardless of any Pages asset caching, so this logic can't be bypassed by cache either.
 */
const KNOWN_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY',
  'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY',
]);

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const target = new URL(request.url);
      target.pathname = url.pathname.replace(/^\/api/, '');
      const proxied = new Request(target, request);
      return env.API.fetch(proxied);
    }
    if (url.pathname === '/mcp') return env.API.fetch(request);

    // California's real estate track was originally launched as /ca_dre (examType ca_dre),
    // breaking this project's {state}_{category} naming convention -- renamed to /ca_real_estate
    // 2026-08-24 to match every other state's real-estate track. Permanent (cacheable) redirect
    // so any bookmarked/shared/indexed /ca_dre link keeps working indefinitely; the URL fragment
    // (e.g. #/quiz) is preserved automatically by the browser since Location has none of its own.
    if (url.pathname === '/ca_dre' || url.pathname.startsWith('/ca_dre/')) {
      const target = new URL(url.pathname.replace('/ca_dre', '/ca_real_estate') + url.search, url);
      return Response.redirect(target.toString(), 301);
    }

    if (url.pathname === '/' && request.method === 'GET') {
      const cookieState = parseCookie(request.headers.get('Cookie'), 'pxq_state');
      let redirectTo = null;
      if (cookieState && KNOWN_STATE_CODES.has(cookieState)) {
        redirectTo = cookieState;
      } else if (!cookieState) {
        const region = request.cf && request.cf.country === 'US' ? request.cf.regionCode : null;
        if (region && KNOWN_STATE_CODES.has(region)) redirectTo = region;
      }
      if (redirectTo) {
        return Response.redirect(new URL('/' + redirectTo.toLowerCase() + url.search, url).toString(), 302);
      }
    }

    const response = await env.ASSETS.fetch(request);
    if (url.pathname === '/') {
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'private, no-store');
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },
};
