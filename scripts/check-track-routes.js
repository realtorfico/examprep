// Reports every ACTIVE track (per the live /api/track-registry) whose HUB_EXAMS_CONTENT entry
// (wwwroot/js/app.js) still has route:'#' -- the inactive-scaffold placeholder every new track
// kind starts with (see MLO). Nothing enforces this gets updated when a track's `active` flag
// flips to true in D1 -- that's exactly what happened to ACT (2026-09-08): its route was left at
// '#' after going active, which silently made the track page and buy flow completely unreachable
// (activeTrackForPath() explicitly excludes route==='#' tracks, so /act/us fell through to the
// homepage, and the category page's "View full track details" link was a dead href="#"). Caught
// only by a user report, not by any test -- the existing jsdom test suite can't catch this class of
// bug at all, since test-support/boot-app.js's own fixture generator ALSO filters out route==='#'
// entries (see its own comment), so a stuck-at-'#' track is invisible to every existing test too.
//
// Run this after activating any track (flipping active 0->1 in track_registry), or as a periodic
// sanity check:
//   node scripts/check-track-routes.js
// This only reports the mismatch -- it can't fix the route for you (the correct value depends on
// the track's real kind slug + state code, or lack thereof for a national track).
const fs = require('fs');
const path = require('path');
const https = require('https');
const appJsPath = path.join(__dirname, '..', 'wwwroot', 'js', 'app.js');
const src = fs.readFileSync(appJsPath, 'utf8');

function extractArray(varName) {
  const start = src.indexOf('var ' + varName + ' = ');
  if (start === -1) throw new Error(varName + ' not found');
  const bracketStart = src.indexOf('[', start);
  let depth = 0;
  for (let i = bracketStart; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) return eval('(' + src.slice(bracketStart, i + 1) + ')');
    }
  }
  throw new Error('no matching close bracket for ' + varName);
}

const HUB_EXAMS_CONTENT = extractArray('HUB_EXAMS_CONTENT');
const contentByExamType = new Map(HUB_EXAMS_CONTENT.map((c) => [c.examType, c]));

function fetchTrackRegistry() {
  return new Promise((resolve, reject) => {
    https.get('https://passexamhq.com/api/track-registry', (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('track-registry fetch failed: HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body).tracks || []); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

fetchTrackRegistry().then((tracks) => {
  const activeTracks = tracks.filter((e) => e.active);
  const broken = [];
  const missingContent = [];

  for (const e of activeTracks) {
    const content = contentByExamType.get(e.examType);
    if (!content) { missingContent.push(e); continue; }
    if (content.route === '#') broken.push(e);
  }

  if (broken.length === 0 && missingContent.length === 0) {
    console.log('All ' + activeTracks.length + ' active tracks have a real (non-\'#\') HUB_EXAMS_CONTENT route.');
    process.exit(0);
  }

  if (broken.length) {
    console.log(broken.length + ' ACTIVE track(s) still have route:\'#\' -- completely unreachable:\n');
    for (const e of broken) console.log('  ' + e.examType + ' (' + e.examKind + ', ' + e.stateCode + ')');
    console.log('');
  }
  if (missingContent.length) {
    console.log(missingContent.length + ' ACTIVE track(s) have no HUB_EXAMS_CONTENT entry at all:\n');
    for (const e of missingContent) console.log('  ' + e.examType + ' (' + e.examKind + ', ' + e.stateCode + ')');
  }
  process.exit(1);
}).catch((err) => {
  console.error('Failed to check track routes: ' + err.message);
  process.exit(2);
});
