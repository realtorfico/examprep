// What a CDL seeker gets in the first few seconds of /cdl. Added 2026-09-17, after reading the
// live page as one: the subhead was fixed first (see landing-first-paint.test.js), and then five
// things were still wrong on a glance --
//   1. On desktop the hero's left column ended at the CTA, leaving ~400px of empty navy beside a
//      full right column. The coverage chips moved over to fill it (they answer "is MY endorsement
//      in here", which belongs with the copy, not buried in the spec panel).
//   2. Nothing on the first screen said how big the bank is or what happens if you fail. One
//      proof line under the CTA now carries both.
//   3. "View full California CDL track details →" -- "track" is our word, not a seeker's.
//   4. Three stacked elements asked one question (a 📍 badge, "Pick your state below ↓", and the
//      "Select your state" label). Now: the picker, then one quiet line saying where the state came
//      from. The amber badge was also flagged as too flashy on 2026-09-17.
//   5. On a phone the promo ribbon ate the top ~200px before the headline -- a discount before the
//      visitor knows what is being sold. Compacted to one slim line on mobile.
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp, waitFor, settle } = require('../test-support/boot-app');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'wwwroot', 'css', 'style.css'), 'utf8');

const COUNT_STUBS = [
  ['/resources/catalog', { counts: { ca_cdl: { tables: 5, decks: 3, cards: 30, audio: 3 } } }],
  ['/questions/counts', { counts: [{ exam_type: 'ca_cdl', count: 467 }, { exam_type: 'tx_cdl', count: 512 }] }],
];

async function bootCategory(t, slug, extra) {
  const booted = await bootApp(Object.assign({ url: 'https://passexamhq.com/' + slug }, extra || {}));
  t.after(() => booted.dom.window.close());
  await waitFor(() => booted.document.getElementById('category-hero-headline'));
  await settle();
  return booted;
}

// Concatenated contents of every @media (max-width: 600px) block in style.css.
function mobileCss() {
  let out = '';
  const re = /@media \(max-width: 600px\)\s*\{/g;
  let m;
  while ((m = re.exec(CSS))) {
    let depth = 1, i = re.lastIndex;
    for (; i < CSS.length && depth; i++) { if (CSS[i] === '{') depth++; else if (CSS[i] === '}') depth--; }
    out += CSS.slice(re.lastIndex, i - 1) + '\n';
  }
  return out;
}

// ---- 1. The left column carries the coverage, so the desktop hero isn't half empty -------------

test('the endorsement chips sit in the hero copy, not in the side panel', async (t) => {
  const { document } = await bootCategory(t, 'cdl');
  const chipsInCopy = document.querySelectorAll('.hub-hero-copy .category-spec-chips li');
  const names = Array.from(chipsInCopy).map((el) => el.textContent);
  for (const endorsement of ['Air brakes', 'Combination vehicles', 'Doubles/Triples', 'HazMat', 'Passenger', 'School bus', 'Tanker']) {
    assert.ok(names.includes(endorsement), 'missing endorsement chip in the hero copy: ' + endorsement);
  }
  assert.equal(document.querySelector('.hub-hero-side .category-spec-chips'), null,
    'the chips moved out of the side panel -- two copies would be the duplication we just removed');
});

// ---- 2. Proof on the first screen --------------------------------------------------------------

test('the first screen says how big the bank is and what happens if you fail', async (t) => {
  const { document } = await bootCategory(t, 'cdl', { fetchOverrides: COUNT_STUBS });
  const proof = document.querySelector('.hub-hero-copy .category-hero-proof');
  assert.ok(proof, 'expected a proof line inside the hero copy');
  assert.match(proof.textContent, /467/, 'the bank size for the state on screen, from /questions/counts');
  assert.match(proof.textContent, /practice questions/);
  assert.match(proof.textContent, /refund/i, 'and the risk reversal, which was three screens down');
});

test('CSS: the proof line is inline text, so the refund figure cannot wrap away from its %', () => {
  // Shipped broken for one deploy: the line was a flex container, which makes every inline child a
  // flex item -- including the <span class="js-refund-pct">50</span> that carries the figure. The
  // live line read "467 California practice questions · 50" / "% refunded if you don't pass".
  const rule = CSS.match(/\.category-hero-proof\s*\{[^}]*\}/g) || [];
  assert.ok(rule.length, 'expected a .category-hero-proof rule');
  for (const r of rule) {
    assert.ok(!/display:\s*(flex|inline-flex|grid)/.test(r), 'the proof line must stay inline text: ' + r);
  }
});

test('the proof line renders before its count arrives, so it cannot shift the hero', async (t) => {
  // Same trap as the spec panel's inventory: the number is fetched, the line is not. It must exist
  // at first render with a placeholder, or the count landing pushes everything below it down.
  const { document } = await bootCategory(t, 'cdl', { fetchOverrides: [['/questions/counts', null]] });
  const proof = document.querySelector('.hub-hero-copy .category-hero-proof');
  assert.ok(proof, 'the line is there even when the count never arrives');
  assert.match(proof.textContent, /practice questions/);
});

test('a scored, non-pass/fail exam does not claim a pass-or-refund on its hero', async (t) => {
  // ACT/DAT/CLT/OAT have no "fail the real exam" concept (passPercent IS NULL) -- the page's
  // guarantee band already varies on this, and the hero line has to vary with it. The shared
  // registry fixture gives every track passPercent: 70, so this one states the real shape itself.
  const { document } = await bootCategory(t, 'act', {
    fetchOverrides: [['/track-registry', { tracks: [{
      examType: 'act', stateCode: 'US', examKind: 'ACT', shortName: 'ACT',
      active: true, isExamRequired: true, questionCount: 215, durationSec: 10800,
      passPercent: null, minCorrect: null, mechanicsNote: '',
    }] }]],
  });
  const proof = document.querySelector('.hub-hero-copy .category-hero-proof');
  assert.ok(proof, 'the ACT hero should still carry a proof line');
  assert.ok(!/don't pass/i.test(proof.textContent), 'got: ' + proof.textContent);
  assert.match(proof.textContent, /7 days/, 'the refund it does have');
});

// ---- 3. The onward link in a seeker's words ----------------------------------------------------

test('the hero link out says what is included, not "track details"', async (t) => {
  const { document } = await bootCategory(t, 'cdl');
  const link = document.querySelector('#category-hero-track-link-wrap a');
  assert.ok(link, 'expected the hero link to the state page');
  assert.match(link.textContent, /See what's included/);
  assert.ok(!/track details/i.test(document.querySelector('.hub-hero').textContent),
    '"track" is our word for it, not the visitor\'s');
});

// ---- 4. One question, asked once ---------------------------------------------------------------

test('the state row is the picker plus one quiet line, in that order', async (t) => {
  const { document } = await bootCategory(t, 'cdl');
  const row = document.getElementById('category-state-row-wrap');
  assert.ok(row);
  const label = row.querySelector('.category-state-select-label');
  const note = row.querySelector('#category-state-detected-banner');
  assert.ok(label, 'the picker is still there');
  assert.ok(note, 'and the line saying where the state came from');
  assert.ok(label.compareDocumentPosition(note) & 4, 'the note follows the picker it refers to');
  assert.ok(!row.textContent.includes('Pick your state below'), 'the picker is right there -- no need to point down at it');
  assert.equal(row.querySelector('.category-state-detected-badge'), null, 'the amber badge was flagged as too flashy');
  assert.ok(!/📍|❓/.test(row.textContent), 'and its emoji went with it');
});

test('the picker is labelled in the visitor\'s terms', async (t) => {
  const { document } = await bootCategory(t, 'cdl');
  const label = document.querySelector('.category-state-select-label');
  assert.match(label.textContent, /Your state/);
  assert.ok(label.querySelector('select[data-act="pick-category-state"]'), 'still the same control');
});

test('the note still says only what we actually know about the state', async (t) => {
  // Unchanged claims, new shape -- see categoryStateSource(): geo / cookie / fallback.
  const probe = await bootApp({ url: 'https://passexamhq.com/cdl' });
  const state = probe.document.querySelector('.category-state-select').value;
  probe.dom.window.close();

  const geo = await bootCategory(t, 'cdl', {
    cookie: 'pxq_state=' + state,
    windowSetup: (window) => {
      const meta = window.document.createElement('meta');
      meta.name = 'pxq-geo-state';
      meta.content = state;
      window.document.head.appendChild(meta);
    },
  });
  assert.match(geo.document.getElementById('category-state-detected-banner').textContent, /Based on your location/);

  const unknown = await bootCategory(t, 'cdl', { cookie: 'pxq_state=ZZ' });
  assert.match(unknown.document.getElementById('category-state-detected-banner').textContent, /as an example/);
});

// ---- 5. The promo ribbon does not outrank the headline on a phone ------------------------------

test('CSS: on mobile the promo ribbon is one slim line, not three', () => {
  const mobile = mobileCss();
  assert.match(mobile, /\.promo-ribbon \.promo-banner-body strong\s*\{[^}]*font-size/,
    'the ribbon title inherits .promo-banner-body strong at 1.05rem -- bigger than the H1 deserves on a phone');
  assert.match(mobile, /\.promo-ribbon \.promo-banner-dismiss\s*\{[^}]*position:\s*absolute/,
    'the ✕ took a whole third row to itself');
  assert.match(mobile, /\.promo-ribbon \.promo-banner\s*\{[^}]*position:\s*relative/,
    'which needs a positioned parent');
});

// ---- Everything above still follows the state picker -------------------------------------------

test('switching state re-renders the proof line with the new state\'s count', async (t) => {
  const { document, window } = await bootCategory(t, 'cdl', { fetchOverrides: COUNT_STUBS });
  const select = document.getElementById('category-state-select');
  select.value = 'TX';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const proof = document.querySelector('.hub-hero-copy .category-hero-proof');
  assert.match(proof.textContent, /512/, 'the count should follow the picker, not stay on California');
  const link = document.querySelector('#category-hero-track-link-wrap a');
  assert.match(link.textContent, /Texas/, 'and so should the link out');
});
