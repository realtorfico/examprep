// Quiz voice answering (🎙️ Voice Answer). Found broken 2026-09-17: wwwroot/_headers sent
// `Permissions-Policy: microphone=()`, which disables the microphone for the site itself. Verified in real
// Google Chrome against the live site: SpeechRecognition.start() failed instantly with "not-allowed"; the
// same page with only that header removed started and captured audio. The header dated from the first
// commit (2026-07-22), and because setupMic() had no onerror handler the button just silently reset, so
// nobody noticed. Chrome/Edge (incl. Android) enforce the header; the About page advertises voice answering.
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp, waitFor, settle } = require('../test-support/boot-app');

// ---- The header ------------------------------------------------------------------------------------

function sitePermissionsPolicy() {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'wwwroot', '_headers'), 'utf8').split(/\r?\n/);
  const start = lines.indexOf('/*');
  for (let i = start + 1; i < lines.length && /^\s/.test(lines[i]); i++) {
    const m = lines[i].match(/^\s*Permissions-Policy:\s*(.*)$/);
    if (m) return Object.fromEntries(m[1].split(',').map((d) => d.trim().split('=')));
  }
  assert.fail('no Permissions-Policy in the /* block');
}

test('site Permissions-Policy allows the microphone for the site itself (voice answering needs it)', () => {
  assert.equal(sitePermissionsPolicy().microphone, '(self)');
});

test('guard: geolocation and camera stay disabled (the site never uses them)', () => {
  const policy = sitePermissionsPolicy();
  assert.equal(policy.geolocation, '()');
  assert.equal(policy.camera, '()');
});

// ---- The quiz mic button ---------------------------------------------------------------------------

const QUESTION = {
  id: 'ca_cdl-b1-001', examType: 'ca_cdl', topic: 'General Knowledge', question: 'Which is correct?',
  choices: { A: 'first', B: 'second', C: 'third', D: 'fourth' },
};

async function bootQuiz(t, answers) {
  const recognizers = [];
  const booted = await bootApp({
    url: 'https://passexamhq.com/cdl/ca#/quiz',
    localStorageItems: { examprep_token: 'test-token-abc' },
    windowSetup(win) {
      win.HTMLElement.prototype.scrollIntoView = function () {}; // jsdom lacks it; the quiz scrolls to each question
      win.webkitSpeechRecognition = function FakeRecognition() {
        this.started = 0;
        this.start = () => { this.started++; };
        this.stop = () => { if (this.onend) this.onend(); };
        recognizers.push(this);
      };
    },
    fetchOverrides: [
      ['/prefs', { examType: 'ca_cdl', ownedTopics: null }],
      ['/questions/next', QUESTION],
      ['/answer', (href, opts) => { answers.push(JSON.parse(opts.body)); return { correct: true, correctChoice: 'B', explanation: 'x', totalAnswered: 1, totalCorrect: 1 }; }],
    ],
  });
  t.after(() => booted.dom.window.close());
  await waitFor(() => booted.document.querySelector('[data-act="mic-toggle"]'));
  const recognition = () => recognizers[recognizers.length - 1];
  return { ...booted, recognition };
}
const micButton = (document) => document.querySelector('[data-act="mic-toggle"]');
const transcript = (document) => document.getElementById('mic-transcript').textContent;

test('guard: tapping Voice Answer starts listening', async (t) => {
  const { document, recognition } = await bootQuiz(t, []);
  micButton(document).click();
  await settle();
  assert.equal(recognition().started, 1);
  assert.match(micButton(document).textContent, /Listening/);
});

test('guard: saying "option b" submits answer B', async (t) => {
  const answers = [];
  const { document, recognition } = await bootQuiz(t, answers);
  micButton(document).click();
  recognition().onresult({ results: [[{ transcript: 'Option B' }]] });
  await waitFor(() => answers.length === 1);
  assert.equal(answers[0].choice, 'B');
  await waitFor(() => document.querySelector('.explanation-box')); // let the answer finish rendering before the window closes
  await settle();
});

test('a blocked microphone is explained, not silently ignored, and the button resets', async (t) => {
  const { document, recognition } = await bootQuiz(t, []);
  micButton(document).click();
  const r = recognition();
  assert.equal(typeof r.onerror, 'function', 'recognition errors are handled');
  r.onerror({ error: 'not-allowed' });
  r.onend();
  assert.match(transcript(document), /microphone/i);
  assert.match(transcript(document), /allow/i);
  assert.equal(micButton(document).textContent, '🎙️ Voice Answer');
});

test('hearing nothing asks the user to try again', async (t) => {
  const { document, recognition } = await bootQuiz(t, []);
  micButton(document).click();
  const r = recognition();
  assert.equal(typeof r.onerror, 'function', 'recognition errors are handled');
  r.onerror({ error: 'no-speech' });
  assert.match(transcript(document), /try again|say A, B, C, or D/i);
});

test('any other recognition failure says voice input is not working and points to tapping an answer', async (t) => {
  const { document, recognition } = await bootQuiz(t, []);
  micButton(document).click();
  const r = recognition();
  assert.equal(typeof r.onerror, 'function', 'recognition errors are handled');
  r.onerror({ error: 'network' });
  assert.match(transcript(document), /tap an answer/i);
});
