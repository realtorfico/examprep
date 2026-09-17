// Splits the per-track content catalog out of wwwroot/js/app.js into one file per exam kind under
// wwwroot/js/content/, so a page parses only the catalog it needs.
//
// Why: HUB_EXAMS_CONTENT is one array literal holding all ~290 tracks' display content (title,
// route, duration, question count, pass score, topic breakdown, and the sourcing comments that
// justify each breakdown). Measured 2026-09-17 it is 187KB minified and 24.5KB brotli -- 42% of
// app.min.js's parse cost and 30% of its wire size -- and a CDL ad landing page needs 50 of those
// 290 entries. Everything else is parsed and thrown away on the critical path of the site's
// highest-traffic pages.
//
// The seam is clean: the catalog has exactly one consumer, buildHubExams(), reached only through
// loadTrackRegistry(), which is already an awaited async gate before the first render.
//
// Grouping is by the kind slug in each entry's own `route` ('/cdl/ca' -> cdl, '/act' -> act), so
// this needs no map of its own and can't disagree with the routes the site actually links to.
//
// Run via `npm run build` (build-minified-js.js calls this), or standalone:
//   node scripts/build-track-content.js
const fs = require('fs');
const path = require('path');

const APP_JS = path.join(__dirname, '..', 'wwwroot', 'js', 'app.js');
const OUT_DIR = path.join(__dirname, '..', 'wwwroot', 'js', 'content');
// One-time migration, kept for the record: after it has run, the generated files under
// wwwroot/js/content/ ARE the source of truth for track content and are edited directly (one file
// per kind, which is how track work is scoped anyway). Re-running once the literal is gone is a
// no-op, not an error.
const MARKER = 'var HUB_EXAMS_CONTENT = [';

// Walks a JS source string with string/comment awareness, returning the index just past the
// matching close bracket of the array that starts at `open`. Brace/bracket counting alone would
// trip over the '[' and ']' inside the breakdown strings and the prose comments.
function endOfArray(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n === -1 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n === -1 ? src.length : n + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      for (; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('unterminated array literal starting at ' + open);
}

// Splits the array body into entry sources at top-level commas, keeping each entry's leading
// comments attached to it -- those comments record where every breakdown percentage came from
// (which handbook, which pages), so they must travel with their entry, not be dropped.
function splitEntries(body) {
  const entries = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '/' && body[i + 1] === '/') { const n = body.indexOf('\n', i); i = n === -1 ? body.length : n; continue; }
    if (c === '/' && body[i + 1] === '*') { const n = body.indexOf('*/', i + 2); i = n === -1 ? body.length : n + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      for (; i < body.length; i++) {
        if (body[i] === '\\') { i++; continue; }
        if (body[i] === q) break;
      }
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      const chunk = body.slice(start, i).trim();
      if (chunk) entries.push(chunk);
      start = i + 1;
    }
  }
  const last = body.slice(start).trim();
  if (last) entries.push(last);
  return entries;
}

// Comments must be stripped before reading an entry's fields: several entries discuss their own
// history in prose that quotes field syntax verbatim (the ACT entry's comment explains why its
// route used to be '#'), and a naive match picks the comment's value over the real one.
function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function kindSlugOfEntry(src) {
  // The route is the grouping key: '/cdl/ca' -> 'cdl', '/act' -> 'act'. Two entries (mlo, act)
  // carry the route placeholder '#' -- "nothing links here" -- so they have no kind page to be
  // grouped under; they go in unrouted.js, which app.js always loads (3KB) so their content stays
  // available exactly as it is today.
  const m = withoutComments(src).match(/route:\s*'([^']+)'/);
  if (!m) throw new Error('entry has no route: ' + src.slice(0, 120));
  if (m[1].charAt(0) !== '/') return 'unrouted';
  return m[1].split('/').filter(Boolean)[0];
}

function buildTrackContent(appJs) {
  const start = appJs.indexOf(MARKER);
  if (start === -1) throw new Error(MARKER + ' not found in app.js -- the catalog marker moved');
  const open = appJs.indexOf('[', start);
  const end = endOfArray(appJs, open);
  const body = appJs.slice(open + 1, end - 1);
  const entries = splitEntries(body);

  const bySlug = {};
  const seen = new Set();
  for (const entry of entries) {
    const examType = (withoutComments(entry).match(/examType:\s*'([^']+)'/) || [])[1];
    if (!examType) throw new Error('entry has no examType: ' + entry.slice(0, 120));
    if (seen.has(examType)) throw new Error('duplicate examType in catalog: ' + examType);
    seen.add(examType);
    const slug = kindSlugOfEntry(entry);
    (bySlug[slug] = bySlug[slug] || []).push(entry);
  }
  return { bySlug, total: entries.length };
}

function fileFor(slug, entries) {
  return '// Generated by scripts/build-track-content.js from the catalog in js/app.js -- do not edit.\n' +
    '// Loaded on demand by loadTrackContentFile() in app.js; registers itself on arrival.\n' +
    'window.registerTrackContent(' + JSON.stringify(slug) + ', [\n' +
    entries.map((e) => '  ' + e.replace(/\n/g, '\n  ')).join(',\n') + ',\n' +
    ']);\n';
}

function main() {
  const appJs = fs.readFileSync(APP_JS, 'utf8');
  if (appJs.indexOf(MARKER) === -1) {
    console.log('Nothing to extract: wwwroot/js/content/*.js is already the source of truth for track content.');
    return;
  }
  const { bySlug, total } = buildTrackContent(appJs);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Remove files for kinds that no longer exist, so a renamed slug can't leave a stale catalog
  // sitting in wwwroot being served to browsers.
  for (const existing of fs.readdirSync(OUT_DIR)) {
    if (existing.endsWith('.js') && !bySlug[existing.replace(/\.js$/, '')]) {
      fs.unlinkSync(path.join(OUT_DIR, existing));
      console.log('removed stale content file: ' + existing);
    }
  }

  let bytes = 0;
  for (const slug of Object.keys(bySlug).sort()) {
    const out = fileFor(slug, bySlug[slug]);
    fs.writeFileSync(path.join(OUT_DIR, slug + '.js'), out, 'utf8');
    bytes += Buffer.byteLength(out, 'utf8');
    console.log('  ' + (slug + '.js').padEnd(28) + String(bySlug[slug].length).padStart(4) + ' tracks  ' + (Buffer.byteLength(out, 'utf8') / 1024).toFixed(0) + 'KB');
  }
  console.log('track content: ' + total + ' tracks across ' + Object.keys(bySlug).length + ' files, ' + (bytes / 1024).toFixed(0) + 'KB total');
}

module.exports = { buildTrackContent, endOfArray, splitEntries };

if (require.main === module) main();
