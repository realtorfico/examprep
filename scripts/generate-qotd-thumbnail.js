// Static YouTube thumbnail for a generate-qotd-video-v2.js clip -- reuses that script's real
// question fetch + hook-screen markup (same branding, same real data) rather than inventing a
// separate design, so the thumbnail never promises content the video doesn't deliver. Renders
// just the hook screen (already the default-visible one in buildHtml's markup) as a single PNG.
//
// Usage: node scripts/generate-qotd-thumbnail.js <examType> [outputDir]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fetchQuestion, fetchQuestionCount, buildHtml } = require('./generate-qotd-video-v2.js');

function log(msg) { console.log('[qotd-thumbnail] ' + msg); }

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
  fs.writeFileSync(htmlPath, buildHtml(q, questionCount, examType), 'utf8');

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

main().catch((e) => { console.error(e); process.exit(1); });
