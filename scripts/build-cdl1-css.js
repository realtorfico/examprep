// Generates wwwroot/css/cdl1.min.css: the ONE stylesheet the /cdl1 prototype blocks on.
//
// The prototype first shipped linking hero.css + style.min.css + cdl1.css. Measured against /cdl
// (Pixel 7, 1.6Mbps, 4x CPU) that cost it: first paint 1,820ms vs 1,190ms, because style.min.css is
// 86KB of blocking CSS for a page that uses a couple of dozen of its rules -- the real page never
// blocks on it (load-css.js attaches it after parse). Its LCP was still far better (1,820ms vs
// 3,400ms) since everything is in the HTML, but blocking on the whole site stylesheet was pure
// waste.
//
// So this extracts only what the page actually inherits from style.css -- the design tokens, the
// base element rules, the button and form-control rules -- and concatenates cdl1.css's own page
// rules, minified into one file. Same generated-not-hand-written reasoning as hero.css: the tokens
// have been retuned three times, and a hand-copied set would drift silently.
//
// Run via `npm run build`, or standalone:
//   node scripts/build-cdl1-css.js
const fs = require('fs');
const path = require('path');
const { extractRules, minify } = require('./build-hero-css');

const STYLE_SRC = path.join(__dirname, '..', 'wwwroot', 'css', 'style.css');
const PAGE_SRC = path.join(__dirname, '..', 'wwwroot', 'css', 'cdl1.css');
const OUT = path.join(__dirname, '..', 'wwwroot', 'css', 'cdl1.min.css');

// What /cdl1 inherits from the site stylesheet. Everything else it needs is in cdl1.css under its
// own .t1-* names. Kept as an explicit list so adding a shared class to the page is a deliberate
// edit here -- the point of this file is that it stays small.
const INHERITED = new Set([
  '*',                 // box-sizing: border-box
  'html',              // root font size, which --font-scale feeds
  'body',              // background, base font, the ambient background gradients
  'a',                 // link colour
  'h1',                // grouped "h1, h2": Fraunces, line-height, letter-spacing
  'button',            // grouped with the .btn-* classes: padding, radius, cursor, font
  '.btn-primary',      // the page's primary CTA
  'select',            // grouped with the inputs: the state picker's border/background/focus
  'select:focus-visible',
  '.muted',
]);

function buildCdl1Css(styleCss, pageCss) {
  const inherited = extractRules(styleCss, INHERITED);
  return minify(inherited + '\n' + pageCss);
}

function main() {
  const out = buildCdl1Css(fs.readFileSync(STYLE_SRC, 'utf8'), fs.readFileSync(PAGE_SRC, 'utf8'));
  fs.writeFileSync(OUT, out, 'utf8');
  console.log(`cdl1.min.css: ${Buffer.byteLength(out, 'utf8').toLocaleString()} bytes (was style.min.css's 85,797 + hero.css + cdl1.css)`);
}

module.exports = { buildCdl1Css };

if (require.main === module) main();
