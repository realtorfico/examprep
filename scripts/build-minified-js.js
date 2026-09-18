// Minifies the site's two large first-party assets into separate deploy artifacts:
//   wwwroot/js/app.js    -> wwwroot/js/app.min.js
//   wwwroot/css/style.css -> wwwroot/css/style.min.css
// The source files stay the ones to edit -- app.js is what test-support/boot-app.js reads
// directly by path, and both source files are what every future edit in this repo should keep
// touching. This script only produces SEPARATE deploy artifacts; it never overwrites the sources.
//
// Deliberately NOT minified: config.js, api.js, speech.js, gtag-init.js, clarity-init.js,
// turnstile.js -- all under 1KB each, so minifying them saves a few hundred bytes total,
// immaterial to load time. Also not minified/touched: the third-party scripts (gtag.js, Turnstile,
// Clarity, Cloudflare Insights) -- we don't serve those files, so there's nothing here to minify.
//
// Why this exists: a PageSpeed Insights mobile audit (2026-09-13) found app.js at 692KB and
// style.css at 140KB, both unminified -- the two largest first-party contributors to a poor mobile
// Performance score (raw parse/execute or parse/style-compute cost on a throttled mobile CPU,
// independent of network speed -- Cloudflare's edge compression already shrinks the wire-transfer
// size, but does nothing for that parse-time cost).
//
// Run this after every change to app.js or style.css, before committing/pushing:
//   node scripts/build-minified-js.js
// then bump the changed file's ?v= in index.html. There is no CI/build-step wired up to run this
// automatically (Cloudflare Pages here deploys wwwroot/ verbatim, see wrangler.jsonc) -- forgetting
// this step doesn't break anything, it just means the live site keeps serving the last-built
// minified bundle instead of your latest source edit, so don't skip it.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { minify } = require('terser');
const CleanCSS = require('clean-css');

const JS_SRC = path.join(__dirname, '..', 'wwwroot', 'js', 'app.js');
const JS_OUT = path.join(__dirname, '..', 'wwwroot', 'js', 'app.min.js');
// The deep bundle (js/app-deep.js): the static/legal/marketing routes, fetched on demand. Its
// minified artifact is hashed and the hash written into app.min.js, so a changed deep bundle busts
// its own cache -- there is no ?v= for it in index.html, because index.html never references it.
const DEEP_SRC = path.join(__dirname, '..', 'wwwroot', 'js', 'app-deep.js');
const DEEP_OUT = path.join(__dirname, '..', 'wwwroot', 'js', 'app-deep.min.js');
const CSS_SRC = path.join(__dirname, '..', 'wwwroot', 'css', 'style.css');
const CSS_OUT = path.join(__dirname, '..', 'wwwroot', 'css', 'style.min.css');
// Third artifact, added 2026-09-17: the critical stylesheet for the server-rendered category hero.
// Extracted from the same style.css source, so it's built here rather than maintained by hand --
// see scripts/build-hero-css.js for why it exists at all.
const { buildHeroCss, inlineIntoIndex, setCspHash } = require('./build-hero-css');
const { buildCdl1Css } = require('./build-cdl1-css');
const HERO_CSS_OUT = path.join(__dirname, '..', 'wwwroot', 'css', 'hero.css');

function report(label, before, after) {
  console.log(`${label}: ${before.toLocaleString()} bytes -> ${after.toLocaleString()} bytes (${Math.round((1 - after / before) * 100)}% smaller)`);
}

async function main() {
  // Deep bundle first: app.min.js embeds its content hash.
  const deepSrc = fs.readFileSync(DEEP_SRC, 'utf8');
  const deepResult = await minify(deepSrc, { compress: true, mangle: true, format: { comments: false } });
  if (deepResult.error) throw deepResult.error;
  fs.writeFileSync(DEEP_OUT, deepResult.code, 'utf8');
  report('app-deep.js', Buffer.byteLength(deepSrc, 'utf8'), Buffer.byteLength(deepResult.code, 'utf8'));
  const deepHash = crypto.createHash('sha256').update(deepResult.code, 'utf8').digest('hex').slice(0, 12);

  const jsSrc = fs.readFileSync(JS_SRC, 'utf8');
  // The placeholder stays in the SOURCE (app.js is what every edit and every test reads); only the
  // minified artifact carries the real hash.
  if (!jsSrc.includes('DEEP_BUNDLE_HASH')) throw new Error('app.js lost its DEEP_BUNDLE_HASH placeholder');
  const jsResult = await minify(jsSrc.replace('DEEP_BUNDLE_HASH', deepHash), { compress: true, mangle: true, format: { comments: false } });
  if (jsResult.error) throw jsResult.error;
  fs.writeFileSync(JS_OUT, jsResult.code, 'utf8');
  report('app.js', Buffer.byteLength(jsSrc, 'utf8'), Buffer.byteLength(jsResult.code, 'utf8'));

  const cssSrc = fs.readFileSync(CSS_SRC, 'utf8');
  const cssResult = new CleanCSS({}).minify(cssSrc);
  if (cssResult.errors.length) throw new Error(cssResult.errors.join('\n'));
  fs.writeFileSync(CSS_OUT, cssResult.styles, 'utf8');
  report('style.css', Buffer.byteLength(cssSrc, 'utf8'), Buffer.byteLength(cssResult.styles, 'utf8'));

  const heroCss = buildHeroCss(cssSrc);
  fs.writeFileSync(HERO_CSS_OUT, heroCss, 'utf8');
  // ...and into index.html, with its CSP hash: the critical CSS is inlined, not linked, so this is
  // the step that keeps the document and the policy in step with style.css.
  inlineIntoIndex(heroCss.trim());
  setCspHash(heroCss.trim());
  report('style.css -> hero.css (inlined, CSP hashed)', Buffer.byteLength(cssSrc, 'utf8'), Buffer.byteLength(heroCss, 'utf8'));

  // The /cdl1 prototype's single blocking stylesheet: what it inherits from style.css plus its own
  // page rules. See scripts/build-cdl1-css.js.
  const cdl1Src = path.join(__dirname, '..', 'wwwroot', 'css', 'cdl1.css');
  if (fs.existsSync(cdl1Src)) {
    const cdl1Css = buildCdl1Css(cssSrc, fs.readFileSync(cdl1Src, 'utf8'));
    fs.writeFileSync(path.join(__dirname, '..', 'wwwroot', 'css', 'cdl1.min.css'), cdl1Css, 'utf8');
    report('style.css + cdl1.css -> cdl1.min.css', Buffer.byteLength(cssSrc, 'utf8'), Buffer.byteLength(cdl1Css, 'utf8'));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
