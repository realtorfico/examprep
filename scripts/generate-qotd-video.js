// Generates one real, narrated 9:16 "Question of the Day" video clip for TikTok/Shorts/Reels --
// marketing idea #6 (see memory: project_marketing_ideas_round2). Reuses the SAME real,
// deterministic daily question the embeddable widget shows (GET /qotd, see #7's
// wwwroot/embed/qotd/), so this and the embed widget always agree on "today's question" for a
// given track.
//
// Pipeline: fetch today's real question -> synthesize narration (Windows SAPI, two segments: the
// question+choices, then the reveal+explanation) -> render a vertical HTML card with Playwright,
// timing the on-screen "reveal" to match the narration's own measured length -> mux the recorded
// video with the narration audio via ffmpeg into a single .mp4.
//
// Why this exists as a real dependency-managed script rather than a one-off: this machine is
// Windows on ARM64 (see root CLAUDE.md) -- neither of the standard npm ffmpeg-installer packages
// ship a win32-arm64 binary (confirmed: both explicitly fail to install here), and Playwright's
// OWN bundled ffmpeg (used internally for its video capture) is a stripped video-only build with
// no audio codec support at all. This script downloads a real static win64 ffmpeg build (which
// runs fine here under Windows' x64 emulation, same as Playwright's own Chromium/ffmpeg already
// do) into a persistent cache dir on first run, rather than assuming one is already on PATH.
//
// Usage: node scripts/generate-qotd-video.js <examType> [outputDir]
// Requires: npm install playwright (not a project dependency -- this is a marketing tool, not
// part of the deployed site -- install it locally before running, or point NODE_PATH at wherever
// it's installed).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const API_BASE = 'https://passexamhq.com/api';
const FFMPEG_CACHE_DIR = path.join(os.homedir(), '.cache', 'passexamhq-tools', 'ffmpeg');
const FFMPEG_RELEASE_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-9.0.zip';

function log(msg) { console.log('[qotd-video] ' + msg); }

function findOrInstallFfmpeg() {
  // 1. Already on PATH?
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  } catch (e) { /* not on PATH */ }

  // 2. Already cached from a prior run?
  const cachedExe = findFfmpegUnder(FFMPEG_CACHE_DIR);
  if (cachedExe) return cachedExe;

  // 3. Download + extract a real static build (win64 -- runs fine here via x64 emulation, same
  // as Playwright's own bundled Chromium/ffmpeg already do on this ARM64 machine).
  log('No usable ffmpeg found -- downloading a static build (one-time, ~170MB)...');
  fs.mkdirSync(FFMPEG_CACHE_DIR, { recursive: true });
  const zipPath = path.join(FFMPEG_CACHE_DIR, 'ffmpeg.zip');
  downloadFileSync(FFMPEG_RELEASE_URL, zipPath);
  log('Extracting...');
  execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Expand-Archive -Path "${zipPath}" -DestinationPath "${FFMPEG_CACHE_DIR}" -Force`,
  ]);
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

function downloadFileSync(url, destPath) {
  execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Invoke-WebRequest -Uri "${url}" -OutFile "${destPath}" -UseBasicParsing`,
  ], { stdio: 'inherit', maxBuffer: 1024 * 1024 * 50 });
}

async function fetchQuestion(examType) {
  const res = await fetch(API_BASE + '/qotd?examType=' + encodeURIComponent(examType));
  if (!res.ok) throw new Error('GET /qotd failed: HTTP ' + res.status);
  return res.json();
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
  const out = execFileSync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
  ]).toString().trim();
  return parseFloat(out);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildCardHtml(q) {
  const letters = ['A', 'B', 'C', 'D'];
  const optionsHtml = letters.map((k) =>
    `<div class="opt" id="opt-${k}"><span class="opt-letter">${k}</span><span class="opt-text">${escapeHtml(q.choices[k])}</span></div>`
  ).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; width: 1080px; height: 1920px; background: linear-gradient(160deg, #12162a, #1c2244); font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #f3f1e7; display: flex; flex-direction: column; padding: 90px 80px; }
    .brand { font-size: 40px; font-weight: 800; letter-spacing: -0.01em; }
    .brand span { color: #e0b84a; }
    .eyebrow { margin-top: 18px; font-size: 30px; text-transform: uppercase; letter-spacing: 0.08em; color: #e0b84a; font-weight: 700; }
    .topic { display: inline-block; margin-top: 40px; padding: 14px 28px; border-radius: 999px; background: rgba(224,184,74,0.16); color: #e0b84a; font-size: 30px; font-weight: 700; }
    .question { margin-top: 44px; font-size: 52px; font-weight: 700; line-height: 1.35; }
    .opts { margin-top: 60px; display: flex; flex-direction: column; gap: 26px; }
    .opt { display: flex; align-items: center; gap: 26px; padding: 30px 34px; border-radius: 24px; background: rgba(255,255,255,0.06); border: 3px solid rgba(255,255,255,0.12); transition: all 0.3s; }
    .opt-letter { width: 60px; height: 60px; border-radius: 50%; background: rgba(255,255,255,0.12); display: flex; align-items: center; justify-content: center; font-size: 34px; font-weight: 800; flex-shrink: 0; }
    .opt-text { font-size: 34px; line-height: 1.3; }
    .opt.correct { background: rgba(46,166,98,0.22); border-color: #2ea662; }
    .opt.correct .opt-letter { background: #2ea662; }
    .opt.dim { opacity: 0.4; }
    .explanation { margin-top: 50px; padding: 34px 38px; border-radius: 24px; background: rgba(255,255,255,0.08); font-size: 32px; line-height: 1.5; display: none; }
    .explanation.shown { display: block; }
    .footer { margin-top: auto; text-align: center; font-size: 30px; color: #b8bdd1; }
    .footer strong { color: #e0b84a; }
  </style></head><body>
    <div class="brand">PassExam<span>HQ</span></div>
    <div class="eyebrow">Question of the Day</div>
    <div class="topic">${escapeHtml(q.topic)}</div>
    <div class="question">${escapeHtml(q.question)}</div>
    <div class="opts">${optionsHtml}</div>
    <div class="explanation" id="explanation">${escapeHtml(q.explanation)}</div>
    <div class="footer">Free practice at <strong>passexamhq.com</strong> — ${escapeHtml(q.trackLabel)}</div>
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

async function main() {
  const examType = process.argv[2];
  const outputDir = process.argv[3] || process.cwd();
  if (!examType) {
    console.error('Usage: node scripts/generate-qotd-video.js <examType> [outputDir]');
    process.exit(1);
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.error('playwright is not installed. Run: npm install playwright (in this scripts dir, or set NODE_PATH)');
    process.exit(1);
  }

  const { ffmpeg, ffprobe } = findOrInstallFfmpeg();
  log('Using ffmpeg: ' + ffmpeg);

  log('Fetching today\'s real question for ' + examType + '...');
  const q = await fetchQuestion(examType);
  log('Topic: ' + q.topic);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qotd-video-'));
  const ttsPs1 = path.join(__dirname, 'tts.ps1');

  const seg1Text = q.topic + '. ' + q.question + ' Your options: A, ' + q.choices.A + '. B, ' + q.choices.B + '. C, ' + q.choices.C + '. D, ' + q.choices.D + '.';
  const seg2Text = 'The correct answer is ' + q.correctChoice + '. ' + q.explanation;

  log('Synthesizing narration...');
  const seg1Wav = path.join(workDir, 'seg1.wav');
  const seg2Wav = path.join(workDir, 'seg2.wav');
  ttsToWav(ttsPs1, seg1Text, seg1Wav);
  ttsToWav(ttsPs1, seg2Text, seg2Wav);

  const gapWav = path.join(workDir, 'gap.wav');
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1.3', gapWav]);
  const tailWav = path.join(workDir, 'tail.wav');
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1.0', tailWav]);

  const concatListPath = path.join(workDir, 'concat.txt');
  fs.writeFileSync(concatListPath, [seg1Wav, gapWav, seg2Wav, tailWav].map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const narrationWav = path.join(workDir, 'narration.wav');
  execFileSync(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', narrationWav]);

  const seg1Dur = ffprobeDurationSec(ffprobe, seg1Wav);
  const gapDur = ffprobeDurationSec(ffprobe, gapWav);
  const seg2Dur = ffprobeDurationSec(ffprobe, seg2Wav);
  const tailDur = ffprobeDurationSec(ffprobe, tailWav);
  const revealAtMs = Math.round((seg1Dur + gapDur) * 1000);
  const totalMs = Math.round((seg1Dur + gapDur + seg2Dur + tailDur) * 1000);
  log('Narration: ' + seg1Dur.toFixed(1) + 's question, reveal at ' + (revealAtMs / 1000).toFixed(1) + 's, total ' + (totalMs / 1000).toFixed(1) + 's');

  const htmlPath = path.join(workDir, 'card.html');
  fs.writeFileSync(htmlPath, buildCardHtml(q), 'utf8');

  log('Recording video...');
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1080, height: 1920 },
    recordVideo: { dir: workDir, size: { width: 1080, height: 1920 } },
  });
  const page = await context.newPage();
  await page.goto('file://' + htmlPath.replace(/\\/g, '/'));
  await page.waitForTimeout(revealAtMs);
  await page.evaluate((k) => window.revealAnswer(k), q.correctChoice);
  await page.waitForTimeout(totalMs - revealAtMs);
  const videoHandle = page.video();
  await context.close();
  await browser.close();
  const videoPath = await videoHandle.path();

  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, examType + '_qotd_' + q.date + '.mp4');
  log('Muxing final video...');
  execFileSync(ffmpeg, [
    '-y', '-i', videoPath, '-i', narrationWav,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outPath,
  ]);

  log('Done: ' + outPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
