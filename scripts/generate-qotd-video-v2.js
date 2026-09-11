// v2 "catchy" redesign of generate-qotd-video.js, 2026-09-10 -- user watched the v1 CA Notary
// clip and wasn't impressed. Root cause diagnosed as format, not just voice quality: v1 is a
// static card + robotic Windows SAPI narration doing all the work, which is the wrong genre
// convention for this content type. Real successful short-form quiz content ("would you pass this
// test?") is visual/text-driven -- bold animated typography, fast pacing, a punchy hook in the
// first 1-2s, watched muted by most viewers until it hooks them. This version drops narration
// entirely (also sidesteps the robotic-SAPI-voice complaint directly, rather than trying to fix
// voice quality -- checked for a better local Windows Natural voice, none installed and installing
// one needs admin elevation this session doesn't have; a cloud neural TTS needs a new paid API
// account) and leans on animated staggered reveals + a synthesized ambient audio bed (no licensing
// risk, self-generated via ffmpeg) instead. ~15s total, matching real short-form norms, vs. v1's
// ~40s narration-paced runtime.
//
// Same real-data discipline as v1: reuses the exact same GET /qotd endpoint (today's real,
// deterministic question, same one the embed widget shows) -- nothing invented.
//
// Usage: node scripts/generate-qotd-video-v2.js <examType> [outputDir]

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const API_BASE = 'https://passexamhq.com/api';
const FFMPEG_CACHE_DIR = path.join(os.homedir(), '.cache', 'passexamhq-tools', 'ffmpeg');
const FFMPEG_RELEASE_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-9.0.zip';

function log(msg) { console.log('[qotd-video-v2] ' + msg); }

function findOrInstallFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  } catch (e) { /* not on PATH */ }
  const cachedExe = findFfmpegUnder(FFMPEG_CACHE_DIR);
  if (cachedExe) return cachedExe;
  log('No usable ffmpeg found -- downloading a static build (one-time, ~170MB)...');
  fs.mkdirSync(FFMPEG_CACHE_DIR, { recursive: true });
  const zipPath = path.join(FFMPEG_CACHE_DIR, 'ffmpeg.zip');
  execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Invoke-WebRequest -Uri "${FFMPEG_RELEASE_URL}" -OutFile "${zipPath}" -UseBasicParsing`,
  ], { stdio: 'inherit', maxBuffer: 1024 * 1024 * 50 });
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

// Special pseudo-examType, added 2026-09-10 -- user asked why the video has to be tied to one
// state when a lot of CDL General Knowledge content is genuinely federal (FMCSA/49 CFR), not state
// law. Verified before building this, not assumed: cross-state text-match queries against the real
// DB confirmed the same substantive rules appear independently worded across dozens of states'
// banks (e.g. the railroad-crossing stop-distance rule literally appears in all 50 states' CDL
// banks, the dual-air-brake minimum-psi rule in 49). The curated pool below (cdl_generic_questions
// .json) is hand-picked from that verification pass -- each entry records verifiedAcrossStates as
// an audit trail, not just an assertion.
const GENERIC_CDL_EXAM_TYPE = 'cdl_generic';

async function fetchQuestion(examType) {
  if (examType === GENERIC_CDL_EXAM_TYPE) {
    const pool = JSON.parse(fs.readFileSync(path.join(__dirname, 'cdl_generic_questions.json'), 'utf8'));
    const picked = pool[Math.floor(Math.random() * pool.length)];
    return {
      topic: picked.topic, question: picked.question, choices: picked.choices,
      correctChoice: picked.correctChoice, explanation: picked.explanation,
      trackLabel: 'CDL', date: new Date().toISOString().slice(0, 10),
    };
  }
  const res = await fetch(API_BASE + '/qotd?examType=' + encodeURIComponent(examType));
  if (!res.ok) throw new Error('GET /qotd failed: HTTP ' + res.status);
  return res.json();
}

// Real question-bank size for the outro CTA -- fetched live rather than hardcoded, so the claim is
// always accurate for whatever examType this actually runs against (caught a real bug during v2's
// first run: outro originally said a hardcoded "500+", real ca_cdl count is 400). For the generic
// pseudo-examType, sums every real *_cdl exam_type's count (verified sitewide total, not a guess).
async function fetchQuestionCount(examType) {
  const res = await fetch(API_BASE + '/questions/counts');
  if (!res.ok) throw new Error('GET /questions/counts failed: HTTP ' + res.status);
  const data = await res.json();
  if (examType === GENERIC_CDL_EXAM_TYPE) {
    return (data.counts || []).filter((c) => c.exam_type.endsWith('_cdl')).reduce((sum, c) => sum + c.count, 0);
  }
  const row = (data.counts || []).find((c) => c.exam_type === examType);
  if (!row) throw new Error('No question count found for exam_type ' + examType);
  return row.count;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Timing plan (ms) -- fast, short-form-native pacing, not narration-paced.
const T = {
  hookIn: 0, hookHold: 1500, mainIn: 1700, questionIn: 2000,
  optA: 3200, optB: 3600, optC: 4000, optD: 4400,
  tensionStart: 5000, reveal: 7000, outroIn: 11500, end: 15000,
};

function buildHtml(q, questionCount, examType) {
  // Round down to a clean step so the "X+" claim is always literally true even for an odd real
  // count, without looking artificially precise -- step scales with magnitude (nearest 50 for a
  // few hundred, nearest 1000 once we're into the thousands, e.g. the sitewide generic-pool count).
  const roundStep = questionCount >= 1000 ? 1000 : 50;
  const roundedCount = Math.floor(questionCount / roundStep) * roundStep;
  const letters = ['A', 'B', 'C', 'D'];
  const optionsHtml = letters.map((k) =>
    `<div class="opt" id="opt-${k}"><span class="opt-letter">${k}</span><span class="opt-text">${escapeHtml(q.choices[k])}</span></div>`
  ).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 1080px; height: 1920px; overflow: hidden; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #0f2a5f; }
    .screen { position: absolute; inset: 0; display: flex; flex-direction: column; opacity: 0; transition: opacity 0.4s ease; }
    .screen.show { opacity: 1; }
    /* Hook screen -- the scroll-stopping first beat */
    #hook { align-items: center; justify-content: center; text-align: center; padding: 0 90px; background: radial-gradient(circle at 50% 35%, #1a3d7c, #0f2a5f 70%); }
    #hook .emoji { font-size: 140px; margin-bottom: 20px; }
    #hook .line { font-size: 84px; font-weight: 900; color: #fdfaf4; line-height: 1.15; }
    #hook .line span { color: #ea9600; }
    /* Main quiz screen */
    #main { padding: 80px 76px; background: linear-gradient(160deg, #0f2a5f, #163564); }
    .brand { font-size: 36px; font-weight: 800; color: #fdfaf4; }
    .brand span { color: #ea9600; }
    .topic { display: inline-block; margin-top: 22px; padding: 12px 26px; border-radius: 999px; background: rgba(234,150,0,0.18); color: #ea9600; font-size: 28px; font-weight: 800; width: fit-content; opacity: 0; transform: translateY(14px); transition: all 0.35s ease; }
    .topic.in { opacity: 1; transform: translateY(0); }
    .question { margin-top: 36px; font-size: 50px; font-weight: 800; line-height: 1.3; color: #fdfaf4; opacity: 0; transform: translateY(16px); transition: all 0.4s ease; }
    .question.in { opacity: 1; transform: translateY(0); }
    .opts { margin-top: 46px; display: flex; flex-direction: column; gap: 22px; }
    .opt { display: flex; align-items: center; gap: 24px; padding: 26px 30px; border-radius: 22px; background: rgba(255,255,255,0.07); border: 3px solid rgba(255,255,255,0.14); opacity: 0; transform: translateX(-30px); transition: all 0.35s cubic-bezier(.2,.8,.3,1.3), background 0.3s, border-color 0.3s; }
    .opt.in { opacity: 1; transform: translateX(0); }
    .opt-letter { width: 56px; height: 56px; border-radius: 50%; background: rgba(255,255,255,0.14); display: flex; align-items: center; justify-content: center; font-size: 30px; font-weight: 900; color: #fdfaf4; flex-shrink: 0; }
    .opt-text { font-size: 32px; line-height: 1.3; color: #fdfaf4; }
    .opt.correct { background: rgba(46,166,98,0.26); border-color: #2ea662; }
    .opt.correct .opt-letter { background: #2ea662; }
    .opt.dim { opacity: 0.35; }
    /* Tension bar -- builds suspense right before reveal */
    .tension-wrap { margin-top: 40px; height: 10px; border-radius: 999px; background: rgba(255,255,255,0.12); overflow: hidden; opacity: 0; transition: opacity 0.3s; }
    .tension-wrap.in { opacity: 1; }
    .tension-bar { height: 100%; width: 100%; background: #ea9600; transform-origin: left; transform: scaleX(1); transition: transform 2s linear; }
    .tension-wrap.drain .tension-bar { transform: scaleX(0); }
    .explanation { margin-top: 36px; padding: 30px 34px; border-radius: 22px; background: rgba(255,255,255,0.09); font-size: 30px; line-height: 1.5; color: #fdfaf4; opacity: 0; transform: translateY(14px); transition: all 0.4s ease; }
    .explanation.in { opacity: 1; transform: translateY(0); }
    /* Outro CTA screen */
    #outro { align-items: center; justify-content: center; text-align: center; padding: 0 90px; background: radial-gradient(circle at 50% 40%, #1a3d7c, #0f2a5f 70%); }
    #outro .badge { width: 130px; height: 130px; border-radius: 30px; background: #0f2a5f; border: 6px solid #ea9600; display: flex; align-items: center; justify-content: center; margin-bottom: 30px; }
    #outro .badge svg { width: 70px; height: 70px; }
    #outro .headline { font-size: 62px; font-weight: 900; color: #fdfaf4; line-height: 1.2; }
    #outro .sub { margin-top: 26px; font-size: 40px; font-weight: 700; color: #ea9600; }
    #outro .sub2 { margin-top: 14px; font-size: 28px; font-weight: 600; color: rgba(253,250,244,0.75); }
    #outro .url { margin-top: 44px; font-size: 44px; font-weight: 900; color: #fdfaf4; }
  </style></head><body>
    <div class="screen show" id="hook">
      <div class="emoji">🚛</div>
      <div class="line">Would <span>YOU</span> pass<br>this CDL question?</div>
    </div>
    <div class="screen" id="main">
      <div class="brand">PassExam<span>HQ</span></div>
      <div class="topic" id="topic">${escapeHtml(q.topic)}</div>
      <div class="question" id="question">${escapeHtml(q.question)}</div>
      <div class="opts">${optionsHtml}</div>
      <div class="tension-wrap" id="tension"><div class="tension-bar"></div></div>
      <div class="explanation" id="explanation">${escapeHtml(q.explanation)}</div>
    </div>
    <div class="screen" id="outro">
      <div class="badge"><svg viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="7" fill="#0f2a5f"/><path d="M9 16.8 13.4 21 23 11" stroke="#ea9600" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="headline">${roundedCount.toLocaleString()}+ real ${escapeHtml(q.trackLabel)} practice questions</div>
      <div class="sub">Free to start. No app.</div>
      ${examType === GENERIC_CDL_EXAM_TYPE ? '<div class="sub2">Plus state-specific practice for all 50 states</div>' : ''}
      <div class="url">passexamhq.com</div>
    </div>
    <script>
      window.show = function (id) { document.getElementById(id).classList.add('show'); };
      window.hide = function (id) { document.getElementById(id).classList.remove('show'); };
      window.addClass = function (id, cls) { document.getElementById(id).classList.add(cls); };
      window.revealAnswer = function (correctKey) {
        document.querySelectorAll('.opt').forEach(function (el) {
          if (el.id === 'opt-' + correctKey) el.classList.add('correct');
          else el.classList.add('dim');
        });
        document.getElementById('explanation').classList.add('in');
      };
    </script>
  </body></html>`;
}

// Synthesized ambient audio bed -- two slightly detuned low sine tones (a common cheap "tension
// pad" trick), faded in/out, mixed very quietly. Self-generated via ffmpeg lavfi so there's zero
// licensing risk (no downloaded "royalty free" track from an uncertain source). Deliberately
// subtle background presence, not a substitute for real trending audio -- the user should still
// add a real trending sound in-app when posting to TikTok/Shorts/Reels, since those are
// platform-exclusive and not something sourceable here anyway.
function buildAmbientBed(ffmpeg, outPath, durationSec) {
  execFileSync(ffmpeg, [
    '-y',
    '-f', 'lavfi', '-i', `sine=frequency=110:duration=${durationSec}`,
    '-f', 'lavfi', '-i', `sine=frequency=138.5:duration=${durationSec}`,
    '-filter_complex',
    `[0:a]volume=0.05[a0];[1:a]volume=0.04[a1];[a0][a1]amix=inputs=2:duration=first,` +
    `afade=t=in:st=0:d=1.2,afade=t=out:st=${Math.max(0, durationSec - 1.5)}:d=1.5`,
    outPath,
  ]);
}

async function main() {
  const examType = process.argv[2];
  const outputDir = process.argv[3] || process.cwd();
  if (!examType) {
    console.error('Usage: node scripts/generate-qotd-video-v2.js <examType> [outputDir]');
    process.exit(1);
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.error('playwright is not installed. Run: npm install playwright (in this scripts dir, or set NODE_PATH)');
    process.exit(1);
  }

  const { ffmpeg } = findOrInstallFfmpeg();
  log('Using ffmpeg: ' + ffmpeg);

  log('Fetching today\'s real question for ' + examType + '...');
  const q = await fetchQuestion(examType);
  log('Topic: ' + q.topic);
  const questionCount = await fetchQuestionCount(examType);
  log('Real question bank size: ' + questionCount);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qotd-video-v2-'));
  const htmlPath = path.join(workDir, 'card.html');
  fs.writeFileSync(htmlPath, buildHtml(q, questionCount, examType), 'utf8');

  log('Recording video...');
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1080, height: 1920 },
    recordVideo: { dir: workDir, size: { width: 1080, height: 1920 } },
  });
  const page = await context.newPage();
  await page.goto('file://' + htmlPath.replace(/\\/g, '/'));

  await page.waitForTimeout(T.hookHold);
  await page.evaluate(() => { window.hide('hook'); window.show('main'); });
  await page.waitForTimeout(T.questionIn - T.mainIn);
  await page.evaluate(() => { window.addClass('topic', 'in'); window.addClass('question', 'in'); });
  await page.waitForTimeout(T.optA - T.questionIn);
  await page.evaluate(() => window.addClass('opt-A', 'in'));
  await page.waitForTimeout(T.optB - T.optA);
  await page.evaluate(() => window.addClass('opt-B', 'in'));
  await page.waitForTimeout(T.optC - T.optB);
  await page.evaluate(() => window.addClass('opt-C', 'in'));
  await page.waitForTimeout(T.optD - T.optC);
  await page.evaluate(() => window.addClass('opt-D', 'in'));
  await page.waitForTimeout(T.tensionStart - T.optD);
  await page.evaluate(() => window.addClass('tension', 'in'));
  await page.waitForTimeout(50);
  await page.evaluate(() => window.addClass('tension', 'drain'));
  await page.waitForTimeout(T.reveal - T.tensionStart - 50);
  await page.evaluate((k) => window.revealAnswer(k), q.correctChoice);
  await page.waitForTimeout(T.outroIn - T.reveal);
  await page.evaluate(() => { window.hide('main'); window.show('outro'); });
  await page.waitForTimeout(T.end - T.outroIn);

  const videoHandle = page.video();
  await context.close();
  await browser.close();
  const videoPath = await videoHandle.path();

  const totalSec = T.end / 1000;
  const audioPath = path.join(workDir, 'ambient.wav');
  log('Generating ambient audio bed...');
  buildAmbientBed(ffmpeg, audioPath, totalSec);

  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, examType + '_qotd_v2_' + q.date + '.mp4');
  log('Muxing final video...');
  execFileSync(ffmpeg, [
    '-y', '-i', videoPath, '-i', audioPath,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outPath,
  ]);

  log('Done: ' + outPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
