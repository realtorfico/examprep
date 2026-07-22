/**
 * examprep public-site Worker (Cloudflare Pages "Advanced Mode" — this file must be
 * named _worker.js at the root of the deployed directory).
 *
 * /api/* is forwarded to the examprep-api Worker via a Service Binding (env.API) —
 * same-origin from the browser's perspective (so the bearer token in localStorage
 * never has to deal with cross-origin cookie/CORS rules), and no public hostname
 * needed for the backend at all. Everything else falls through to the static
 * assets (Pages provides env.ASSETS automatically alongside _worker.js).
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const target = new URL(request.url);
      target.pathname = url.pathname.replace(/^\/api/, '');
      const proxied = new Request(target, request);
      return env.API.fetch(proxied);
    }
    return env.ASSETS.fetch(request);
  },
};
