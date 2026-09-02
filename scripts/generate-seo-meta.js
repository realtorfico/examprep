// Generates the per-route SEO metadata (title + truncated description) that _worker.js injects
// into the SPA shell's <title>/<meta name="description"> for every active track page, plus writes
// wwwroot/sitemap.xml. Title/description/route come from HUB_EXAMS_CONTENT in wwwroot/js/app.js
// (content-only since the 2026-08-30 track_registry migration); `active` status is no longer a
// field on those objects at all (it lives in D1 now, the whole point of that migration) -- fetched
// live from the public /track-registry endpoint instead. This script mechanically derives both
// outputs rather than hand-duplicating title/description text a second time (which would just be
// one more thing to drift out of sync, like the quote-style bug normalize-hub-exams-quotes.js
// exists to fix).
//
// IMPORTANT: requires network access (fetches live /track-registry) and requires that endpoint's
// data to already be current for any track this run is meant to include -- if you just added a
// brand-new track_registry row, make sure it's actually deployed/live before running this, or the
// new route will be silently excluded from SEO_META/sitemap.xml this pass (rerun once it's live).
//
// Run after adding/changing any HUB_EXAMS_CONTENT entry (new track, retitled description) or
// flipping a track's active status in admin, before deploying:
//   node scripts/generate-seo-meta.js
// It rewrites the SEO_META block inside _worker.js (between the SEO_META_START/END markers) and
// regenerates wwwroot/sitemap.xml in place. Idempotent.
const fs = require('fs');
const path = require('path');
const appJsPath = path.join(__dirname, '..', 'wwwroot', 'js', 'app.js');
const workerPath = path.join(__dirname, '..', 'wwwroot', '_worker.js');
const sitemapPath = path.join(__dirname, '..', 'wwwroot', 'sitemap.xml');
const SITE_ORIGIN = 'https://passexamhq.com';
const TRACK_REGISTRY_URL = SITE_ORIGIN + '/api/track-registry';
const BLOG_LIST_URL = SITE_ORIGIN + '/api/blog';

const BLOG_INDEX_META = {
  title: 'Guides & Tips — Exam Prep Articles | PassExamHQ',
  description: 'Guides and tips for passing your licensing exam, from notary to real estate to boating safety.',
};

// Static /guides/* "requirements by state" pages, built by scripts/generate-guides.js -- their
// SEO_META lives in GUIDES_SEO_META in _worker.js (hand-maintained, outside the SEO_META_START/END
// block this script rewrites), but their sitemap.xml entries are added here so a full sitemap
// regen doesn't drop them.
const GUIDE_URLS = [
  '/guides/notary-requirements-by-state',
  '/guides/real-estate-salesperson-requirements-by-state',
  '/guides/real-estate-broker-requirements-by-state',
  '/guides/driver-requirements-by-state',
  '/guides/cdl-requirements-by-state',
  '/guides/motorcycle-requirements-by-state',
  '/guides/boating-requirements-by-state',
];

const CATEGORY_META = {
  'notary': {
    label: 'Notary',
    title: 'Notary Public Exam Prep — Practice Tests for Every State | PassExamHQ',
    description: "Practice questions for your state's notary public exam, built from official handbooks. Instant access, no subscription.",
  },
  'driver': {
    label: 'Driver',
    title: "Driver's License Knowledge Test Practice — All 50 States | PassExamHQ",
    description: 'Practice questions for your state DMV written permit test, based on the current official driver handbook. Instant access.',
  },
  'cdl': {
    label: 'CDL',
    title: 'CDL Practice Test — Commercial Driver\'s License Exam Prep | PassExamHQ',
    description: 'Practice questions covering general knowledge, air brakes, combination vehicles, and endorsements for your state CDL exam.',
  },
  'motorcycle': {
    label: 'Motorcycle',
    title: 'Motorcycle Permit Practice Test — Knowledge Exam Prep | PassExamHQ',
    description: 'Practice questions for your state motorcycle knowledge test, covering safe riding, hazards, and licensing requirements.',
  },
  'boating': {
    label: 'Boating',
    title: 'Boating Safety Exam Practice Test | PassExamHQ',
    description: 'Practice questions for your state boating safety certification exam, built from official course material.',
  },
  'real-estate-salesperson': {
    label: 'Real Estate Salesperson',
    title: 'Real Estate Salesperson Exam Prep — Practice Questions by State | PassExamHQ',
    description: 'Practice questions for your state real estate salesperson licensing exam, covering state law and licensing requirements.',
  },
  'real-estate-broker': {
    label: 'Real Estate Broker',
    title: 'Real Estate Managing Broker Exam Prep | PassExamHQ',
    description: 'Practice questions for your state managing broker upgrade exam, covering supervisory duties and brokerage law.',
  },
  'mlo': {
    label: 'Mortgage Loan Origination',
    title: 'NMLS SAFE MLO Exam Prep | PassExamHQ',
    description: 'Practice questions for the NMLS SAFE national Mortgage Loan Originator exam.',
  },
};

function truncate(s, max) {
  if (!s || s.length <= max) return s || '';
  const cut = s.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}
function escapeForJs(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Extract active HUB_EXAMS entries (route/title/description), string/comment-aware ----
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
  throw new Error('no matching bracket found');
}
const appSrc = fs.readFileSync(appJsPath, 'utf8');
const startMarker = 'var HUB_EXAMS_CONTENT = [';
const startIdx = appSrc.indexOf(startMarker);
if (startIdx === -1) throw new Error("could not find 'var HUB_EXAMS_CONTENT = [' in app.js -- did the content array get renamed again?");
const arrayStart = startIdx + startMarker.length - 1;
const arrayEnd = findMatchingBracket(appSrc, arrayStart);
const arrayInner = appSrc.slice(arrayStart + 1, arrayEnd);
const objects = [];
{
  let inLineComment = false, inSingle = false, inDouble = false, depth = 0, objStart = -1;
  for (let i = 0; i < arrayInner.length; i++) {
    const ch = arrayInner[i], prev = arrayInner[i - 1];
    if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
    if (inSingle) { if (ch === "'" && prev !== '\\') inSingle = false; continue; }
    if (inDouble) { if (ch === '"' && prev !== '\\') inDouble = false; continue; }
    if (ch === '/' && arrayInner[i + 1] === '/') { inLineComment = true; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '{') { if (depth === 0) objStart = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0) objects.push(arrayInner.slice(objStart, i + 1)); }
  }
}
function field(obj, name) {
  const m = obj.match(new RegExp(name + ":\\s*(['\"])((?:\\\\.|(?!\\1).)*)\\1"));
  if (!m) return null;
  // m[2] is the raw source text between the quotes, backslash-escapes still literal (e.g.
  // "Driver\'s" as the 4 characters D-r-i-v-e-r-\-'-s) -- decode before returning so callers get
  // the true string value, not source syntax. escapeForJs()/escapeXml() re-escape for wherever
  // this value ends up next; skipping this step double-escapes (see 2026-08-24 SEO-meta bug).
  return m[2].replace(/\\(.)/g, (_, c) => c);
}
const allTracks = [];
objects.forEach((obj) => {
  const examType = field(obj, 'examType');
  const route = field(obj, 'route');
  const title = field(obj, 'title');
  const description = field(obj, 'description');
  if (!examType || !route || route === '#') return;
  allTracks.push({ examType, route, title, description });
});

(async () => {
  // active status is no longer a field on HUB_EXAMS_CONTENT objects at all -- it lives in D1 (see
  // reference_track_registry_architecture) -- fetch the live, currently-deployed value instead of
  // a source-code literal, same principle as everything else this migration touched.
  const res = await fetch(TRACK_REGISTRY_URL);
  if (!res.ok) throw new Error(`fetching ${TRACK_REGISTRY_URL} failed: HTTP ${res.status}`);
  const registryData = await res.json();
  const activeByExamType = {};
  (registryData.tracks || []).forEach((t) => { activeByExamType[t.examType] = t.active; });

  const tracks = allTracks.filter((t) => activeByExamType[t.examType] === true);
  const missingFromRegistry = allTracks.filter((t) => !(t.examType in activeByExamType));
  if (missingFromRegistry.length) {
    console.log('NOTE:', missingFromRegistry.length, 'HUB_EXAMS_CONTENT entries have no matching track_registry row yet (excluded from SEO_META/sitemap this run):', missingFromRegistry.map((t) => t.examType).join(', '));
  }

  // route is '/{kind-slug}/{state}' -- kind-slug is everything up to the last '/'.
  const kindSlugsWithActiveTracks = new Set(tracks.map((t) => t.route.slice(1, t.route.lastIndexOf('/'))));

  // ---- Blog posts (DB-backed, published via admin -- see schema.sql's blog_posts comment) ----
  // Fetched live same as track_registry above, so a newly-published post gets real SEO_META and a
  // sitemap entry on the next daily regen run without a code change of its own.
  const blogRes = await fetch(BLOG_LIST_URL);
  if (!blogRes.ok) throw new Error(`fetching ${BLOG_LIST_URL} failed: HTTP ${blogRes.status}`);
  const blogData = await blogRes.json();
  const blogPosts = blogData.posts || [];

  // ---- Write SEO_META block into _worker.js ----
  const seoMetaEntries = tracks.map((t) =>
    `  '${t.route}': { title: '${escapeForJs(t.title)} | PassExamHQ', description: '${escapeForJs(truncate(t.description, 155))}' },`
  ).join('\n');
  const categoryMetaEntries = Object.entries(CATEGORY_META).map(([slug, m]) =>
    `  '/${slug}': { title: '${escapeForJs(m.title)}', description: '${escapeForJs(m.description)}' },`
  ).join('\n');
  const blogIndexMetaEntry = `  '/blog': { title: '${escapeForJs(BLOG_INDEX_META.title)}', description: '${escapeForJs(BLOG_INDEX_META.description)}' },`;
  // seo_title, when set, is admin-authored and already ends in "| PassExamHQ" by convention (see
  // the Blog admin tab's placeholder/the pilot content) -- only append the suffix ourselves when
  // falling back to the bare title, or it doubles up ("... | PassExamHQ | PassExamHQ").
  const blogPostMetaEntries = blogPosts.map((p) =>
    `  '/blog/${p.slug}': { title: '${escapeForJs(p.seo_title || (p.title + ' | PassExamHQ'))}', description: '${escapeForJs(truncate(p.seo_description || p.excerpt, 155))}' },`
  ).join('\n');

  const seoMetaBlock =
`const SEO_META = {
${categoryMetaEntries}
${seoMetaEntries}
${blogIndexMetaEntry}
${blogPostMetaEntries}
};`;

  let workerSrc = fs.readFileSync(workerPath, 'utf8');
  const START = '// SEO_META_START';
  const END = '// SEO_META_END';
  const startPos = workerSrc.indexOf(START);
  const endPos = workerSrc.indexOf(END);
  if (startPos === -1 || endPos === -1) throw new Error('SEO_META_START/END markers not found in _worker.js');
  workerSrc = workerSrc.slice(0, startPos) + START + '\n' + seoMetaBlock + '\n' + workerSrc.slice(endPos);
  fs.writeFileSync(workerPath, workerSrc, 'utf8');
  console.log('SEO_META entries written:', tracks.length + Object.keys(CATEGORY_META).length);

  // ---- Write sitemap.xml ----
  // Category pages with zero active tracks (e.g. mlo today) are excluded -- a near-empty page isn't
  // worth inviting crawlers to, and would just read as thin content.
  const urls = [SITE_ORIGIN + '/']
    .concat(Object.keys(CATEGORY_META).filter((slug) => kindSlugsWithActiveTracks.has(slug)).map((slug) => SITE_ORIGIN + '/' + slug))
    .concat(tracks.map((t) => SITE_ORIGIN + t.route))
    .concat(GUIDE_URLS.map((u) => SITE_ORIGIN + u))
    .concat(blogPosts.length ? [SITE_ORIGIN + '/blog'] : [])
    .concat(blogPosts.map((p) => SITE_ORIGIN + '/blog/' + p.slug));
  const sitemapXml =
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => '  <url><loc>' + escapeXml(u) + '</loc></url>').join('\n')}
</urlset>
`;
  fs.writeFileSync(sitemapPath, sitemapXml, 'utf8');
  console.log('sitemap.xml URLs written:', urls.length);
})();
