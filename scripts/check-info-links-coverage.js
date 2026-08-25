// Reports every ACTIVE HUB_EXAMS track with no matching ADDITIONAL_INFO_LINKS entry (both in
// wwwroot/js/app.js). The two tables are keyed the same way (examType) but nothing enforces they
// stay in sync -- that's exactly how this went stale before: only ca_notary was ever filled in,
// and every batch of new tracks added since (real estate, driver, motorcycle, CDL) skipped
// ADDITIONAL_INFO_LINKS entirely, leaving the track landing page's "Official exam info" link
// silently empty for ~211 of 212 active tracks until a dedicated 2026-08-25 research pass filled
// in notary/real_estate/cdl.
//
// Run this after adding ANY new batch of HUB_EXAMS entries, to catch the gap immediately instead
// of it becoming its own separate research task later:
//   node scripts/check-info-links-coverage.js
// This only reports what's missing -- it can't fill entries in for you. Each one needs a real,
// individually verified official source URL (regulating agency page, and where the state
// genuinely uses one, the testing vendor/exam portal) -- never a fabricated or guessed URL.
const fs = require('fs');
const path = require('path');
const appJsPath = path.join(__dirname, '..', 'wwwroot', 'js', 'app.js');
const src = fs.readFileSync(appJsPath, 'utf8');

function extractObject(varName) {
  const start = src.indexOf('var ' + varName + ' = ');
  if (start === -1) throw new Error(varName + ' not found');
  const braceStart = src.indexOf(varName.endsWith('EXAMS') ? '[' : '{', start);
  const openChar = src[braceStart];
  const closeChar = openChar === '[' ? ']' : '}';
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === openChar) depth++;
    else if (src[i] === closeChar) {
      depth--;
      if (depth === 0) return eval('(' + src.slice(braceStart, i + 1) + ')');
    }
  }
  throw new Error('no matching close bracket for ' + varName);
}

const HUB_EXAMS = extractObject('HUB_EXAMS');
const ADDITIONAL_INFO_LINKS = extractObject('ADDITIONAL_INFO_LINKS');

const activeKinds = new Map(); // examKind -> [{examType, stateCode}]
for (const e of HUB_EXAMS) {
  if (!e.active) continue;
  const links = ADDITIONAL_INFO_LINKS[e.examType];
  if (links && links.length) continue;
  if (!activeKinds.has(e.examKind)) activeKinds.set(e.examKind, []);
  activeKinds.get(e.examKind).push(e);
}

const totalActive = HUB_EXAMS.filter((e) => e.active).length;
const totalMissing = [...activeKinds.values()].reduce((sum, list) => sum + list.length, 0);

if (totalMissing === 0) {
  console.log('All ' + totalActive + ' active tracks have an ADDITIONAL_INFO_LINKS entry.');
  process.exit(0);
}

console.log(totalMissing + ' of ' + totalActive + ' active tracks are missing an ADDITIONAL_INFO_LINKS entry:\n');
for (const [kind, list] of activeKinds) {
  console.log(kind + ' (' + list.length + '):');
  console.log('  ' + list.map((e) => e.stateCode).sort().join(', '));
}
process.exit(1);
