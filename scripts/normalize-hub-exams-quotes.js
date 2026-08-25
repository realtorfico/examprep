// Normalizes every double-quoted string literal inside HUB_EXAMS (wwwroot/js/app.js) to
// single-quoted, matching the rest of the codebase's style.
//
// Why this exists: past batches of HUB_EXAMS entries (e.g. the 2026-08 real-estate/notary/driver
// expansions) were pasted in from JSON draft files -- JSON requires double quotes, and nothing
// converted them on the way in, so the array ended up with two coexisting quote styles. That's
// more than cosmetic: any later regex-based script written against "the" HUB_EXAMS quote style
// (e.g. a URL-scheme rewrite) will silently skip every entry using the other style, with no error
// -- this bit once already (see 2026-08-24 category-first routing rewrite).
//
// Run this after pasting ANY new batch of hand-drafted or JSON-derived entries into HUB_EXAMS,
// before committing:
//   node scripts/normalize-hub-exams-quotes.js
// It's idempotent (a second run finds nothing to convert) and only touches string literals inside
// the HUB_EXAMS array -- nothing elsewhere in app.js.
//
// Known residual: TRACK_COMPLIANCE and RESOURCES (also in app.js) have the same mixed-quote-style
// issue from the same source batches, not yet normalized -- extend this script to cover them
// (same tokenizer, different start marker) before writing a mechanical rewrite against either.
const fs = require('fs');
const path = require('path');
const appJsPath = path.join(__dirname, '..', 'wwwroot', 'js', 'app.js');
let src = fs.readFileSync(appJsPath, 'utf8');

function findMatchingBracket(s, openIdx) {
  let depth = 0, inLineComment = false, inSingle = false, inDouble = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i], prev = s[i - 1];
    if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
    if (inSingle) { if (ch === "'" && prev !== '\\') inSingle = false; continue; }
    if (inDouble) { if (ch === '"' && prev !== '\\') inDouble = false; continue; }
    if (ch === '/' && s[i + 1] === '/') { inLineComment = true; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('no matching bracket found from ' + openIdx);
}

const startMarker = 'var HUB_EXAMS = [';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) throw new Error('HUB_EXAMS not found -- has it been renamed/moved?');
const arrayStart = startIdx + startMarker.length - 1;
const arrayEnd = findMatchingBracket(src, arrayStart);
const arrayInner = src.slice(arrayStart + 1, arrayEnd);

let out = '';
let i = 0, inLineComment = false, inSingle = false;
let convertedCount = 0;
const warnings = [];
while (i < arrayInner.length) {
  const ch = arrayInner[i];
  if (inLineComment) {
    out += ch;
    if (ch === '\n') inLineComment = false;
    i++; continue;
  }
  if (inSingle) {
    out += ch;
    if (ch === '\\' && i + 1 < arrayInner.length) { out += arrayInner[i + 1]; i += 2; continue; }
    if (ch === "'") inSingle = false;
    i++; continue;
  }
  if (ch === '/' && arrayInner[i + 1] === '/') { inLineComment = true; out += ch; i++; continue; }
  if (ch === "'") { inSingle = true; out += ch; i++; continue; }
  if (ch === '"') {
    let j = i + 1, raw = '';
    while (j < arrayInner.length && arrayInner[j] !== '"') {
      if (arrayInner[j] === '\\' && j + 1 < arrayInner.length) { raw += arrayInner[j] + arrayInner[j + 1]; j += 2; continue; }
      raw += arrayInner[j]; j++;
    }
    const decoded = raw.replace(/\\"/g, '"');
    if (/\\/.test(decoded)) warnings.push(JSON.stringify(decoded).slice(0, 100));
    out += "'" + decoded.replace(/'/g, "\\'") + "'";
    convertedCount++;
    i = j + 1;
    continue;
  }
  out += ch;
  i++;
}

if (warnings.length) {
  console.log('WARNING: literal backslash found in ' + warnings.length + ' string(s) -- review before trusting the auto-escape:');
  warnings.forEach((w) => console.log(' -', w));
}

fs.writeFileSync(appJsPath, src.slice(0, arrayStart + 1) + out + src.slice(arrayEnd), 'utf8');
console.log('double-quoted strings converted to single-quoted:', convertedCount);
