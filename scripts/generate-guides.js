// Generates the static /guides/{slug}/index.html "requirements by state" comparison pages from a
// live track_registry dump. These are genuine static HTML (not app.js-rendered) so AI/LLM crawlers
// that don't execute JavaScript can read the real per-state exam mechanics table directly -- see
// wwwroot/llms.txt, which links to these 7 pages.
//
// Usage:
//   npx wrangler@latest d1 execute examprep --remote --command "SELECT exam_type, kind, state_code, short_name, is_exam_required, exam_question_count, exam_duration_sec, pass_percent, min_correct FROM track_registry WHERE active = 1 ORDER BY kind, state_code" --json > scripts/track_registry_dump.json
//   node scripts/generate-guides.js

const fs = require('fs');
const path = require('path');

const DUMP_PATH = path.join(__dirname, 'track_registry_dump.json');
const OUT_ROOT = path.join(__dirname, '..', 'wwwroot', 'guides');

// Mirrors HUB_KIND_SLUGS / STATE_LABELS in wwwroot/js/app.js -- kept as its own small copy here
// deliberately (build-time script, not shipped to the browser), per this repo's convention of not
// sharing a module boundary between the site's runtime code and one-off generator scripts.
const STATE_LABELS = { CA: 'California', TX: 'Texas', FL: 'Florida', NY: 'New York', IL: 'Illinois', PA: 'Pennsylvania', OH: 'Ohio', GA: 'Georgia', NC: 'North Carolina', VA: 'Virginia', MI: 'Michigan', WA: 'Washington', AK: 'Alaska', AL: 'Alabama', AR: 'Arkansas', AZ: 'Arizona', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', HI: 'Hawaii', IA: 'Iowa', ID: 'Idaho', IN: 'Indiana', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', MA: 'Massachusetts', MD: 'Maryland', ME: 'Maine', MN: 'Minnesota', MO: 'Missouri', MS: 'Mississippi', MT: 'Montana', ND: 'North Dakota', NE: 'Nebraska', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NV: 'Nevada', OK: 'Oklahoma', OR: 'Oregon', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', UT: 'Utah', VT: 'Vermont', WI: 'Wisconsin', WV: 'West Virginia', WY: 'Wyoming', US: 'National' };

const CATEGORIES = [
  {
    kind: 'Notary',
    slug: 'notary-requirements-by-state',
    title: "Notary Public Exam Requirements by State",
    intro: "Not every state requires a written exam to become a notary public -- most just require an application, a bond, and sometimes a short training course. Where a state does administer a real notary exam, question counts, time limits, and passing scores vary widely. The table below shows, state by state, whether an exam is actually required and what it covers when it is.",
    trackLabel: 'Notary',
  },
  {
    kind: 'Real Estate Salesperson',
    slug: 'real-estate-salesperson-requirements-by-state',
    title: "Real Estate Salesperson Exam Requirements by State",
    intro: "Every state requires a licensing exam to become a real estate salesperson (sometimes called a real estate agent), but the exam vendor, item count, time limit, and passing score are all set independently by each state's own licensing authority. The table below compares real exam mechanics across all 50 states.",
    trackLabel: 'Real Estate Salesperson',
  },
  {
    kind: 'Real Estate Broker',
    slug: 'real-estate-broker-requirements-by-state',
    title: "Real Estate Broker Exam Requirements by State",
    intro: "A real estate broker license sits above a salesperson license and requires its own, separate state exam in the states that license brokers independently. Item counts, time limits, and passing scores below reflect each state's actual broker-level exam, not the salesperson exam.",
    trackLabel: 'Real Estate Broker',
  },
  {
    kind: 'Driver',
    slug: 'driver-requirements-by-state',
    title: "Driver's License Knowledge Test Requirements by State",
    intro: "Every state requires a written knowledge test before issuing a standard driver's license or learner's permit. Question counts, time limits, and passing scores are set independently by each state's DMV (or equivalent agency) and vary more than most drivers expect.",
    trackLabel: "Driver's License",
  },
  {
    kind: 'Commercial Driver (CDL)',
    slug: 'cdl-requirements-by-state',
    title: "CDL Knowledge Test Requirements by State",
    intro: "The Commercial Driver's License (CDL) general knowledge test is administered by every state under a shared federal framework (FMCSA), but each state sets its own item count, time limit, and passing score for the actual test session. The table below compares all 50 states.",
    trackLabel: 'CDL',
  },
  {
    kind: 'Motorcycle',
    slug: 'motorcycle-requirements-by-state',
    title: "Motorcycle Permit/License Knowledge Test Requirements by State",
    intro: "Most, but not all, states require a separate written knowledge test to add a motorcycle endorsement or permit to a driver's license. The table below covers the states where PassExamHQ offers a motorcycle knowledge-test practice track, with each state's real exam mechanics.",
    trackLabel: 'Motorcycle',
  },
  {
    kind: 'Boating',
    slug: 'boating-requirements-by-state',
    title: "Boating Safety Exam Requirements by State",
    intro: "Most states mandate a boating safety education exam for at least some operators (commonly based on age or engine horsepower), while a few states have no exam mandate at all. The table below shows exam mechanics for every state where PassExamHQ offers a boating safety practice track, and flags the one state in that list with no exam mandate.",
    trackLabel: 'Boating Safety',
  },
];

const HUB_KIND_SLUGS = {
  'Real Estate Salesperson': 'real-estate-salesperson',
  'Real Estate Broker': 'real-estate-broker',
  Driver: 'driver',
  'Commercial Driver (CDL)': 'cdl',
  Motorcycle: 'motorcycle',
  Boating: 'boating',
  Notary: 'notary',
};

function trackHref(kind, stateCode) {
  const slug = HUB_KIND_SLUGS[kind];
  if (!stateCode || stateCode === 'US') return `/${slug}`;
  return `/${slug}/${stateCode.toLowerCase()}`;
}

function formatMinutes(sec) {
  if (!sec) return null;
  const min = Math.round(sec / 60);
  return `${min} min`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function guidesNavLinks(currentSlug) {
  return CATEGORIES.map((c) => {
    const cls = c.slug === currentSlug ? ' class="active"' : '';
    return `<a href="/guides/${c.slug}"${cls}>${escapeHtml(c.trackLabel)}</a>`;
  }).join('\n        ');
}

function renderPage(category, rows) {
  const sorted = rows.slice().sort((a, b) => (STATE_LABELS[a.state_code] || a.state_code).localeCompare(STATE_LABELS[b.state_code] || b.state_code));

  const tableRows = sorted.map((r) => {
    const stateName = STATE_LABELS[r.state_code] || r.state_code;
    const href = trackHref(category.kind, r.state_code);
    if (!r.is_exam_required) {
      return `        <tr>
          <td>${escapeHtml(stateName)}</td>
          <td class="guide-na">Not required</td>
          <td class="guide-na">&mdash;</td>
          <td class="guide-na">&mdash;</td>
          <td class="guide-table-cta"><a href="${href}">Optional practice test &rarr;</a></td>
          <td class="guide-na">&mdash;</td>
        </tr>`;
    }
    const time = formatMinutes(r.exam_duration_sec) || '—';
    const pass = r.pass_percent != null ? `${r.pass_percent}%` : '—';
    const q = r.exam_question_count != null ? r.exam_question_count : '—';
    return `        <tr>
          <td>${escapeHtml(stateName)}</td>
          <td>${escapeHtml(q)} questions</td>
          <td>${escapeHtml(time)}</td>
          <td>${escapeHtml(pass)}</td>
          <td class="guide-table-cta"><a href="${href}">Practice ${escapeHtml(stateName)} &rarr;</a></td>
          <td class="guide-table-cta"><a href="/share-cards/${r.exam_type}.jpg" download>Share card &rarr;</a></td>
        </tr>`;
  }).join('\n');

  const reqCount = sorted.filter((r) => r.is_exam_required).length;
  const totalCount = sorted.length;
  const reqNote = reqCount === totalCount
    ? `All ${totalCount} states below require this exam.`
    : `${reqCount} of ${totalCount} states below actually require this exam; the rest are marked "Not required."`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(category.title)} | PassExamHQ</title>
<meta name="description" content="${escapeHtml(category.title)}: real question counts, time limits, and passing scores sourced from each state's own official exam mechanics, compared side by side.">
<link rel="stylesheet" href="/css/style.css?v=230">
</head>
<body>
<header class="guide-topbar">
  <a class="guide-logo" href="/">PassExamHQ</a>
  <a class="guide-home-link" href="/">&larr; Back to home</a>
</header>
<main class="guide-page">
  <nav class="guide-cat-nav">
    ${guidesNavLinks(category.slug)}
  </nav>
  <h1>${escapeHtml(category.title)}</h1>
  <p class="guide-intro">${escapeHtml(category.intro)} ${escapeHtml(reqNote)}</p>
  <div class="guide-table-wrap">
    <table class="guide-table">
      <thead>
        <tr>
          <th>State</th>
          <th>Questions</th>
          <th>Time Allowed</th>
          <th>Passing Score</th>
          <th>Practice</th>
          <th>Share</th>
        </tr>
      </thead>
      <tbody>
${tableRows}
      </tbody>
    </table>
  </div>
  <p class="guide-source-note">Exam mechanics above are sourced from each state's own official licensing authority or exam vendor, not third-party estimates. Any pass-rate figure shown elsewhere on PassExamHQ (e.g. the guarantee page) reflects practice mock-exam attempts taken on PassExamHQ itself, not official state exam outcomes.</p>
  <div class="guide-cross-links">
    <a href="/${HUB_KIND_SLUGS[category.kind]}">${escapeHtml(category.trackLabel)} practice tests &rarr;</a>
    <a href="/">All PassExamHQ exam categories &rarr;</a>
  </div>
</main>
<footer class="guide-bottombar">
  <a href="/">PassExamHQ</a> &mdash; licensing exam practice questions, timed to how you actually study.
</footer>
</body>
</html>
`;
}

function main() {
  const dump = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8'));
  const rows = dump[0].results;

  fs.mkdirSync(OUT_ROOT, { recursive: true });

  CATEGORIES.forEach((category) => {
    const catRows = rows.filter((r) => r.kind === category.kind);
    if (!catRows.length) {
      console.warn(`No rows found for kind "${category.kind}" -- skipping`);
      return;
    }
    const html = renderPage(category, catRows);
    const dir = path.join(OUT_ROOT, category.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
    console.log(`Wrote ${category.slug}/index.html (${catRows.length} states)`);
  });
}

main();
