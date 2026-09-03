// Generates a shareable, real-data "compare your state" PNG card per active, exam-required track
// (marketing round 3, item #4) -- e.g. "Ohio Notary Exam: 40 Questions / 60 Minutes / 70% to Pass".
// Meant to be downloaded/shared to a state Facebook group, subreddit, or forum, with real sourced
// mechanics pulled from the same track_registry data the /guides/* pages already use. Reuses the
// QOTD video generator's approach (see qotd-video-generator's project memory): render a plain HTML
// card, screenshot it with Playwright -- no ffmpeg/audio needed here, just a static image.
//
// Usage:
//   npx wrangler@latest d1 execute examprep --remote --command "SELECT exam_type, kind, state_code, short_name, is_exam_required, exam_question_count, exam_duration_sec, pass_percent FROM track_registry WHERE active = 1 ORDER BY kind, state_code" --json > scripts/track_registry_dump.json
//   npm install --save-dev playwright   (one-time; also run `npx playwright install chromium` if the browser binary isn't cached)
//   node scripts/generate-share-cards.js [examType]   (omit examType to regenerate every card)

const fs = require('fs');
const path = require('path');

const DUMP_PATH = path.join(__dirname, 'track_registry_dump.json');
const OUT_ROOT = path.join(__dirname, '..', 'wwwroot', 'share-cards');

// Mirrors generate-guides.js's own small copies of these maps -- see that file's comment for why
// this repo duplicates them rather than sharing a module with the browser-side app.js.
const STATE_LABELS = { CA: 'California', TX: 'Texas', FL: 'Florida', NY: 'New York', IL: 'Illinois', PA: 'Pennsylvania', OH: 'Ohio', GA: 'Georgia', NC: 'North Carolina', VA: 'Virginia', MI: 'Michigan', WA: 'Washington', AK: 'Alaska', AL: 'Alabama', AR: 'Arkansas', AZ: 'Arizona', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', HI: 'Hawaii', IA: 'Iowa', ID: 'Idaho', IN: 'Indiana', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', MA: 'Massachusetts', MD: 'Maryland', ME: 'Maine', MN: 'Minnesota', MO: 'Missouri', MS: 'Mississippi', MT: 'Montana', ND: 'North Dakota', NE: 'Nebraska', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NV: 'Nevada', OK: 'Oklahoma', OR: 'Oregon', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', UT: 'Utah', VT: 'Vermont', WI: 'Wisconsin', WV: 'West Virginia', WY: 'Wyoming', US: 'National' };
const TRACK_LABELS = {
  Notary: 'Notary', 'Real Estate Salesperson': 'Real Estate Salesperson', 'Real Estate Broker': 'Real Estate Broker',
  Driver: "Driver's License", 'Commercial Driver (CDL)': 'CDL', Motorcycle: 'Motorcycle', Boating: 'Boating Safety',
};
const HUB_KIND_SLUGS = {
  'Real Estate Salesperson': 'real-estate-salesperson', 'Real Estate Broker': 'real-estate-broker',
  Driver: 'driver', 'Commercial Driver (CDL)': 'cdl', Motorcycle: 'motorcycle', Boating: 'boating', Notary: 'notary',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cardHtml(track) {
  const stateLabel = STATE_LABELS[track.state_code] || track.state_code;
  const kindLabel = TRACK_LABELS[track.kind] || track.kind;
  const minutes = Math.round(track.exam_duration_sec / 60);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; width: 1080px; height: 1080px; background: linear-gradient(160deg, #12162a, #1c2244); font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #f3f1e7; display: flex; flex-direction: column; padding: 90px 90px 70px; }
    .brand { font-size: 36px; font-weight: 800; letter-spacing: -0.01em; }
    .brand span { color: #e0b84a; }
    .eyebrow { margin-top: 70px; font-size: 26px; text-transform: uppercase; letter-spacing: 0.08em; color: #e0b84a; font-weight: 700; }
    .title { margin-top: 18px; font-size: 68px; font-weight: 800; line-height: 1.15; }
    .stats { margin-top: 80px; display: flex; gap: 24px; }
    .stat { flex: 1; background: rgba(255,255,255,0.06); border: 2px solid rgba(255,255,255,0.12); border-radius: 24px; padding: 36px 20px; text-align: center; }
    .stat-value { font-family: Georgia, serif; font-size: 56px; font-weight: 700; color: #e0b84a; }
    .stat-label { margin-top: 10px; font-size: 22px; color: #d7dae8; }
    .footer { margin-top: auto; padding-top: 50px; border-top: 2px solid rgba(255,255,255,0.12); font-size: 26px; color: #b8bdd1; text-align: center; }
    .footer strong { color: #e0b84a; }
    .source-note { margin-top: 14px; font-size: 18px; color: #8a90a8; text-align: center; }
  </style></head><body>
    <div class="brand">PassExam<span>HQ</span></div>
    <div class="eyebrow">Real Exam Requirements</div>
    <div class="title">${escapeHtml(stateLabel)}<br>${escapeHtml(kindLabel)} Exam</div>
    <div class="stats">
      <div class="stat"><div class="stat-value">${track.exam_question_count}</div><div class="stat-label">Questions</div></div>
      <div class="stat"><div class="stat-value">${minutes}</div><div class="stat-label">Minutes</div></div>
      <div class="stat"><div class="stat-value">${track.pass_percent}%</div><div class="stat-label">to Pass</div></div>
    </div>
    <div class="footer">Free practice at <strong>passexamhq.com</strong></div>
    <div class="source-note">Sourced from ${escapeHtml(stateLabel)}'s own official exam mechanics</div>
  </body></html>`;
}

async function main() {
  const onlyExamType = process.argv[2];
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.error('playwright is not installed. Run: npm install --save-dev playwright');
    process.exit(1);
  }

  const dump = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8'));
  const rows = dump[0].results;
  const tracks = rows.filter((r) => r.is_exam_required && r.exam_question_count && r.exam_duration_sec && r.pass_percent
    && (!onlyExamType || r.exam_type === onlyExamType));

  fs.mkdirSync(OUT_ROOT, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
  let written = 0;
  for (const track of tracks) {
    await page.setContent(cardHtml(track));
    // JPEG, not PNG -- this card's gradient background compresses far better lossy than lossless
    // (PNG screenshots ran ~290KB each, ~67MB for the full set; JPEG at quality 85 is a small
    // fraction of that with no visible quality loss on a design this simple, and keeps the repo
    // and Cloudflare Pages deploy size sane across repeated regenerations).
    await page.screenshot({ path: path.join(OUT_ROOT, `${track.exam_type}.jpg`), type: 'jpeg', quality: 85 });
    written++;
  }
  await browser.close();
  console.log(`Wrote ${written} share cards to ${OUT_ROOT} (skipped ${rows.length - tracks.length} non-exam-required or mechanics-incomplete tracks)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
