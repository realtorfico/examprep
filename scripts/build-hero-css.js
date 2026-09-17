// Generates wwwroot/css/hero.css -- the small BLOCKING stylesheet that styles the server-rendered
// category hero (see the SSR-HERO block in wwwroot/_worker.js) at first paint.
//
// Why a separate file rather than a few inlined rules: _headers pins style-src to 'self' with no
// 'unsafe-inline', so an inline <style> block would be silently dropped, exactly like an inline
// <script> (see turnstile-callback.js's header for the same reasoning). And why blocking rather
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
  '#app',
  'h1',
  '.hub-hero',
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

function selectorMatches(prelude) {
  return prelude.split(',').some((part) => {
    const normalized = normalizeSelector(part);
    if (!normalized) return true; // a bare :root / themed :root block -- the token definitions
    return HERO_SELECTORS.has(normalized);
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

function buildHeroCss(styleCss) {
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

  const result = new CleanCSS({}).minify(kept.join('\n'));
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  return result.styles;
}

function main() {
  const styleCss = fs.readFileSync(CSS_SRC, 'utf8');
  const heroCss = buildHeroCss(styleCss);
  fs.writeFileSync(CSS_OUT, heroCss, 'utf8');
  console.log(`hero.css: ${Buffer.byteLength(heroCss, 'utf8').toLocaleString()} bytes from style.css's ${Buffer.byteLength(styleCss, 'utf8').toLocaleString()}`);
}

module.exports = { buildHeroCss };

if (require.main === module) main();
