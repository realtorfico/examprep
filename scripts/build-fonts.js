// Subsets the two variable fonts in wwwroot/fonts/ to the characters this site actually renders.
//
// Why: the fonts have to be preloaded. Measured 2026-09-17, without a preload they arrive after the
// first paint and the swap re-wraps the header's promo ribbon, which moved the whole page -- an
// intermittent CLS of 0.18 (it showed up in 2 of 4 runs, invisible in the others, which is what
// makes font-swap shifts easy to miss). With a preload, CLS is 0. But preloading the full 113KB of
// font cost ~420ms of first contentful paint on a 1.6Mbps link, because a font preload is
// high-priority and outranks everything else.
//
// Subsetting resolves that trade: the fonts only ever render Latin text plus a handful of symbols,
// while the shipped files carry the full Google Fonts latin range (and Fraunces a wide optical-size
// axis). Everything else is a system fallback anyway -- emoji in the UI (🎯 📍 ✕) come from the
// platform emoji font, not from these files.
//
// Both are VARIABLE fonts and the CSS uses a weight range (Inter 100-900, Fraunces 300-700), so the
// weight axis is kept -- this only drops glyphs, never axes.
//
// Sources stay in wwwroot/fonts/: <name>-var-latin.woff2 is the original download, and
// <name>-var-subset.woff2 is what index.html/hero.css reference. Re-run after changing either
// source font or after adding UI copy in a new script:
//   node scripts/build-fonts.js
const fs = require('fs');
const path = require('path');
const subsetFont = require('subset-font');

const FONT_DIR = path.join(__dirname, '..', 'wwwroot', 'fonts');

// Basic Latin + Latin-1 (accented names in testimonials), the punctuation this site's copy uses
// (curly quotes, en/em dash, ellipsis), and the arrows/marks that appear in real UI strings:
// → (links), ↓ (pick your state), ✓ (trust badges), ✕ (dismiss). Kept as an explicit list rather
// than "latin + symbols" so adding a new glyph to the UI is a deliberate edit here.
const KEEP = [
  ...range(0x20, 0x7e), // ASCII
  ...range(0xa0, 0xff), // Latin-1 Supplement
  0x2018, 0x2019, 0x201c, 0x201d, // ' ' " "
  0x2013, 0x2014, 0x2026, // – — …
  0x2192, 0x2193, // → ↓
  0x2713, 0x2715, // ✓ ✕
  0x00d7, // ×
];

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

const TEXT = KEEP.map((cp) => String.fromCodePoint(cp)).join('');

async function main() {
  for (const name of ['inter', 'fraunces']) {
    const src = path.join(FONT_DIR, name + '-var-latin.woff2');
    const out = path.join(FONT_DIR, name + '-var-subset.woff2');
    const before = fs.readFileSync(src);
    const after = await subsetFont(before, TEXT, { targetFormat: 'woff2', variationAxes: undefined });
    fs.writeFileSync(out, after);
    console.log(
      (name + '-var-subset.woff2').padEnd(28) +
      (before.length / 1024).toFixed(0) + 'KB -> ' + (after.length / 1024).toFixed(0) + 'KB' +
      ' (' + Math.round((1 - after.length / before.length) * 100) + '% smaller)',
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
