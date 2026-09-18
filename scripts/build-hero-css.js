// Generates wwwroot/css/hero.css -- the small BLOCKING stylesheet that styles the server-rendered
// category hero (see the SSR-HERO block in wwwroot/_worker.js) at first paint.
//
// Why a separate file rather than a few inlined rules: _headers pins style-src to 'self' with no
// 'unsafe-inline', so an inline <style> block would be silently dropped, exactly like an inline
// <script> (see turnstile.js's header for the same reasoning). And why blocking rather
// than the preload + deferred-attach dance style.min.css uses (load-css.js): that trick's safety
// argument was written down as "this page has zero visible content before app.js renders anything
// -- there's no flash-of-unstyled-content risk". Server-rendering the hero makes that false, so
// the hero's own CSS has to be applied before the first paint or the headline paints in Times New
// Roman at full width and then reflows -- a worse first impression than the blank page it replaced.
//
// Why generated rather than hand-written: the hero inherits the navy+gold design tokens from
// :root, which carries three theme variants (dark default, [data-theme="light"], and
// prefers-color-scheme: light with a :not([data-theme="dark"]) guard). Hand-copying those values
// would be a silent-drift trap the moment a token is retuned -- and they HAVE been retuned three
// times (see style.css's own :root comments). This extracts the real rules from style.css instead,
// and test/landing-first-paint.test.js asserts the committed file still equals this output, so a
// style.css edit that changes the hero fails the tests until hero.css is rebuilt.
//
// Run via `npm run build` (build-minified-js.js calls this), or standalone:
//   node scripts/build-hero-css.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CleanCSS = require('clean-css');

const CSS_SRC = path.join(__dirname, '..', 'wwwroot', 'css', 'style.css');
const CSS_OUT = path.join(__dirname, '..', 'wwwroot', 'css', 'hero.css');

// Every selector the server-rendered hero markup can actually match, written exactly as style.css
// writes it. Matched per comma-separated part after the theme prefix is stripped (below), so a
// grouped rule like `h1, h2 { ... }` is picked up by its `h1` part and carried over whole.
//
// Kept deliberately tight: this file is on the critical path of every category landing page, so it
// holds the hero and nothing else. Everything below the server-rendered block (trust badges, state
// picker, stats, sample widget) is styled by style.min.css, which lands ~0.4s later and long
// before app.js renders any of it.
const HERO_SELECTORS = new Set([
  'html',
  'body',
  // ---- The server-rendered HEADER (siteHeaderHtml in _worker.js) -------------------------------
  // Added 2026-09-17. Without these the header painted unstyled -- nav links one per line, the
  // mobile drawer printing a second copy of them, ~337px tall -- and collapsed to 108px when
  // style.min.css attached, moving the whole page up 229px (Lighthouse CLS 0.242, 3 runs of 3,
  // confirmed in the trace). Only the rules that decide its HEIGHT are here; colour and hover
  // polish can still land with the deferred sheet. See test/header-first-paint.test.js.
  '#site-header',
  '#site-header, #site-footer',
  '.site-shell',
  '.top-controls',
  '.control-group',
  '.site-nav',
  '.site-nav a',
  '.site-nav, .site-nav-cta',
  '.site-nav-cta',
  '.site-mobile-drawer',
  '.header-menu-toggle',
  '.header-menu-toggle, .site-mobile-drawer, .site-mobile-drawer.open',
  '.site-logo',
  '.site-logo-icon',
  '.site-logo-text',
  '.site-logo-word',
  '.site-logo-tagline',
  '.header-util-cluster',
  '.font-size-pill',
  '.font-size-pill button',
  '.btn-sm',
  '.badge',
  // The promo ribbon lives in the same server-rendered header, and its min-height is what stops
  // the client's own /promotions fetch from shifting the page when it swaps the content.
  '.promo-ribbon',
  '.promo-banner',
  '.promo-banner-body',
  '.promo-banner-body strong',
  '.promo-banner-code',
  '.promo-banner-cta',
  '.promo-banner-dismiss',
  '.promo-ribbon-fallback',
  '.promo-ribbon .promo-banner',
  '.promo-ribbon .promo-banner-body',
  '.promo-ribbon .promo-banner-body strong',
  '.promo-ribbon .promo-banner-cta',
  '.promo-ribbon .promo-banner-code',
  '.promo-ribbon .promo-banner-dismiss',
  '#app',
  '#app.app-ssr-reserve', // the first-paint height reservation: must apply before style.min.css attaches
  'h1',
  '.hub-hero',
  '.hub-hero-panel',
  '.hub-hero-panel h1',
  '.hub-hero-panel p',
  '.hub-hero-kicker',
  '.hub-hero-panel .hub-hero-kicker',
  '.hub-hero-panel .btn-primary',
  '.hub-hero-panel .btn-secondary',
  '.hub-hero-panel .btn-link',
  '.hub-hero-side',
  '.hub-hero-panel .category-state-select',
  '.hub-hero-panel .category-state-select-label',
  '.hub-hero-panel #category-hero-subhead',
  '.hub-hero h1',
  '.hub-hero p',
  '.hub-hero-copy',
  '.hub-hero-cta',
  '.hub-hero-cta-early',
  '.hub-hero-btn',
  '.hub-hero-btn-late',
  '.btn-primary',
  '.section-eyebrow',
  '.badge-international',
  '#category-hero-headline',
  '#category-hero-subhead',
]);

// ':root', ':root[data-theme="light"]', ':root:not([data-theme="dark"])' -- style.css's three ways
// of scoping the same declarations to a theme. Stripped before matching so a themed override of a
// hero selector is kept alongside its default, and so the bare token blocks (which normalize to an
// empty selector) are kept in full: those ARE the design tokens the hero's colors resolve through.
const THEME_PREFIX = /^:root(?:\[data-theme="(?:light|dark)"\])?(?::not\(\[data-theme="(?:light|dark)"\]\))?/;

function normalizeSelector(part) {
  return part.trim().replace(THEME_PREFIX, '').trim();
}

// Which selector set collect() is currently matching against: HERO_SELECTORS for hero.css, or
// whatever extractRules()'s caller passed (scripts/build-cdl1-css.js).
let activeSelectors = HERO_SELECTORS;

function selectorMatches(prelude) {
  return prelude.split(',').some((part) => {
    const normalized = normalizeSelector(part);
    if (!normalized) return true; // a bare :root / themed :root block -- the token definitions
    return activeSelectors.has(normalized);
  });
}

// Splits a stylesheet (or the body of an @media block) into its top-level blocks. Brace-counting
// rather than a real CSS parser: style.css is flat (no native nesting), so one level of @media
// recursion is all this needs, and pulling in a parser dependency for it would be overkill.
function parseBlocks(css) {
  const blocks = [];
  let i = 0;
  while (i < css.length) {
    if (css.startsWith('/*', i)) { // comments never carry into the generated file
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    const braceAt = css.indexOf('{', i);
    if (braceAt === -1) break;
    const prelude = css.slice(i, braceAt).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    let depth = 1;
    let j = braceAt + 1;
    for (; j < css.length && depth; j++) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
    }
    blocks.push({ prelude, body: css.slice(braceAt + 1, j - 1) });
    i = j;
  }
  return blocks;
}

// Pulls every rule matching `selectors` (plus the :root token blocks and @font-face) out of
// style.css, preserving @media wrappers, and returns minified CSS. Shared with
// scripts/build-cdl1-css.js, which needs the same extraction over a different selector set.
function extractRules(styleCss, selectors) {
  const previous = activeSelectors;
  activeSelectors = selectors;
  try {
    return collect(styleCss);
  } finally {
    activeSelectors = previous;
  }
}

function buildHeroCss(styleCss) {
  return minify(collect(styleCss));
}

function minify(css) {
  const result = new CleanCSS({}).minify(css);
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  return result.styles;
}

function collect(styleCss) {
  const kept = [];
  for (const block of parseBlocks(styleCss)) {
    if (block.prelude.startsWith('@font-face')) {
      // Both @font-face rules in style.css are the two variable fonts the hero itself uses (Inter
      // for the subhead/button, Fraunces for the H1 -- the LCP element). Declaring them here means
      // the browser starts those fetches from the critical stylesheet instead of discovering them
      // when style.min.css attaches: on the throttled mobile profile they were arriving at 3.9s,
      // after the text had already painted in a fallback face.
      kept.push('@font-face{' + block.body.trim() + '}');
      continue;
    }
    if (block.prelude.startsWith('@media')) {
      const inner = parseBlocks(block.body).filter((r) => !r.prelude.startsWith('@') && selectorMatches(r.prelude));
      if (inner.length) {
        kept.push(block.prelude + '{' + inner.map((r) => r.prelude + '{' + r.body.trim() + '}').join('') + '}');
      }
      continue;
    }
    if (block.prelude.startsWith('@')) continue; // @keyframes/@supports: nothing the static hero needs
    if (selectorMatches(block.prelude)) kept.push(block.prelude + '{' + block.body.trim() + '}');
  }
  return kept.join('\n');
}

// ---- Inlining, and the CSP hash that allows it ------------------------------------------------
// The critical CSS is written INTO index.html rather than linked, because a blocking <link> was the
// page's only render-blocking request -- one extra round trip in front of the first paint on every
// cold visit (PageSpeed, 2026-09-17: "Render-blocking requests, est. savings 170ms").
//
// index.html's own comment used to say this was impossible, since _headers pins style-src to
// 'self' with no 'unsafe-inline'. That is true of 'unsafe-inline'; a 'sha256-...' source instead
// allows exactly one known block of bytes, which is stricter than allowing a whole stylesheet by
// URL. The hash is computed here and written into _headers, never typed by hand -- if the two ever
// drift apart the browser refuses the style and the hero paints unstyled, so
// test/critical-css-inline.test.js recomputes it from both files on every run.
const INDEX_HTML = path.join(__dirname, '..', 'wwwroot', 'index.html');
const HEADERS_FILE = path.join(__dirname, '..', 'wwwroot', '_headers');
const BEGIN = '<!-- BEGIN-CRITICAL-CSS';
const END = '<!-- END-CRITICAL-CSS -->';

function cspHash(css) {
  return "'sha256-" + crypto.createHash('sha256').update(css, 'utf8').digest('base64') + "'";
}

// The block is emitted on ONE line, with no whitespace between <style> and the CSS: minified output
// has no newlines of its own, and keeping it that way means a CRLF conversion on checkout has
// nothing inside the block to rewrite -- which would otherwise change the bytes the browser hashes
// and silently break every first paint.
function inlineIntoIndex(css) {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const start = html.indexOf(BEGIN);
  const end = html.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error('index.html is missing its ' + BEGIN + ' ... ' + END + ' markers');
  }
  const block = BEGIN + ' generated by scripts/build-hero-css.js -- do not edit by hand -->' +
    '<style>' + css + '</style>' + '\n' + END;
  const next = html.slice(0, start) + block + html.slice(end + END.length);
  if (next !== html) fs.writeFileSync(INDEX_HTML, next, 'utf8');
  return next !== html;
}

// Rewrites the hash in the SITE-WIDE CSP only (the first Content-Security-Policy line). The scoped
// one further down the file belongs to the embeddable /embed/qotd/ widget, which inlines nothing.
function setCspHash(css) {
  const headers = fs.readFileSync(HEADERS_FILE, 'utf8');
  const lines = headers.split(String.fromCharCode(10));
  const at = lines.findIndex((l) => l.includes('Content-Security-Policy:'));
  if (at === -1) throw new Error('_headers has no Content-Security-Policy line to update');
  const wanted = "style-src 'self' " + cspHash(css) + ';';
  const updated = lines[at].replace(/style-src[^;]*;/, wanted);
  if (!updated.includes(wanted)) throw new Error('could not rewrite style-src in the site-wide CSP');
  if (updated === lines[at]) return false;
  lines[at] = updated;
  fs.writeFileSync(HEADERS_FILE, lines.join(String.fromCharCode(10)), 'utf8');
  return true;
}

function main() {
  const styleCss = fs.readFileSync(CSS_SRC, 'utf8');
  const heroCss = buildHeroCss(styleCss);
  fs.writeFileSync(CSS_OUT, heroCss, 'utf8');
  const inlined = inlineIntoIndex(heroCss.trim());
  const rehashed = setCspHash(heroCss.trim());
  console.log(`hero.css: ${Buffer.byteLength(heroCss, 'utf8').toLocaleString()} bytes from style.css's ${Buffer.byteLength(styleCss, 'utf8').toLocaleString()}` +
    ` (inlined into index.html${inlined ? '' : ', unchanged'}${rehashed ? ', CSP hash updated' : ''})`);
}

module.exports = { buildHeroCss, extractRules, minify, cspHash, inlineIntoIndex, setCspHash };

if (require.main === module) main();
