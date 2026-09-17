// /cdl1 -- a rebuilt CDL landing page, for the user to compare against the live /cdl before any of
// it is adopted. Same design system, same real data, different content order and a lot less of it.
//
// Built 2026-09-17 from the content review of /cdl in that session. The live page is 7.8 screens
// and spends its first 1.7 on claims: four trust chips, a nine-number sitewide stats band
// (33,175 questions "across all states", 110 articles, 224 tables, 164 decks, 98 audio lessons),
// four emoji feature tiles that repeat the chips, and three competing secondary links -- while the
// things a CDL candidate is actually shopping for sit far below: the exam's own format (50
// questions, 40/50 to pass, untimed) at screen 2.0 and which endorsements are covered at 3.7.
//
// This page is a prototype, not a wired route: it is plain static HTML (no app.js), so it also
// serves as the performance ceiling to measure the real page against.
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WWWROOT = path.join(__dirname, '..', 'wwwroot');
const PAGE = fs.readFileSync(path.join(WWWROOT, 'cdl1.html'), 'utf8');
const PAGE_JS = fs.readFileSync(path.join(WWWROOT, 'js', 'cdl1.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(WWWROOT, 'index.html'), 'utf8');

// The page's own helpers, evaluated with a bare window (no DOM needed for these).
function loadHelpers() {
  const win = { addEventListener() {}, location: { pathname: '/cdl1' } };
  const doc = { addEventListener() {}, readyState: 'complete', getElementById: () => null, querySelectorAll: () => [], querySelector: () => null };
  new Function('window', 'document', PAGE_JS)(win, doc);
  return win;
}

// ---- It must not compete with the real page ---------------------------------------------------

test('the prototype is noindex and points its canonical at the real page', () => {
  assert.match(PAGE, /<meta name="robots" content="noindex, ?nofollow">/, 'a second CDL landing page in the index would split /cdl\'s own ranking');
  assert.match(PAGE, /<link rel="canonical" href="https:\/\/www\.passexamhq\.com\/cdl">/);
  assert.ok(!fs.readFileSync(path.join(WWWROOT, 'sitemap.xml'), 'utf8').includes('/cdl1'), 'it must stay out of the sitemap');
});

// ---- Nothing blocks the first paint but CSS ---------------------------------------------------

test('no script blocks rendering', () => {
  const scripts = PAGE.match(/<script[^>]*>/g) || [];
  for (const tag of scripts) {
    assert.ok(/\bdefer\b|\basync\b/.test(tag), 'render-blocking script on the prototype: ' + tag);
  }
});

test('it blocks on exactly one small stylesheet', () => {
  // It first shipped blocking on hero.css + the whole 86KB style.min.css, which cost ~630ms of
  // first paint (1,820ms vs /cdl's 1,190ms) for rules the page doesn't use.
  const sheets = PAGE.match(/<link rel="stylesheet"[^>]*>/g) || [];
  assert.equal(sheets.length, 1, 'expected one stylesheet, found: ' + sheets.join(' '));
  assert.match(sheets[0], /\/css\/cdl1\.min\.css\?v=\d+/);
  // A link tag, not a mention: the page's own comment explains why style.min.css isn't linked.
  assert.ok(!/<link[^>]*style\.min\.css/.test(PAGE), 'the prototype must not block on the whole site stylesheet');

  const generated = fs.readFileSync(path.join(WWWROOT, 'css', 'cdl1.min.css'), 'utf8');
  const { buildCdl1Css } = require('../scripts/build-cdl1-css');
  assert.equal(
    generated,
    buildCdl1Css(fs.readFileSync(path.join(WWWROOT, 'css', 'style.css'), 'utf8'), fs.readFileSync(path.join(WWWROOT, 'css', 'cdl1.css'), 'utf8')),
    'wwwroot/css/cdl1.min.css is out of date -- run `npm run build`',
  );
  // It inherits the real tokens rather than copying values, and carries the fonts it preloads.
  for (const needed of ['--accent', '@font-face', '.t1-hero', '.btn-primary']) {
    assert.ok(generated.includes(needed), 'cdl1.min.css should carry ' + needed);
  }
  // Cap is a tripwire, not a target: the point is that it stays a fraction of style.min.css's 86KB.
  assert.ok(generated.length < 20000, 'cdl1.min.css has grown to ' + generated.length + ' bytes');
});

test('both fonts are preloaded here too', () => {
  assert.match(PAGE, /<link rel="preload" as="font"[^>]*inter-var-subset/, 'see index.html for the measurements behind this');
  assert.match(PAGE, /<link rel="preload" as="font"[^>]*fraunces-var-subset/);
  assert.ok(INDEX.includes('inter-var-subset'), 'and the live page should still preload them');
});

// ---- What a CDL candidate came for, in the HTML itself ----------------------------------------

test('the exam\'s own format is on the first screen, in the HTML', () => {
  // On the live page this sits at screen 2.0, below a stats band and four feature tiles.
  const firstScreen = PAGE.slice(0, PAGE.indexOf('id="sample"'));
  assert.match(firstScreen, /50 multiple choice/i);
  assert.match(firstScreen, /40\s*\/\s*50/);
  assert.match(firstScreen, /80%/);
  assert.match(firstScreen, /untimed/i);
});

test('the endorsements are named on the first screen', () => {
  // Screen 3.7 on the live page, and the single thing CDL candidates shop hardest for.
  const firstScreen = PAGE.slice(0, PAGE.indexOf('id="sample"'));
  for (const endorsement of ['Air brakes', 'Combination', 'Doubles', 'HazMat', 'Passenger', 'School bus', 'Tanker']) {
    assert.ok(new RegExp(endorsement, 'i').test(firstScreen), endorsement + ' should be named up front');
  }
});

test('it states the price and that it is one-time', () => {
  assert.match(PAGE, /id="price"/, 'the price element should be server-rendered, then confirmed from /api/pricing');
  assert.match(PAGE, /one-time/i);
});

test('there is one primary call to action, not two competing ones', () => {
  assert.ok(!/Try Free Sample/i.test(PAGE), 'the live page has two CTAs that scroll to the same widget');
  const ctas = PAGE.match(/class="[^"]*btn-primary[^"]*"/g) || [];
  assert.ok(ctas.length <= 2, 'expected at most the practice CTA and the buy CTA, found ' + ctas.length);
});

test('the free sample and the topic breakdown are both present', () => {
  assert.match(PAGE, /id="sample"/);
  assert.match(PAGE, /id="breakdown"/);
});

// ---- What the track page carries before checkout ---------------------------------------------

// /cdl1's buy links go straight to #/buy, skipping /cdl/ca, so everything that page says before
// taking money has to be said here instead. Taken from the live /cdl/ca (2026-09-17): the real
// per-state inventory (467 questions, 5 quick-fact tables, 3 flashcard decks of 30 cards, 3 audio
// lessons), what access actually includes, the à la carte alternative, the student discount, the
// refund terms in full, and the agency disclaimer.
test('it says what access includes', () => {
  for (const claim of [
    /unlimited practice/i,
    /mock exam/i,
    /Weak Spots/i,
    /[Vv]oice/,
    /progress/i,
  ]) {
    assert.match(PAGE, claim, 'missing an included-feature claim the track page makes: ' + claim);
  }
});

test('it shows the real per-state inventory, not sitewide totals', () => {
  assert.match(PAGE, /id="inv-questions"/);
  assert.match(PAGE, /id="inv-tables"/);
  assert.match(PAGE, /id="inv-decks"/);
  assert.match(PAGE, /id="inv-audio"/);
  // Filled from the same endpoints the track page uses, keyed by examType.
  assert.match(PAGE_JS, /resources\/catalog\?counts=1/);
  assert.match(PAGE_JS, /questions\/counts/);
});

test('the inventory renderer reads the real API shape', () => {
  const { inventoryFor } = loadHelpers();
  const counts = { ca_cdl: { tables: 5, decks: 3, cards: 30, audio: 3, video: 0 } };
  const inv = inventoryFor('CA', counts, 467);
  assert.equal(inv.questions, '467');
  assert.equal(inv.tables, '5');
  assert.equal(inv.decks, '3 (30 cards)');
  assert.equal(inv.audio, '3');
  // A track with nothing recorded shows a dash rather than a zero-claim.
  const empty = inventoryFor('AK', { ak_cdl: { tables: 0, decks: 0, cards: 0, audio: 0 } }, 0);
  assert.equal(empty.tables, '—');
  assert.equal(empty.audio, '—');
});

test('the freshness stamp says updated, not verified', () => {
  // The API's own comment is explicit that questionsUpdatedAt proves questions were added or
  // changed that day, not that every existing question was re-read. The live track page is careful
  // about this wording; so is this page.
  assert.match(PAGE, /id="updated"/);
  assert.match(PAGE, /last updated/i);
  assert.ok(!/verified/i.test(PAGE), 'do not upgrade "updated" to "verified"');
  assert.match(PAGE_JS, /questionsUpdatedAt/);
  assert.match(PAGE, /<p class="t1-updated" id="updated" hidden>/, 'hidden until known -- an empty date would read as a broken claim');
});

test('the cheaper per-topic option is not hidden', () => {
  // The track page offers "Only need certain topics? Buy just what you need" -- sending everyone
  // straight to full-price checkout without it is the kind of omission that reads as a dark pattern.
  assert.match(PAGE, /only need certain topics/i);
  assert.match(PAGE, /id="buy-topics"/);
});

test('the free resources preview is linked, per state', () => {
  // Real ungated content (#/resources signs the free-sample allowlist for anonymous visitors), so
  // it's proof of quality rather than a locked teaser. Deliberately NOT the cheat-sheet article,
  // which sends an ad click into a long read instead of a decision.
  assert.match(PAGE, /id="resources"[^>]*href="\/cdl\/ca#\/resources"/);
  assert.match(PAGE_JS, /'#\/resources'/, 'the link should follow the state picker');
  assert.ok(!/Cheat Sheet/i.test(PAGE), 'the cheat-sheet article belongs on /cdl or the footer, not here');
  // Not styled as another primary CTA.
  assert.ok(!/id="resources"[^>]*btn-primary/.test(PAGE));
});

test('the student discount is mentioned', () => {
  assert.match(PAGE, /\.edu/);
  assert.match(PAGE, /\$5/);
});

test('the refund terms are stated in full, not rounded off', () => {
  // "50% back" alone leaves out the condition the track page states: you have to sit the real exam
  // within 180 days.
  assert.match(PAGE, /180 days/);
  assert.match(PAGE, /7-day/i);
});

test('the agency disclaimer is present', () => {
  assert.match(PAGE, /[Nn]ot affiliated/);
  assert.match(PAGE, /FMCSA/);
});

// ---- And what the review said to cut ----------------------------------------------------------

test('the sitewide vanity stats band is gone', () => {
  for (const claim of ['33,175', 'ARTICLES & GUIDES', 'QUICK-FACT TABLES', 'FLASHCARD DECKS', 'AUDIO LESSONS']) {
    assert.ok(!PAGE.includes(claim), 'the prototype should not carry the sitewide stats band: ' + claim);
  }
});

test('the feature tiles that repeated the trust chips are gone', () => {
  assert.ok(!PAGE.includes('One code in'), 'product trivia, not a reason to buy');
  assert.ok(!/Timed mocks that mirror the real format/.test(PAGE));
});

test('it carries two testimonials, not four', () => {
  const quotes = PAGE.match(/class="[^"]*t1-quote/g) || [];
  assert.equal(quotes.length, 2, 'found ' + quotes.length + ' testimonials');
});

test('the page is short', () => {
  // Not a proxy for rendered height, but a cap on how much got added back: the live page's own
  // #app markup is far larger, and every section here has to earn its place.
  assert.ok(PAGE.length < 26000, 'cdl1.html has grown to ' + PAGE.length + ' bytes');
});

// ---- The small amount of script it does run ---------------------------------------------------

test('the free sample prefers a General Knowledge question', () => {
  // The live page served whatever /api/sample returned first -- a school-bus endorsement question
  // on the run that was reviewed. General Knowledge is 48% of the bank and every candidate has to
  // pass it, so it is the honest thing to show first.
  const { pickSampleQuestion } = loadHelpers();
  const questions = [
    { id: 'a', topic: 'Air Brakes, Combination Vehicles & Doubles/Triples' },
    { id: 'b', topic: 'General Knowledge (CDL Rules, Safe Driving & Cargo)' },
    { id: 'c', topic: 'Vehicle Inspection Procedures' },
  ];
  assert.equal(pickSampleQuestion(questions).id, 'b');
  // Falls back to the first question rather than showing nothing.
  assert.equal(pickSampleQuestion([questions[0], questions[2]]).id, 'a');
  assert.equal(pickSampleQuestion([]), null);
});

test('the promo band is server-rendered at a fixed height, with the guarantee tagline as its floor', () => {
  // The live site's ribbon starts empty at its reserved 36px and grows to ~90px on a phone when the
  // promo lands, shifting everything below it. Here the band always has content and a fixed height,
  // so the swap can't move anything.
  assert.match(PAGE, /<div class="t1-promo" id="promo">/);
  assert.match(PAGE, /Real practice, real guarantees/, 'the band should never be empty while it waits');
  const css = fs.readFileSync(path.join(WWWROOT, 'css', 'cdl1.css'), 'utf8');
  assert.match(css, /\.t1-promo\s*\{[^}]*height:\s*2\.5rem/, 'a fixed height, not a min-height');
  assert.match(css, /\.t1-promo\s*\{[^}]*white-space:\s*nowrap/, 'and one line, so promo length cannot change it');
});

test('the promo band renders the live promo with its code', () => {
  const { promoBandHtml } = loadHelpers();
  const html = promoBandHtml({ id: 1, title: 'First-time buyers: 20% off full CDL access', promoCode: 'NEWCDL20' });
  assert.match(html, /First-time buyers: 20% off full CDL access/);
  assert.match(html, /class="t1-promo-code">NEWCDL20</);
  assert.match(html, /href="\/cdl\/ca#\/buy"/, 'and it should link to the state the visitor is looking at');
});

test('no promo means the tagline stays put', () => {
  const { promoBandHtml } = loadHelpers();
  assert.equal(promoBandHtml(null), '');
  assert.equal(promoBandHtml({ id: 2 }), '', 'a promo with no title is not renderable either');
});

test('the promo is scoped to the CDL kind', () => {
  assert.match(PAGE_JS, /placement=home&kind='\s*\+\s*encodeURIComponent\('Commercial Driver \(CDL\)'\)/, 'an unscoped fetch could show another track\'s promo on a CDL page');
});

test('the sticky buy bar is the same action, not a third competing CTA', () => {
  assert.match(PAGE, /class="t1-sticky-buy"/);
  assert.ok(!/class="[^"]*btn-primary[^"]*"[^>]*t1-sticky/.test(PAGE), 'it should not be styled as another primary CTA');
  const css = fs.readFileSync(path.join(WWWROOT, 'css', 'cdl1.css'), 'utf8');
  assert.match(css, /@media \(max-width: 680px\) \{ \.t1-sticky \{ display: flex/, 'phones only');
});

test('cdl1.js loads before the catalog it registers', () => {
  // Deferred scripts run in document order. With content/cdl.js first, its
  // window.registerTrackContent(...) call hits an undefined function and throws, and the coverage
  // bars render empty -- which is exactly what shipped in the first version of this page.
  assert.ok(
    PAGE.indexOf('js/cdl1.js') < PAGE.indexOf('js/content/cdl.js'),
    'cdl1.js defines the registrar, so it has to run first',
  );
});

test('startup waits for the other deferred scripts', () => {
  // A deferred script runs when readyState is already 'interactive', so anything that only waits on
  // 'loading' starts before its siblings -- here, before content/cdl.js registers the catalog. That
  // shipped once and rendered the coverage card empty on the live page.
  for (const readyState of ['loading', 'interactive']) {
    let deferredTo = null;
    let gotElement = false;
    const doc = {
      readyState,
      addEventListener: (type) => { deferredTo = type; },
      getElementById: () => { gotElement = true; return null; },
      querySelectorAll: () => [], querySelector: () => null,
    };
    new Function('window', 'document', PAGE_JS)({ addEventListener() {}, location: { pathname: '/cdl1' } }, doc);
    assert.equal(deferredTo, 'DOMContentLoaded', 'with readyState=' + readyState + ' it must wait');
    assert.equal(gotElement, false, 'and must not have started rendering yet');
  }
});

test('a catalog registered after the first render still fills the page', () => {
  // Belt and braces for the same class of bug: whatever the script order, the coverage bars appear.
  const bars = { innerHTML: '' };
  const doc = {
    readyState: 'complete', addEventListener() {},
    getElementById: (id) => (id === 'bars' ? bars : (id === 'state' ? { value: 'CA', addEventListener() {} } : null)),
    querySelectorAll: () => [], querySelector: () => null,
  };
  const win = { addEventListener() {}, location: { pathname: '/cdl1' }, fetch: () => Promise.reject(new Error('no network in this test')) };
  new Function('window', 'document', PAGE_JS)(win, doc);
  assert.equal(bars.innerHTML, '', 'nothing to render before the catalog arrives');
  win.registerTrackContent('cdl', [{ examType: 'ca_cdl', route: '/cdl/ca', breakdown: [['General Knowledge', '48%']] }]);
  assert.match(bars.innerHTML, /General Knowledge/, 'registering the catalog should re-render what needed it');
});

test('the coverage bars render from a catalog entry', () => {
  // The bug above was invisible to every string assertion on the page, so exercise the renderer.
  const html = [];
  const bars = { innerHTML: '' };
  const win = { addEventListener() {}, location: { pathname: '/cdl1' } };
  const doc = {
    addEventListener() {}, readyState: 'complete',
    getElementById: (id) => (id === 'bars' ? bars : null),
    querySelectorAll: () => [], querySelector: () => null,
  };
  new Function('window', 'document', PAGE_JS)(win, doc);
  win.registerTrackContent('cdl', [{
    examType: 'ca_cdl', route: '/cdl/ca', questions: '50 Multiple Choice', passScore: '40/50 (80%)', duration: 'Untimed',
    breakdown: [['General Knowledge', '48%'], ['Air Brakes', '19%']],
  }]);
  win.renderStateForTest('CA');
  assert.match(bars.innerHTML, /General Knowledge/);
  assert.match(bars.innerHTML, /width:48%/);
  assert.match(bars.innerHTML, /48%<\/span>/);
  assert.ok(html.length === 0);
});

test('state facts come from the shared catalog, not a copy', () => {
  assert.match(PAGE_JS, /registerTrackContent/, 'cdl1.js should read js/content/cdl.js, the same catalog app.js uses');
  assert.match(PAGE, /js\/content\/cdl\.js\?v=\d+/, 'and the page should load it');
  const { stateFactsText } = loadHelpers();
  const facts = stateFactsText({ questions: '50 Multiple Choice (General Knowledge)', passScore: '40/50 Correct (80%)', duration: 'Untimed' });
  assert.match(facts, /50 Multiple Choice/);
  assert.match(facts, /40\/50/);
  assert.match(facts, /Untimed/);
});

test('the buy link goes to the real checkout for the chosen state', () => {
  const { buyHref } = loadHelpers();
  assert.equal(buyHref('CA'), '/cdl/ca#/buy');
  assert.equal(buyHref('tx'), '/cdl/tx#/buy');
});
