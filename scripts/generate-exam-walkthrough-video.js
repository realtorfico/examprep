// Generates a real, narrated, full-length "mock exam walkthrough" video for YouTube (marketing
// round 3, item #5) -- extends the same real pipeline built for the QOTD short-form video
// generator (see project_qotd_video_generator in memory): Windows SAPI narration + Playwright
// rendering + ffmpeg muxing, just chained across many real questions instead of one, and
// landscape (1920x1080) instead of vertical.
//
// Real per-question clips are rendered and muxed SEPARATELY, then concatenated -- deliberately
// NOT one continuous multi-minute Playwright recording, which would be far more fragile (any
// hiccup mid-recording loses the whole video; a per-question clip failure here only costs one
// clip, and clips can be re-rendered individually).
//
// Usage: node scripts/generate-exam-walkthrough-video.js <questionsJsonPath> <trackLabel> <trackUrl> [outputDir]
//   questionsJsonPath: a local JSON file, EITHER a wrangler `d1 execute --json` dump (real
//     questions pulled with `ORDER BY RANDOM() LIMIT <config.questionCount>`, mirroring the
//     exact selection query the real exam start endpoint uses -- see handleExamStart in
//     examprep-api) OR a plain array of {topic, question, choice_a..d, correct_choice, explanation}.
//   trackLabel: e.g. "California Notary Public"
//   trackUrl: e.g. "https://passexamhq.com/notary/ca"
//
// Requires: npm install --save-dev playwright (already a devDependency in this repo after the
// share-card generator added it) and a working ffmpeg (auto-downloaded to a persistent cache on
// first run -- see findOrInstallFfmpeg below, identical to the QOTD generator's own copy of this
// logic; duplicated rather than shared since these are two independent one-off scripts, not
// application code).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FFMPEG_CACHE_DIR = path.join(os.homedir(), '.cache', 'passexamhq-tools', 'ffmpeg');
const FFMPEG_RELEASE_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-9.0.zip';

function log(msg) { console.log('[exam-walkthrough] ' + msg); }

function findOrInstallFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  } catch (e) { /* not on PATH */ }
  const cached = findFfmpegUnder(FFMPEG_CACHE_DIR);
  if (cached) return cached;
  log('No usable ffmpeg found -- downloading a static build (one-time, ~170MB)...');
  fs.mkdirSync(FFMPEG_CACHE_DIR, { recursive: true });
  const zipPath = path.join(FFMPEG_CACHE_DIR, 'ffmpeg.zip');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Invoke-WebRequest -Uri "${FFMPEG_RELEASE_URL}" -OutFile "${zipPath}" -UseBasicParsing`], { stdio: 'inherit' });
  log('Extracting...');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Expand-Archive -Path "${zipPath}" -DestinationPath "${FFMPEG_CACHE_DIR}" -Force`]);
  fs.unlinkSync(zipPath);
  const installed = findFfmpegUnder(FFMPEG_CACHE_DIR);
  if (!installed) throw new Error('ffmpeg download/extract succeeded but ffmpeg.exe was not found afterward');
  return installed;
}
function findFfmpegUnder(dir) {
  if (!fs.existsSync(dir)) return null;
  const found = { ffmpeg: null, ffprobe: null };
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.toLowerCase() === 'ffmpeg.exe') found.ffmpeg = p;
      else if (entry.name.toLowerCase() === 'ffprobe.exe') found.ffprobe = p;
    }
  })(dir);
  return found.ffmpeg && found.ffprobe ? found : null;
}

function ttsToWav(ttsPs1, text, outWavPath) {
  const txtPath = outWavPath.replace(/\.wav$/, '.txt');
  fs.writeFileSync(txtPath, text, 'utf8');
  execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ttsPs1,
    '-TextFile', txtPath, '-OutFile', outWavPath, '-Rate', '-1',
  ]);
}
function ffprobeDurationSec(ffprobe, filePath) {
  return parseFloat(execFileSync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
  ]).toString().trim());
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Landscape (1920x1080) card, structurally the same as the QOTD vertical card (topic badge,
// question, A-D options, reveal state) just wider and with a running "Question N of TOTAL" counter
// so a viewer scrubbing the video always knows where they are in the exam.
function buildCardHtml(q, index, total, trackLabel) {
  const letters = ['A', 'B', 'C', 'D'];
  const choices = { A: q.choice_a, B: q.choice_b, C: q.choice_c, D: q.choice_d };
  const optionsHtml = letters.map((k) =>
    `<div class="opt" id="opt-${k}"><span class="opt-letter">${k}</span><span class="opt-text">${escapeHtml(choices[k])}</span></div>`
  ).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; width: 1920px; height: 1080px; background: linear-gradient(160deg, #12162a, #1c2244); font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #f3f1e7; display: flex; flex-direction: column; padding: 60px 110px; }
    .top-row { display: flex; justify-content: space-between; align-items: baseline; }
    .brand { font-size: 34px; font-weight: 800; }
    .brand span { color: #e0b84a; }
    .counter { font-size: 26px; color: #b8bdd1; }
    .topic { display: inline-block; margin-top: 30px; padding: 10px 24px; border-radius: 999px; background: rgba(224,184,74,0.16); color: #e0b84a; font-size: 24px; font-weight: 700; }
    .question { margin-top: 30px; font-size: 40px; font-weight: 700; line-height: 1.35; max-width: 1500px; }
    .opts { margin-top: 40px; display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .opt { display: flex; align-items: center; gap: 20px; padding: 22px 26px; border-radius: 18px; background: rgba(255,255,255,0.06); border: 2px solid rgba(255,255,255,0.12); }
    .opt-letter { width: 46px; height: 46px; border-radius: 50%; background: rgba(255,255,255,0.12); display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 800; flex-shrink: 0; }
    .opt-text { font-size: 26px; line-height: 1.3; }
    .opt.correct { background: rgba(46,166,98,0.22); border-color: #2ea662; }
    .opt.correct .opt-letter { background: #2ea662; }
    .opt.dim { opacity: 0.4; }
    .explanation { margin-top: 30px; padding: 26px 30px; border-radius: 18px; background: rgba(255,255,255,0.08); font-size: 24px; line-height: 1.5; display: none; }
    .explanation.shown { display: block; }
    .footer { margin-top: auto; text-align: center; font-size: 22px; color: #8a90a8; }
    .footer strong { color: #e0b84a; }
  </style></head><body>
    <div class="top-row"><div class="brand">PassExam<span>HQ</span></div><div class="counter">Question ${index} of ${total}</div></div>
    <div class="topic">${escapeHtml(q.topic)}</div>
    <div class="question">${escapeHtml(q.question)}</div>
    <div class="opts">${optionsHtml}</div>
    <div class="explanation" id="explanation">${escapeHtml(q.explanation)}</div>
    <div class="footer">Free practice at <strong>passexamhq.com</strong> — ${escapeHtml(trackLabel)}</div>
    <script>
      window.revealAnswer = function (correctKey) {
        document.querySelectorAll('.opt').forEach(function (el) {
          if (el.id === 'opt-' + correctKey) el.classList.add('correct');
          else el.classList.add('dim');
        });
        document.getElementById('explanation').classList.add('shown');
      };
    </script>
  </body></html>`;
}

function loadQuestions(jsonPath) {
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  // Accept either a raw array, or a wrangler `d1 execute --json` dump ([{results: [...]}]).
  if (Array.isArray(raw) && raw[0] && raw[0].results) return raw[0].results;
  return raw;
}

async function renderQuestionClip(browser, ffmpeg, ffprobe, ttsPs1, workDir, q, index, total, trackLabel) {
  const seg1Text = 'Question ' + index + '. ' + q.topic + '. ' + q.question + ' Your options: A, ' + q.choice_a + '. B, ' + q.choice_b + '. C, ' + q.choice_c + '. D, ' + q.choice_d + '.';
  const seg2Text = 'The correct answer is ' + q.correct_choice + '. ' + q.explanation;
  const seg1Wav = path.join(workDir, `q${index}_seg1.wav`);
  const seg2Wav = path.join(workDir, `q${index}_seg2.wav`);
  ttsToWav(ttsPs1, seg1Text, seg1Wav);
  ttsToWav(ttsPs1, seg2Text, seg2Wav);
  const gapWav = path.join(workDir, `q${index}_gap.wav`);
  const tailWav = path.join(workDir, `q${index}_tail.wav`);
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1.0', gapWav]);
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.8', tailWav]);
  const concatListPath = path.join(workDir, `q${index}_concat.txt`);
  fs.writeFileSync(concatListPath, [seg1Wav, gapWav, seg2Wav, tailWav].map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const narrationWav = path.join(workDir, `q${index}_narration.wav`);
  execFileSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', narrationWav]);

  const seg1Dur = ffprobeDurationSec(ffprobe, seg1Wav);
  const gapDur = ffprobeDurationSec(ffprobe, gapWav);
  const seg2Dur = ffprobeDurationSec(ffprobe, seg2Wav);
  const tailDur = ffprobeDurationSec(ffprobe, tailWav);
  const revealAtMs = Math.round((seg1Dur + gapDur) * 1000);
  const totalMs = Math.round((seg1Dur + gapDur + seg2Dur + tailDur) * 1000);

  const htmlPath = path.join(workDir, `q${index}_card.html`);
  fs.writeFileSync(htmlPath, buildCardHtml(q, index, total, trackLabel), 'utf8');

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: workDir, size: { width: 1920, height: 1080 } },
  });
  const page = await context.newPage();
  await page.goto('file://' + htmlPath.replace(/\\/g, '/'));
  await page.waitForTimeout(revealAtMs);
  await page.evaluate((k) => window.revealAnswer(k), q.correct_choice);
  await page.waitForTimeout(totalMs - revealAtMs);
  const videoHandle = page.video();
  await context.close();
  const rawVideoPath = await videoHandle.path();

  const clipPath = path.join(workDir, `clip_${String(index).padStart(3, '0')}.mp4`);
  execFileSync(ffmpeg, [
    '-y', '-i', rawVideoPath, '-i', narrationWav,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipPath,
  ]);
  return clipPath;
}

async function main() {
  const [, , questionsJsonPath, trackLabel, trackUrl, outputDirArg] = process.argv;
  if (!questionsJsonPath || !trackLabel || !trackUrl) {
    console.error('Usage: node scripts/generate-exam-walkthrough-video.js <questionsJsonPath> <trackLabel> <trackUrl> [outputDir]');
    process.exit(1);
  }
  const outputDir = outputDirArg || process.cwd();

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.error('playwright is not installed. Run: npm install --save-dev playwright');
    process.exit(1);
  }

  const { ffmpeg, ffprobe } = findOrInstallFfmpeg();
  log('Using ffmpeg: ' + ffmpeg);

  const questions = loadQuestions(questionsJsonPath);
  log(`Loaded ${questions.length} real questions for ${trackLabel}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-walkthrough-'));
  const ttsPs1 = path.join(__dirname, 'tts.ps1');

  const browser = await chromium.launch();
  const clipPaths = [];
  for (let i = 0; i < questions.length; i++) {
    log(`Rendering question ${i + 1} of ${questions.length}...`);
    const clipPath = await renderQuestionClip(browser, ffmpeg, ffprobe, ttsPs1, workDir, questions[i], i + 1, questions.length, trackLabel);
    clipPaths.push(clipPath);
  }
  await browser.close();

  log('Concatenating all clips into the final video...');
  const finalConcatListPath = path.join(workDir, 'final_concat.txt');
  fs.writeFileSync(finalConcatListPath, clipPaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  fs.mkdirSync(outputDir, { recursive: true });
  const safeLabel = trackLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const outPath = path.join(outputDir, `${safeLabel}_full_mock_exam_walkthrough.mp4`);
  execFileSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', finalConcatListPath, '-c', 'copy', outPath]);

  log('Done: ' + outPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
