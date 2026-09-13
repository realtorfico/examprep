// Static YouTube thumbnail for a generate-qotd-video-v2.js clip. Originally reused the video's
// hook screen verbatim; redesigned 2026-09-12 (user feedback: thumbnails weren't appealing, and
// with 5+ categories -- ACT/DAT/CLT/OAT/all 27 Notary states -- silently sharing one generic 📚
// emoji and the category name buried mid-sentence rather than standing out, most looked
// near-identical at a glance). Still uses the video script's real data fetch (question/count),
// just its own layout -- a thumbnail can have a different design from the video's first frame
// without being a "clickbait mismatch" as long as it doesn't promise content the video lacks.
//
// Usage: node scripts/generate-qotd-thumbnail.js <examType> [outputDir]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fetchQuestion, fetchQuestionCount, emojiForExamType, shortLabelForExamType, escapeHtml } = require('./generate-qotd-video-v2.js');

function log(msg) { console.log('[qotd-thumbnail] ' + msg); }

// Small accent-color variety behind the icon only -- background/typography stay the site's real
// navy+gold brand throughout (see feedback_preserve_navy_gold_brand) so this reads as "one channel,
// many categories" rather than a different sub-brand per category. Grouped by real subject-matter
// kinship, not arbitrary.
const ACCENTS = {
  cdl_generic: '#ea9600', driver_generic: '#3b82c4', motorcycle_generic: '#d64545',
  boating_generic: '#2ea6a6', re_broker_generic: '#3fa66b', re_salesperson_generic: '#3fa66b',
  act: '#8b5cf6', dat: '#8b5cf6', clt: '#8b5cf6', oat: '#8b5cf6',
};
function accentForExamType(examType) {
  if (ACCENTS[examType]) return ACCENTS[examType];
  if (examType.endsWith('_notary')) return '#c2568a';
  return '#ea9600';
}

function buildThumbnailHtml(q, questionCount, examType) {
  const roundStep = questionCount >= 1000 ? 1000 : 50;
  const roundedCount = Math.floor(questionCount / roundStep) * roundStep;
  const emoji = emojiForExamType(examType);
  const label = shortLabelForExamType(examType, q);
  const accent = accentForExamType(examType);
  // Longer labels (long state names + "NOTARY", or "RE SALESPERSON") need a smaller font to stay
  // on one or two lines inside the pill rather than overflowing it.
  const labelFontSize = label.length <= 5 ? 152 : label.length <= 10 ? 110 : label.length <= 16 ? 80 : 60;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 1080px; height: 1920px; overflow: hidden; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
    body { display: grid; grid-template-rows: auto 1fr auto; justify-items: center; padding: 70px 80px 90px; text-align: center; background: radial-gradient(circle at 50% 28%, #1a3d7c, #0f2a5f 65%); }
    .brand { font-size: 40px; font-weight: 800; color: #fdfaf4; }
    .brand span { color: #ea9600; }
    .middle { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 34px; }
    .icon-badge { width: 300px; height: 300px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: radial-gradient(circle at 38% 32%, ${accent}55, ${accent}22 70%); border: 6px solid ${accent}; }
    .icon-badge .emoji { font-size: 160px; line-height: 1; }
    .hook { font-size: 72px; font-weight: 900; color: #fdfaf4; line-height: 1.1; }
    .label-pill { display: inline-block; padding: 26px 50px; border-radius: 28px; background: #ea9600; color: #0f2a5f; font-weight: 900; letter-spacing: 0.01em; line-height: 1.1; max-width: 900px; font-size: ${labelFontSize}px; }
    .stat-pill { display: inline-flex; align-items: center; gap: 14px; padding: 16px 34px; border-radius: 999px; background: rgba(255,255,255,0.1); border: 2px solid rgba(255,255,255,0.25); color: #fdfaf4; font-size: 30px; font-weight: 700; }
    .url { font-size: 40px; font-weight: 900; color: #fdfaf4; margin-top: 22px; }
  </style></head><body>
    <div class="brand">PassExam<span>HQ</span></div>
    <div class="middle">
      <div class="icon-badge"><div class="emoji">${emoji}</div></div>
      <div class="hook">CAN YOU<br>PASS THIS?</div>
      <div class="label-pill">${escapeHtml(label)}</div>
    </div>
    <div>
      <div class="stat-pill">✅ ${roundedCount.toLocaleString()}+ REAL QUESTIONS</div>
      <div class="url">passexamhq.com</div>
    </div>
  </body></html>`;
}

async function main() {
  const examType = process.argv[2];
  const outputDir = process.argv[3] || process.cwd();
  if (!examType) {
    console.error('Usage: node scripts/generate-qotd-thumbnail.js <examType> [outputDir]');
    process.exit(1);
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.error('playwright is not installed. Run: npm install playwright (in this scripts dir, or set NODE_PATH)');
    process.exit(1);
  }

  log('Fetching today\'s real question for ' + examType + '...');
  const q = await fetchQuestion(examType);
  const questionCount = await fetchQuestionCount(examType);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qotd-thumb-'));
  const htmlPath = path.join(workDir, 'card.html');
  fs.writeFileSync(htmlPath, buildThumbnailHtml(q, questionCount, examType), 'utf8');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.goto('file://' + htmlPath.replace(/\\/g, '/'));
  await page.waitForTimeout(200); // let webfonts/emoji settle before capture

  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, examType + '_thumbnail_' + q.date + '.png');
  await page.screenshot({ path: outPath });
  await browser.close();

  log('Done: ' + outPath);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildThumbnailHtml };
