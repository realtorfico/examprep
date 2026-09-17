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
        this.stopped = 0;
        this.stop = () => { this.stopped++; if (this.onend) this.onend(); };
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

// ---- What the recognizer heard -> which answer -----------------------------------------------------
// Reported 2026-09-17: the button said "Listening…" but speaking a letter did nothing. Speech engines write a
// spoken letter as a word ("see"/"sea" for C, "bee" for B, "hey" for A, "dee" for D), and the old matcher looked
// for a letter ANYWHERE in the transcript -- so "see"/"the" matched nothing, "sea" picked A, and "number four"
// picked B because "number" contains a b. Matching is now word-by-word, and nothing is ever silent.

// Fires a result the way the browser does: results[i] is the alternatives list for one utterance, with isFinal.
function hear(r, ...alternatives) { fireResult(r, true, alternatives); }
function hearPartial(r, ...alternatives) { fireResult(r, false, alternatives); }
function fireResult(r, isFinal, alternatives) {
  const utterance = Object.assign(alternatives.map((transcript) => ({ transcript })), { length: alternatives.length, isFinal });
  r.onresult({ resultIndex: 0, results: Object.assign([utterance], { length: 1 }) });
}

const HEARD = [
  ['A', 'a'], ['A', 'A.'], ['A', 'hey'], ['A', 'eh'], ['A', 'ay'], ['A', 'option a'], ['A', 'first'],
  ['B', 'b'], ['B', 'be'], ['B', 'bee'], ['B', 'option B'], ['B', 'second'], ['B', 'letter b'],
  ['C', 'c'], ['C', 'see'], ['C', 'sea'], ['C', 'cee'], ['C', 'option c'], ['C', 'third'], ['C', 'the answer is c'],
  ['D', 'd'], ['D', 'dee'], ['D', 'the'], ['D', 'answer D'], ['D', 'fourth'], ['D', 'number four'],
];

for (const [expected, heard] of HEARD) {
  test(`heard "${heard}" -> answer ${expected}`, async (t) => {
    const answers = [];
    const { document, recognition } = await bootQuiz(t, answers);
    micButton(document).click();
    hear(recognition(), heard);
    await waitFor(() => answers.length === 1);
    assert.equal(answers[0].choice, expected);
    assert.match(transcript(document), new RegExp(heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), 'shows what was heard');
    await waitFor(() => document.querySelector('.explanation-box'));
    await settle();
  });
}

test('a later alternative is used when the first one is not an answer', async (t) => {
  const answers = [];
  const { document, recognition } = await bootQuiz(t, answers);
  micButton(document).click();
  hear(recognition(), 'sealed', 'c');
  await waitFor(() => answers.length === 1);
  assert.equal(answers[0].choice, 'C');
  await waitFor(() => document.querySelector('.explanation-box'));
  await settle();
});

test('two different letters in one utterance submits nothing and asks for one letter', async (t) => {
  const answers = [];
  const { document, recognition } = await bootQuiz(t, answers);
  micButton(document).click();
  hear(recognition(), 'a or b');
  await settle();
  assert.deepEqual(answers, [], 'never guesses between two letters');
  assert.match(transcript(document), /a or b/i, 'shows what was heard');
  assert.match(transcript(document), /just one|only one/i);
});

test('speech that is not an answer at all is reported, not ignored', async (t) => {
  const answers = [];
  const { document, recognition } = await bootQuiz(t, answers);
  micButton(document).click();
  hear(recognition(), 'what is the speed limit');
  await settle();
  assert.deepEqual(answers, []);
  assert.match(transcript(document), /what is the speed limit/i);
  assert.match(transcript(document), /say A, B, C, or D/i);
});

// Reported 2026-09-17 (Android): listening started, the answer was spoken, and the page still said "Didn't
// catch that" -- i.e. the session ended with no result and no error. Chrome on Android does that with
// continuous/non-interim recognition, so act on partial results as soon as one names a letter.

test('recognition asks for continuous + interim results (a final-only session can end with nothing)', async (t) => {
  const { document, recognition } = await bootQuiz(t, []);
  micButton(document).click();
  assert.equal(recognition().continuous, true);
  assert.equal(recognition().interimResults, true);
});

test('a partial result naming a letter answers immediately and stops listening', async (t) => {
  const answers = [];
  const { document, recognition } = await bootQuiz(t, answers);
  micButton(document).click();
  const r = recognition();
  hearPartial(r, 'bee');
  await waitFor(() => answers.length === 1);
  assert.equal(answers[0].choice, 'B');
  assert.equal(r.stopped, 1, 'stops listening once it has the answer');
  await waitFor(() => document.querySelector('.explanation-box'));
  await settle();
});

test('a partial result that is not an answer yet keeps listening and shows what it is hearing', async (t) => {
  const answers = [];
  const { document, recognition } = await bootQuiz(t, answers);
  micButton(document).click();
  const r = recognition();
  hearPartial(r, 'the answer');
  await settle();
  assert.deepEqual(answers, [], 'no answer submitted from a partial non-match');
  assert.match(transcript(document), /hearing/i);
  assert.equal(r.stopped, 0, 'still listening');
  hear(r, 'the answer is d');
  await waitFor(() => answers.length === 1);
  assert.equal(answers[0].choice, 'D');
  await waitFor(() => document.querySelector('.explanation-box'));
  await settle();
});

test('listening that ends with nothing heard says so (no error event, no result)', async (t) => {
  const { document, recognition } = await bootQuiz(t, []);
  micButton(document).click();
  recognition().onend();
  await settle();
  assert.match(transcript(document), /catch that|didn't hear/i);
  assert.equal(micButton(document).textContent, '🎙️ Voice Answer');
});

test('guard: after a voice answer the mic zone gives way to the explanation, and onend adds no stray message', async (t) => {
  const answers = [];
  const { document, recognition } = await bootQuiz(t, answers);
  micButton(document).click();
  const r = recognition();
  hear(r, 'c');
  await waitFor(() => answers.length === 1);
  await waitFor(() => document.querySelector('.explanation-box'));
  r.onend(); // the browser ends the session after the result; the mic zone is gone by now
  await settle();
  assert.equal(document.getElementById('mic-transcript'), null, 'answered question shows no mic zone');
  assert.equal(micButton(document), null);
});
