// The deep bundle: every route this file owns is fetched on demand, not on every page view.
//
// What lives here: the static, legal and marketing routes -- #/terms, #/privacy, #/about, #/faq,
// #/guarantee, #/pass-rates, #/changelog, #/contact, the embed generator, and /blog. A call-graph
// pass over app.js (2026-09-17) picked this set because nothing on a landing page, a track page, a
// quiz, an exam or the checkout can reach any of it, and none of the four delegated listener
// chains referenced it -- so the cut needed no surgery on the code every click on the site runs
// through, which is where the risk in splitting app.js lives.
//
// It is loaded by loadDeepBundle() in app.js: when one of these routes is visited, or at idle once
// a landing page is on screen and the fetch is free. A visitor who reads a landing page and leaves
// never downloads it.
//
// Same global scope as app.js (a plain classic script, no modules), so everything here can call
// app.js freely. The reverse is not true: app.js reaches into this file ONLY through DEEP_EXPORTS,
// which is what registerDeep() below fills in -- asserted in test/deep-bundle-split.test.js, since
// a direct call from app.js to something in here would be a ReferenceError before it loads.
async function renderTerms() {
  var pageTrack = activeTrackForPath(window.location.pathname);
  if (pageTrack) await loadTrackContent(pageTrack.examType);
  var compliance = pageTrack ? trackCompliance(pageTrack.examType) : { orgLine: HUB_FOOTER_ORG_LINE, termsParagraph2: HUB_TERMS_PARAGRAPH2 };
  appEl.innerHTML = '<div class="narrow-page"><h1>Terms of Use</h1>' +
    '<p class="muted">PassExamHQ provides original, independently-authored practice questions for exam preparation purposes only. ' +
    'It is not affiliated with, authorized by, sponsored by, or endorsed by ' + compliance.orgLine + ' ' +
    'or any other government agency. All official state trademarks, examination names, and statutory references are used purely ' +
    'for identification and descriptive purposes. ' +
    'Access codes are non-transferable and grant access to one exam track as specified at purchase. ' +
    'We make no guarantee of passing any official exam.</p>' +
    compliance.termsParagraph2 +
    '<p class="muted">Referral points have no cash value and cannot be redeemed, exchanged, or refunded for cash ' +
    'or any other payment method — they may only be applied toward a course through this site. Points may expire ' +
    'or be adjusted, and the referral program itself may be modified, suspended, or discontinued, at any time. ' +
    'We reserve the right to revoke points or access obtained through fraud, abuse, or violation of these terms.</p>' +
    '<p class="muted">Only one promotional discount or code may be applied per purchase — discounts cannot be ' +
    'combined or stacked with each other, though referral points may still be applied on top of a single active ' +
    'discount. Some promotions are restricted to first-time buyers and will be rejected at checkout for an email ' +
    'already associated with a prior purchase.</p>' +
    '<button class="btn-secondary btn-sm" data-act="go-back">← Back</button></div>';
}

// Rewritten 2026-09-17 (owner-approved wording, drafts/misc/privacy_page_draft_2026-09-17.md): the old page
// never mentioned Google Ads remarketing (Google requires disclosure), Microsoft Clarity, or the site_visits
// analytics. test/privacy-page.test.js fails if a new third-party script host or cookie isn't named here.
function renderPrivacy() {
  var ext = function (href, label) {
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  };
  appEl.innerHTML = '<div class="narrow-page"><h1>Privacy</h1>' +
    '<p class="muted">Last updated: September 17, 2026</p>' +

    '<h2>What we collect</h2>' +
    '<p class="muted"><strong>Your account and study progress.</strong> Your access code and its status, the tracks ' +
    'or topics you\'ve bought, your quiz, exam and study-resource progress, your settings (theme, font size, quiz ' +
    'options), and an exam date if you choose to add one.</p>' +
    '<p class="muted"><strong>Information you give us.</strong> Your email address, and anything else you type in, when you:</p>' +
    '<ul class="muted">' +
    '<li>buy a track (to send your receipt and access code)</li>' +
    '<li>enter your email at checkout, even if you don\'t finish buying (we may send you a reminder)</li>' +
    '<li>ask for a reminder, join a waitlist for your state, or verify a promo code</li>' +
    '<li>join the referral program, refer a friend, or send a gift (we use your friend\'s name and email only to ' +
    'send the invitation or gift and to credit referral points)</li>' +
    '<li>submit a refund claim, issue report, suggestion, or testimonial</li>' +
    '</ul>' +
    '<p class="muted"><strong>How you use the site.</strong> When you visit, we record a random visitor ID kept in ' +
    'your browser, the pages you view, how long you stay, how many times you click, the site or ad that sent you ' +
    '(including ad campaign details and Google\'s click ID), your IP address and the approximate location it ' +
    'indicates (country, region, city), and your device and browser type. To protect the site, we also log blocked ' +
    'attempts to reach content without access, including the IP address.</p>' +

    '<h2>Cookies and browser storage</h2>' +
    '<p class="muted">We set one cookie, <code>pxq_state</code>, which remembers your state (from your approximate ' +
    'location, or the state you pick) so we show the right exam content. It lasts one year. We also keep your ' +
    'settings, your visitor ID, and any referral or partner code in your browser\'s local storage. Google and ' +
    'Microsoft Clarity set their own cookies, described below.</p>' +

    '<h2>Services we use</h2>' +
    '<ul class="muted">' +
    '<li><strong>Stripe</strong> processes payments. We never see or store your card details.</li>' +
    '<li><strong>Cloudflare</strong> hosts the site, protects it from abuse (including the Turnstile check at ' +
    'checkout and on some forms), and provides basic traffic analytics.</li>' +
    '<li><strong>Resend</strong> delivers our emails.</li>' +
    '<li><strong>Google Ads</strong> tells us whether our ads lead to purchases, and may show our ads to people who ' +
    'have visited this site when they later use Google or its partner sites and apps (remarketing). Google uses ' +
    'cookies and similar technologies to do this. You can turn off personalized ads in ' +
    ext('https://myadcenter.google.com/', 'My Ad Center') + ', and read ' +
    ext('https://policies.google.com/technologies/partner-sites', 'how Google uses information from sites that use its services') + '.</li>' +
    '<li><strong>Microsoft Clarity</strong> records how visitors interact with pages (clicks, scrolling, mouse ' +
    'movement) so we can see what\'s confusing and improve the site. See the ' +
    ext('https://privacy.microsoft.com/privacystatement', 'Microsoft Privacy Statement') + '.</li>' +
    '</ul>' +

    '<h2>How we use it</h2>' +
    '<p class="muted">To give you access to what you bought, save your progress, send the emails described above ' +
    '(including study reminders and tips related to your purchase), understand and improve the site, measure our ' +
    'advertising, and prevent fraud and abuse.</p>' +

    '<h2>What we don\'t do</h2>' +
    '<p class="muted">We don\'t sell your personal information. We share it only with the services above, as needed ' +
    'to run the site and our advertising.</p>' +

    '<h2>Your choices</h2>' +
    '<p class="muted">You can block or clear cookies in your browser, turn off personalized ads through Google, or ' +
    '<a href="#/contact">contact us</a> to see or delete the information we hold about you, or to stop non-essential emails.</p>' +

    '<button class="btn-secondary btn-sm" data-act="go-back">← Back</button></div>';
}

function renderAbout() {
  appEl.innerHTML = '<div class="narrow-page"><h1>About PassExamHQ</h1>' +
    '<p class="muted">PassExamHQ builds independent practice question banks for state and national licensing ' +
    'exams — driver\'s license and CDL knowledge tests, motorcycle endorsements, notary public exams, real ' +
    'estate licensing, boating safety, and more — each one built directly from the current official handbook ' +
    'or manual for that specific state and track, not a generic national bank reused everywhere.</p>' +
    '<p class="muted">Every track is a single one-time purchase, not a subscription: pay once, keep access. ' +
    'That access includes the full question bank for unlimited practice, timed mock exams that mirror the ' +
    'real format, voice-enabled answering and read-aloud, and per-topic progress tracking so you know what to ' +
    'actually restudy before test day — not just an overall score.</p>' +
    '<p class="muted">We back every track with a pass-or-money-back guarantee (see the full ' +
    '<a href="#/guarantee">guarantee terms</a>), and our results page shows real, unedited numbers pulled ' +
    'straight from our own database, not invented marketing figures.</p>' +
    '<p class="muted">PassExamHQ is an independent study tool. We are not affiliated with, authorized by, ' +
    'sponsored by, or endorsed by any state department of motor vehicles, state licensing agency, or official ' +
    'examination vendor, and completing our practice questions or mock exams does not register you for, or ' +
    'substitute for, any official state or federal exam.</p>' +
    '<button class="btn-secondary btn-sm" data-act="go-back">← Back</button></div>';
}

// Grouped Q&A, one <details> per item (native disclosure -- no JS needed for expand/collapse,
// accessible by default). Deliberately more thorough than the help-chat widget's 16-entry FAQ
// (HELP_CHAT_FAQ, near the top of this file) -- this is the "read the whole thing" version,
// that one's the "quick lookup while you're mid-task" version. Keep both, don't try to unify
// them into one dataset -- the chat widget's entries are terse on purpose (chat bubble width),
// this page's are meant to be read start to finish.
var FAQ_CATEGORIES = [
  {
    category: 'Getting Started',
    items: [
      { q: 'What is PassExamHQ?', a: function () {
        return 'Independent practice question banks for state and national licensing exams, built directly from official ' +
          'handbooks for each specific state and track. See the full <a href="#/about">About page</a>.';
      } },
      { q: 'Which states and exams do you cover?', a: function () {
        return '<a href="' + tracksHomeHref() + '">Browse all tracks</a> to see what\'s currently live for your state.';
      } },
      { q: 'Can I try questions before buying?', a: function () {
        return 'Yes — every track has free sample questions, no account needed. Open any track from the ' +
          '<a href="' + tracksHomeHref() + '">tracks page</a> to try one.';
      } },
      { q: 'Do I need to create an account?', a: function () {
        return 'No separate signup. Your access code (emailed after purchase or redemption) is your entire login — see ' +
          '"How do I redeem my code?" below.';
      } },
    ],
  },
  {
    category: 'Buying & Pricing',
    items: [
      { q: 'How much does a track cost, and is it a subscription?', a: function () {
        return 'Each track is a single one-time payment, not a subscription — pay once and keep access for good. ' +
          'Prices vary by track; <a href="' + tracksHomeHref() + '">browse tracks</a> to see the current price for yours.';
      } },
      { q: 'What payment methods do you accept?', a: function () {
        return 'Card, Apple Pay, or Google Pay — checkout runs through Stripe, and whichever wallet your device supports shows up automatically.';
      } },
      { q: 'Do you offer discounts or promo codes?', a: function () {
        return 'When a discount is active it shows right on the buy page. Some discounts need a code (enter it in the ' +
          'promo field and click Apply); others auto-apply for a qualifying email domain (e.g. a student discount for a .edu address) with no code needed.';
      } },
      { q: 'Can I buy a track as a gift?', a: function () {
        return 'Yes — <a href="#/gift">gift a track</a>. You can enter the recipient\'s email and we\'ll send their code directly, ' +
          'or leave it blank and get a shareable code to send yourself.';
      } },
    ],
  },
  {
    category: 'Your Access Code',
    items: [
      { q: 'How do I redeem my code?', a: function () {
        return 'Go to <a href="#/redeem">Redeem code</a> and enter it exactly as emailed. That logs you in on this device — ' +
          'no password to create or remember.';
      } },
      { q: 'Do I need a password?', a: function () {
        return 'No. Your code is the entire login mechanism, by design — one thing to keep track of, not a code and a password.';
      } },
      { q: 'Can I use my code on more than one device?', a: function () {
        return 'Yes — re-enter the same code on another device\'s <a href="#/redeem">Redeem code</a> page and it logs that device into the same account.';
      } },
      { q: "I lost my code, or never received the email — what now?", a: function () {
        return '<a href="#/contact">Contact us</a> with the email you purchased or were gifted with, and we\'ll help track it down.';
      } },
    ],
  },
  {
    category: 'Studying & Practice',
    items: [
      { q: "What's included once I unlock a track?", a: function () {
        return 'The full question bank for unlimited practice, a timed mock exam plus a "Weak Spots" drill of the hardest ' +
          'questions, voice-enabled answering and read-aloud, a study resource library, and per-topic progress tracking.';
      } },
      { q: 'Can questions be read aloud to me?', a: function () {
        return 'Yes — voice-enabled practice can read each question aloud, and you can answer by voice too, right from the practice quiz.';
      } },
      { q: 'Can I practice by difficulty level?', a: function () {
        return 'Yes — the practice quiz has an Easy / Moderate / Hard / Extremely Hard filter, plus "All," so you can drill weak spots specifically.';
      } },
      { q: 'How many questions are on my exam, and how long is it?', a: function () {
        return 'This varies a lot by track — open your specific track\'s page (from the <a href="' + tracksHomeHref() + '">tracks list</a>) ' +
          'for its exact question count, time limit, and passing score.';
      } },
    ],
  },
  {
    category: 'Progress Tracking',
    items: [
      { q: 'How do I know if I\'m ready for the real exam?', a: function () {
        return 'Once you\'re logged in, the Progress tab shows Accuracy (how often you\'re getting questions right) and Coverage ' +
          '(how much of the bank you\'ve actually practiced) broken down per topic — so you know exactly what to restudy, not just an overall score.';
      } },
    ],
  },
  {
    category: 'Guarantee & Refunds',
    items: [
      { q: "What if I take the real exam and don't pass?", a: function () {
        return 'We refund <span class="js-refund-pct">' + refundFailurePercent + '</span>% of your purchase, as long as you maintained at least ' +
          '<span class="js-accuracy-pct">' + progressAccuracyPassPct + '</span>% Accuracy and <span class="js-coverage-pct">' + progressCoveragePassPct +
          '</span>% Coverage on the Progress tab. Full details on the <a href="#/guarantee">guarantee page</a>.';
      } },
      { q: 'Can I get a refund if I just change my mind?', a: function () {
        return 'Yes — a 7-day, no-questions-asked refund covers that separately from the pass-guarantee above.';
      } },
      { q: 'How do I request a refund?', a: function () { return 'Start a <a href="#/refund">refund request</a> here.'; } },
    ],
  },
  {
    category: 'Referrals, Points & Gifts',
    items: [
      { q: 'How does referring friends work?', a: function () {
        return 'Refer friends and earn points toward free access — find your track\'s "Refer & earn" link from its ' +
          '<a href="' + tracksHomeHref() + '">track page</a>.';
      } },
      { q: 'How do I check my referral points?', a: function () {
        return 'On the buy page, click "Check my points" — you can apply them toward that purchase\'s total right there.';
      } },
    ],
  },
  {
    category: 'Account & Legal',
    items: [
      { q: 'What data do you store about me?', a: function () { return 'See exactly what and why on our <a href="#/privacy">privacy page</a>.'; } },
      { q: 'Where are your terms of service?', a: function () { return '<a href="#/terms">Terms of service</a>.'; } },
      { q: "My question isn't answered here", a: function () { return '<a href="#/contact">Contact us</a> and we\'ll reply to your email.'; } },
    ],
  },
];

function refreshFaqDynamicSpans() {
  loadSiteConfig().then(function () {
    document.querySelectorAll('.js-refund-pct').forEach(function (el) { el.textContent = refundFailurePercent; });
    document.querySelectorAll('.js-accuracy-pct').forEach(function (el) { el.textContent = progressAccuracyPassPct; });
    document.querySelectorAll('.js-coverage-pct').forEach(function (el) { el.textContent = progressCoveragePassPct; });
  });
}

function renderFaq() {
  appEl.innerHTML = '<div class="narrow-page"><h1>Frequently Asked Questions</h1>' +
    '<p class="muted">Quick answers on buying, your access code, studying, and the guarantee. Still stuck? ' +
    '<a href="#/contact">Contact us</a> or use the chat bubble in the corner.</p>' +
    FAQ_CATEGORIES.map(function (cat) {
      return '<section class="faq-category"><h2>' + escapeHtml(cat.category) + '</h2>' +
        cat.items.map(function (item) {
          return '<details class="faq-item"><summary>' + escapeHtml(item.q) + '</summary>' +
            '<div class="faq-answer muted">' + item.a() + '</div></details>';
        }).join('') + '</section>';
    }).join('') +
    '<button class="btn-secondary btn-sm" data-act="go-back">← Back</button></div>';
  refreshFaqDynamicSpans();
  // FAQPage JSON-LD -- real content, the exact same Q&A already on the page, just structured for
  // Google's rich-snippet eligibility. Answer text is stripped to plain text (schema.org's own
  // recommendation) since item.a() can return HTML (links, etc).
  var faqEntities = [];
  FAQ_CATEGORIES.forEach(function (cat) {
    cat.items.forEach(function (item) {
      faqEntities.push({
        '@type': 'Question', name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: stripHtml(item.a()) },
      });
    });
  });
  injectJsonLd('faq-jsonld', { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqEntities });
}

// /api/blog returns published_at as an ISO-8601 string ('2026-09-08T04:13:41.488Z'). Three places
// here multiplied it by 1000 as if it were Unix seconds, which is NaN for a string -- and
// new Date(NaN).toISOString() THROWS, so renderBlogPost's catch reported every one of the 621
// published posts as "this article doesn't exist". Accepts either shape now: a number is seconds
// (or milliseconds when it is large enough to be one), a string is parsed as a date, and anything
// unreadable returns null so the caller leaves the date out instead of printing 'Invalid Date'.
function blogDate(value) {
  if (value === null || value === undefined || value === '') return null;
  var date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

// Educational blog/guide content (/blog, /blog/{slug} -- real pathname routes, not hash routes,
// so _worker.js can inject per-post SEO meta and sitemap.xml can list them; see route()'s own
// comment on why). Admin-authored via the DB-backed blog_posts table (see the API's schema.sql
// comment), not hardcoded here, so publishing needs no code deploy. kind is a category slug
// (matches HUB_KIND_SLUGS values / category_content.slug) so each post can link back to its
// category page via kindFromSlug().
// blogPostHref/blogListHref carry the active category AND state filter across a real page
// navigation (this site uses real <a href> page loads for /blog, not client-side pushState
// routing -- see the route() comment below) via ?from=<kind>&fromState=<state> query params on
// the post URL, so clicking "← Blog" from a post can return to the same filtered list instead of
// always resetting to "All". The two filters are INDEPENDENT -- a state can be selected with no
// category active (narrows to that state's posts across every category), so stateCode is never
// gated behind kind being truthy.
// A THIRD-ARGUMENT DISTINCTION matters here: omitting stateCode entirely (undefined) produces a
// bare URL that lets renderBlogList fall back to the visitor's own cookie-derived state (see the
// pxq_state default in renderBlogList below) -- this is what category-tab links do, so switching
// category always re-defaults rather than carrying a stale explicit state forward. Passing
// stateCode as an empty string (what the state <select>'s "All states" option does) instead
// writes a literal state= (present but empty) -- an explicit "no, really, all states" that
// intentionally overrides the cookie default rather than triggering it.
function blogListHref(kind, stateCode) {
  var params = [];
  if (kind) params.push('kind=' + encodeURIComponent(kind));
  if (stateCode !== undefined) params.push('state=' + encodeURIComponent(stateCode));
  return '/blog' + (params.length ? '?' + params.join('&') : '');
}

function blogListItemsHtml(posts, activeKind, activeState) {
  return posts.length
    ? '<div class="blog-list">' + posts.map(function (p) {
        var kindLabel = kindFromSlug(p.kind) || p.kind;
        var href = blogPostHref(p.slug, activeKind, activeState);
        return '<article class="blog-list-item card' + (p.featured ? ' blog-list-item-featured' : '') + '">' +
          (p.featured ? '<span class="badge blog-list-item-featured-badge">🎯 Practice Test Guide</span>' : '') +
          '<span class="badge blog-list-item-badge">' + escapeHtml(kindLabel) + '</span>' +
          (INTL_STUDENTS_ARTICLE_SLUGS[p.kind] === p.slug ? internationalBadgeHtml() : '') +
          '<h2><a href="' + href + '">' + escapeHtml(p.title) + '</a></h2>' +
          '<p class="muted blog-list-meta">' + (p.state_code ? escapeHtml(p.state_code) + ' · ' : '') +
          (blogDate(p.published_at) ? blogDate(p.published_at).toLocaleDateString() : '') + '</p>' +
          '<p class="blog-list-excerpt">' + escapeHtml(p.excerpt) + '</p>' +
          '<a class="blog-read-more" href="' + href + '">Read more →</a>' +
          '</article>';
      }).join('') + '</div>'
    : '<p class="muted">No articles in this category yet — check back soon.</p>';
}

// Category slugs actually present in the fetched posts, in HUB_KIND_SLUGS' declared order (not
// alphabetical/appearance order) so the tab bar always reads in the same category order the rest
// of the site uses -- only categories with at least one published post get a tab, so an empty
// category never shows a dead-end filter. Real <a href="/blog?kind=..."> links, not JS-only
// buttons, since a full page load is how this site navigates -- the ?kind= param is read back out
// by renderBlogList() below so a reload/bookmark/back-button lands on the same filtered view.
function blogCategoryTabsHtml(posts, activeKind) {
  var counts = {};
  posts.forEach(function (p) { counts[p.kind] = (counts[p.kind] || 0) + 1; });
  var slugs = [];
  for (var label in HUB_KIND_SLUGS) { if (counts[HUB_KIND_SLUGS[label]]) slugs.push(HUB_KIND_SLUGS[label]); }
  if (slugs.length < 2) return ''; // nothing to filter if every post is the same (or only) category
  return '<div class="blog-category-tabs" role="tablist">' +
    '<a class="' + (activeKind ? '' : 'active') + '" href="' + blogListHref('') + '">All (' + posts.length + ')</a>' +
    slugs.map(function (slug) {
      return '<a class="' + (slug === activeKind ? 'active' : '') + '" href="' + blogListHref(slug) + '">' + escapeHtml(kindFromSlug(slug) || slug) + ' (' + counts[slug] + ')</a>';
    }).join('') +
    '</div>';
}

// State filter, available whenever there's at least one state-specific post in the current view
// -- independent of whether a category is also selected (postsForKind IS just "posts" already
// when no category is active, see renderBlogList), since a visitor comparing everything they're
// studying for in their own state is just as real a use case as narrowing one category. With up
// to 50 state posts eventually landing in one category alone (see the long-tail SEO rollout),
// category tabs alone were never going to be enough to find one specific state's article anyway.
// A <select> rather than tabs, unlike blogCategoryTabsHtml above, because 50 states as individual
// tabs would be unwieldy where 8 categories are not. Switching category (a tab click) always
// resets this filter to "All states" -- blogListHref only ever attaches ?state= when explicitly
// passed a stateCode, so a bare category link can't carry a stale state selection forward. Real
// posts with no state_code (general educational guides, not the long-tail per-track articles) are
// ALWAYS shown regardless of which state is selected -- a state filter narrows state-SPECIFIC
// content, it isn't a hard partition that should hide universally-relevant articles nobody asked
// to hide (see renderBlogList's matching "!p.state_code ||" shown-filter). Each state option's
// displayed count reflects that too (state-specific count plus the general count), so what's shown
// always matches what the dropdown promised.
// isDefaulted (see renderBlogList) means this state wasn't asked for via the URL at all -- it's the
// visitor's own pxq_state cookie applied automatically. Surfaced as a visible note ABOVE the select
// (not just the select's pre-chosen value) specifically so this never reads as "the blog is
// missing posts" -- a silent filter a visitor didn't ask for has to be obvious, not just technically
// discoverable in a dropdown.
function blogStateFilterHtml(postsForKind, activeKind, activeState, isDefaulted) {
  var counts = {}, generalCount = 0;
  postsForKind.forEach(function (p) { if (p.state_code) counts[p.state_code] = (counts[p.state_code] || 0) + 1; else generalCount++; });
  var codes = Object.keys(counts).sort(function (a, b) { return (STATE_LABELS[a] || a).localeCompare(STATE_LABELS[b] || b); });
  if (!codes.length) return ''; // no state-specific posts in this category yet -- nothing to filter
  var options = ['<option value="">All states (' + postsForKind.length + ')</option>'].concat(
    codes.map(function (code) {
      return '<option value="' + code + '"' + (code === activeState ? ' selected' : '') + '>' + escapeHtml(STATE_LABELS[code] || code) + ' (' + (counts[code] + generalCount) + ')</option>';
    })
  );
  var defaultedNote = (isDefaulted && activeState)
    ? '<p class="muted blog-state-defaulted-note">📍 Showing ' + escapeHtml(STATE_LABELS[activeState] || activeState) +
      ' (based on your saved state) — <a href="' + blogListHref(activeKind, '') + '">view all states</a></p>'
    : '';
  return defaultedNote +
    '<select class="blog-state-filter" data-act="change-blog-state-filter" data-kind="' + escapeHtml(activeKind) + '" aria-label="Filter by state">' + options.join('') + '</select>';
}

function drawBlogList() {
  var posts = blogListState.posts, postsForKind = blogListState.postsForKind, shown = blogListState.shown;
  var activeKind = blogListState.activeKind, activeState = blogListState.activeState;
  var visibleCount = blogListState.visibleCount;
  var remaining = shown.length - visibleCount;
  appEl.innerHTML = '<div class="blog-page"><h1>Guides &amp; Tips</h1>' +
    '<p class="muted">Guides and tips for passing your licensing exam.</p>' +
    blogCategoryTabsHtml(posts, activeKind) +
    blogStateFilterHtml(postsForKind, activeKind, activeState, blogListState.isDefaulted) +
    blogListItemsHtml(shown.slice(0, visibleCount), activeKind, activeState) +
    (remaining > 0
      ? '<div class="blog-load-more-wrap"><button class="btn-secondary" data-act="blog-load-more">Load more (' + remaining + ' remaining)</button></div>'
      : '') +
    '<button class="btn-secondary btn-sm blog-back-btn" data-act="go-back">← Back</button></div>';
}

function renderBlogList() {
  var params = new URLSearchParams(location.search);
  var activeKind = params.get('kind') || '';
  // null means "no ?state= at all" (an ordinary category-tab link or first visit) -- only THAT
  // case falls back to the visitor's own saved state below. An explicit '' (from choosing "All
  // states" in the filter itself) is a real, deliberate override and must stick, not be silently
  // replaced by the cookie again. Read regardless of activeKind now -- state and category are
  // independent filters (see blogListHref's own comment).
  var stateParam = params.get('state');
  appEl.innerHTML = '<div class="blog-page"><h1>Guides &amp; Tips</h1>' +
    '<p class="muted">Guides and tips for passing your licensing exam.</p>' + loadingSkeletonHtml(8) + '</div>';
  apiFetch('/blog').then(function (res) {
    var posts = (res && res.posts) || [];
    var postsForKind = activeKind ? posts.filter(function (p) { return p.kind === activeKind; }) : posts;
    var isDefaulted = false;
    var activeState = stateParam;
    if (activeState === null) {
      var cookieState = getStateCookie();
      var cookieStateHasPosts = cookieState && postsForKind.some(function (p) { return p.state_code === cookieState; });
      activeState = cookieStateHasPosts ? cookieState : '';
      isDefaulted = !!cookieStateHasPosts;
    }
    // General posts (no state_code) always stay visible -- a state filter narrows state-specific
    // content, it shouldn't also hide articles that apply to every visitor regardless of state.
    var shown = activeState ? postsForKind.filter(function (p) { return !p.state_code || p.state_code === activeState; }) : postsForKind;
    blogListState = { posts: posts, postsForKind: postsForKind, shown: shown, activeKind: activeKind, activeState: activeState, isDefaulted: isDefaulted, visibleCount: Math.min(BLOG_PAGE_SIZE, shown.length) };
    drawBlogList();
  }).catch(function () {
    appEl.innerHTML = '<div class="blog-page"><h1>Guides &amp; Tips</h1><p class="muted">Couldn\'t load articles right now.</p></div>';
  });
}

function renderBlogPost(slug) {
  var postParams = new URLSearchParams(location.search);
  var fromKind = postParams.get('from') || '';
  var fromState = postParams.get('fromState') || ''; // independent of fromKind -- see blogListHref's comment
  appEl.innerHTML = '<div class="narrow-page">' + loadingSkeletonHtml(6) + '</div>';
  Promise.all([apiFetch('/blog/' + encodeURIComponent(slug)), apiFetch('/blog').catch(function () { return { posts: [] }; })]).then(function (results) {
    var post = results[0] && results[0].post;
    if (!post) { appEl.innerHTML = '<div class="narrow-page"><h1>Not found</h1><p class="muted">This article doesn\'t exist or isn\'t published.</p><a href="' + blogListHref(fromKind, fromState) + '">← Back to Guides &amp; Tips</a></div>'; return; }
    var kindLabel = kindFromSlug(post.kind) || post.kind;
    var categoryHref = '/' + post.kind;
    // Prev/next -- the list is already published_at DESC (newest first), so "next" (older) is the
    // following array entry and "previous" (newer) is the preceding one. Falls back to nothing if
    // this is the only post, or the oldest/newest of the set.
    var allPosts = results[1].posts || [];
    var myIndex = allPosts.findIndex(function (p) { return p.slug === slug; });
    var prevPost = myIndex > 0 ? allPosts[myIndex - 1] : null;
    var nextPost = myIndex !== -1 && myIndex < allPosts.length - 1 ? allPosts[myIndex + 1] : null;
    var prevNextHtml = (prevPost || nextPost)
      ? '<div class="blog-post-prevnext">' +
        (prevPost
          ? '<a class="blog-post-prevnext-link" href="' + blogPostHref(prevPost.slug, fromKind, fromState) + '"><span class="muted blog-post-prevnext-label">← Previous</span><span class="blog-post-prevnext-title">' + escapeHtml(prevPost.title) + '</span></a>'
          : '<span></span>') +
        (nextPost
          ? '<a class="blog-post-prevnext-link blog-post-prevnext-next" href="' + blogPostHref(nextPost.slug, fromKind, fromState) + '"><span class="muted blog-post-prevnext-label">Next →</span><span class="blog-post-prevnext-title">' + escapeHtml(nextPost.title) + '</span></a>'
          : '<span></span>') +
        '</div>'
      : '';
    // ~200 wpm is the commonly-cited average adult silent reading speed -- a rough estimate label,
    // not a precise claim, same spirit as this project's other honestly-hedged display numbers.
    var readMins = Math.max(1, Math.round(stripHtml(post.body_html).split(/\s+/).length / 200));
    appEl.innerHTML = '<div class="narrow-page blog-post' + (post.featured ? ' blog-post-featured' : '') + '">' +
      '<p class="muted blog-post-back"><a href="' + blogListHref(fromKind, fromState) + '">← Guides &amp; Tips</a></p>' +
      (post.featured ? '<div class="blog-post-featured-banner">🎯 Practice Test Guide — everything you need for this exam, in one place</div>' : '') +
      '<span class="badge blog-post-badge">' + escapeHtml(kindLabel) + '</span>' +
      (INTL_STUDENTS_ARTICLE_SLUGS[post.kind] === post.slug ? internationalBadgeHtml() : '') +
      '<h1>' + escapeHtml(post.title) + '</h1>' +
      '<p class="muted blog-post-meta">' + (post.state_code ? escapeHtml(post.state_code) + ' · ' : '') +
      (blogDate(post.published_at) ? blogDate(post.published_at).toLocaleDateString() + ' · ' : '') + readMins + ' min read</p>' +
      '<div class="blog-post-body">' + post.body_html + '</div>' +
      '<div class="blog-post-cta-box">' +
      '<p>Ready to put this into practice?</p>' +
      '<a class="btn-primary" href="' + categoryHref + '">Practice ' + escapeHtml(kindLabel) + ' questions →</a>' +
      '</div>' +
      prevNextHtml +
      '</div>';
    injectJsonLd('blog-post-jsonld', {
      '@context': 'https://schema.org', '@type': 'Article',
      headline: post.title, description: post.seo_description || post.excerpt,
      datePublished: blogDate(post.published_at) ? blogDate(post.published_at).toISOString() : undefined,
    });
  }).catch(function (err) {
    // Deliberately NOT the not-found copy. This branch is a failed request or a render exception,
    // and reporting that as "this article doesn't exist" is exactly what hid the published_at crash
    // (see blogDate) for as long as it lasted: every post page looked like missing content rather
    // than a bug, on a page nobody would think to check.
    console.error('blog post render failed', err);
    appEl.innerHTML = '<div class="narrow-page"><h1>Could not load this article</h1>' +
      '<p class="muted">Something went wrong loading it — please try again shortly.</p>' +
      '<a href="/blog">← Back to Guides &amp; Tips</a></div>';
  });
}

function renderContact() {
  appEl.innerHTML =
    '<div class="narrow-page">' +
    '<h1>Contact Us</h1>' +
    '<p class="muted">Questions about your account, a purchase, or anything else — send us a note and we\'ll reply to your email.</p>' +
    '<form data-act="contact-submit" class="card">' +
    '<label class="muted buy-email-label">Your name (optional)</label>' +
    '<input type="text" name="name" placeholder="Jane Doe">' +
    '<label class="muted buy-email-label refund-field-spacing">Your email</label>' +
    '<input type="email" name="email" placeholder="you@example.com" required>' +
    '<label class="muted buy-email-label refund-field-spacing">Message</label>' +
    '<textarea name="message" rows="5" placeholder="How can we help?" required></textarea>' +
    '<div id="turnstile-container"></div>' +
    '<button class="btn-primary" type="submit">Send message</button>' +
    '</form>' +
    '</div>';
  renderTurnstileWidget();
}

// Rebuilt as a full landing page (ported from v0's guarantee/page.tsx: hero+stat card, eligibility
// steps, FAQ) rather than the single compact card this used to be. v0's copy has specific numbers
// (a fabricated "94% pass their first attempt" stat, an "85% on two timed exams" eligibility bar,
// 60-day/14-day deadlines) that don't match this site's real policy -- ported the STRUCTURE only;
// every number here is real (refundFailurePercent, accuracy/coverage thresholds, and the real
// /stats/public pass rate, correctly framed as practice-exam performance, not a claim about real
// official exam outcomes we have no way to measure).
function renderGuarantee() {
  appEl.innerHTML = '<div class="narrow-page"><h1>Our Guarantee</h1>' + loadingSkeletonHtml(6) + '</div>';
  Promise.all([loadSiteConfig(), apiFetch('/stats/public').catch(function () { return null; })]).then(function (results) {
    var stats = results[1];
    var passRateNote = (stats && stats.passRate != null)
      ? '<div class="guarantee-stat-divider"></div><p class="guarantee-stat-label">Backed by real practice data</p>' +
        '<p class="muted guarantee-stat-note">' + stats.passRate + '% of practice mock exams taken on PassExamHQ end in a passing score. ' +
        '<a href="#/pass-rates">See the real numbers, by category →</a></p>'
      : '';

    appEl.innerHTML =
      '<div class="guarantee-page">' +
      '<section class="guarantee-hero">' +
      '<div class="guarantee-hero-copy">' +
      '<span class="badge guarantee-hero-badge">🛡️ Two guarantees, in plain language</span>' +
      '<h1>Pass, or get ' + refundFailurePercent + '% back.</h1>' +
      '<p class="page-intro-text">We only sell prep we\'d stake our reputation on. Practice to the threshold, sit your ' +
      'official exam, and if you still don\'t pass, you get ' + refundFailurePercent + '% of your purchase back. Changed ' +
      'your mind early instead? A 7-day, no-questions-asked refund covers that too.</p>' +
      '<div class="guarantee-hero-cta">' +
      '<a class="btn-primary hub-hero-btn" href="/#tracks">Browse guaranteed tracks</a>' +
      '<a class="btn-secondary hub-hero-btn" href="#/refund">I need to file a claim</a>' +
      '</div>' +
      '</div>' +
      // Two stat cards, not one -- this page's whole job is explaining "the guarantee(s)," but its
      // own hero used to badge itself singular ("Pass Guarantee") and fold the 7-day refund into
      // one sentence, undersold relative to how guaranteeCtaBandHtml() frames both guarantees with
      // equal weight everywhere else on the site. Give the 7-day guarantee its own card here too.
      '<div class="guarantee-hero-stats">' +
      '<div class="guarantee-stat-card">' +
      '<div class="guarantee-stat-icon">🛡️</div>' +
      '<div class="guarantee-stat-value">' + refundFailurePercent + '%</div>' +
      '<p class="muted">money back if you meet the practice requirement and still don\'t pass</p>' +
      passRateNote +
      '</div>' +
      '<div class="guarantee-stat-card">' +
      '<div class="guarantee-stat-icon">📅</div>' +
      '<div class="guarantee-stat-value">7 Days</div>' +
      '<p class="muted">no-questions-asked refund if you change your mind early — no conditions to meet</p>' +
      '</div>' +
      '</div>' +
      '</section>' +
      '<section class="guarantee-eligibility">' +
      '<h2>How to qualify</h2>' +
      '<p class="muted page-intro-text">Three simple conditions — they exist so the guarantee protects people who actually did the work.</p>' +
      '<div class="guarantee-steps">' +
      guaranteeStepHtml(1, '📊', 'Practice to the threshold',
        'Maintain at least ' + progressAccuracyPassPct + '% Accuracy and ' + progressCoveragePassPct +
        '% Coverage in your practice here — a good-faith-effort requirement, not a formality.') +
      guaranteeStepHtml(2, '🎓', 'Take your official exam',
        'Sit the real exam through the official testing authority for your track.') +
      guaranteeStepHtml(3, '📝', 'Submit your claim',
        'File a refund request with your result — real-money purchases only, since a free or points-redeemed course has no purchase to refund.') +
      '</div>' +
      '</section>' +
      '<section class="guarantee-faq">' +
      '<h2>Refund questions</h2>' +
      '<dl class="guarantee-faq-list">' +
      guaranteeFaqHtml('What exactly do I get back?',
        refundFailurePercent + '% of what you paid for the track (or a full refund under the separate 7-day guarantee). ' +
        'Free or points-redeemed courses aren\'t eligible, since no cash was paid.') +
      guaranteeFaqHtml('How is a refund paid out?',
        'Once your claim is reviewed and approved, it\'s issued back to your original payment method through Stripe.') +
      guaranteeFaqHtml('What if I used a promo code or points?',
        'Any points or promo discount applied at checkout only reduces what you paid — the guarantee still covers whatever cash amount you actually paid.') +
      guaranteeFaqHtml('Which tracks are covered?',
        'Every active licensing-exam track (Notary, Real Estate, Driver, CDL, Motorcycle, Boating, and every other pass/fail state or professional exam) gets both guarantees — ' +
        'the ' + refundFailurePercent + '% pass-or-refund guarantee and the 7-day return window. Our scored, composite national exams (ACT, DAT, CLT, OAT) have no pass/fail ' +
        'threshold to fail, so there\'s no "fail the real exam" claim for those — they\'re still covered by the 7-day return window, just not the pass-or-refund half.') +
      '</dl>' +
      '</section>' +
      '</div>';
  });
}

function guaranteeStepHtml(num, icon, title, body) {
  return '<div class="guarantee-step-card">' +
    '<span class="guarantee-step-num">' + num + '</span>' +
    '<div class="guarantee-step-icon">' + icon + '</div>' +
    '<h3>' + title + '</h3>' +
    '<p class="muted">' + body + '</p>' +
    '</div>';
}

function guaranteeFaqHtml(q, a) {
  return '<div class="guarantee-faq-item"><dt>' + q + '</dt><dd class="muted">' + a + '</dd></div>';
}

function embedActiveKinds() {
  var kinds = [];
  HUB_EXAMS.forEach(function (e) { if (e.active && kinds.indexOf(e.examKind) === -1) kinds.push(e.examKind); });
  return kinds.sort(function (a, b) { return a.localeCompare(b); });
}

function embedPickerHtml() {
  var kindOptions = ['<option value="">Choose a category…</option>'].concat(
    embedActiveKinds().map(function (k) {
      return '<option value="' + escapeHtml(k) + '"' + (k === embedPickedKind ? ' selected' : '') + '>' + escapeHtml(k) + '</option>';
    })
  );
  var stateTracks = embedPickedKind ? categoryActiveTracks(embedPickedKind) : [];
  var stateOptions = ['<option value="">Choose a state…</option>'].concat(
    stateTracks.slice().sort(function (a, b) { return (STATE_LABELS[a.stateCode] || a.stateCode).localeCompare(STATE_LABELS[b.stateCode] || b.stateCode); })
      .map(function (t) {
        return '<option value="' + t.stateCode + '"' + (t.stateCode === embedPickedState ? ' selected' : '') + '>' +
          escapeHtml(STATE_LABELS[t.stateCode] || t.stateCode) + '</option>';
      })
  );
  return '<div class="card embed-picker">' +
    '<label class="gift-picker-field">Category' +
    '<select data-act="pick-embed-kind">' + kindOptions.join('') + '</select>' +
    '</label>' +
    '<label class="gift-picker-field">State' +
    '<select data-act="pick-embed-state"' + (embedPickedKind ? '' : ' disabled') + '>' + stateOptions.join('') + '</select>' +
    '</label>' +
    '</div>';
}

function embedResultHtml() {
  if (!embedPickedKind || !embedPickedState) return '';
  var track = categoryActiveTracks(embedPickedKind).filter(function (t) { return t.stateCode === embedPickedState; })[0];
  if (!track) return '';
  var src = location.origin + '/embed/qotd?examType=' + encodeURIComponent(track.examType);
  var snippet = '<iframe src="' + src + '" width="380" height="420" style="border:1px solid #ddd;border-radius:12px;max-width:100%;" loading="lazy" title="PassExamHQ Question of the Day"></iframe>';
  return '<div class="embed-result">' +
    '<h3>Your embed code</h3>' +
    '<textarea class="embed-snippet-box" readonly rows="3">' + escapeHtml(snippet) + '</textarea>' +
    '<button class="btn-secondary btn-sm" type="button" data-act="copy-embed-snippet" data-snippet="' + escapeHtml(snippet) + '">Copy snippet</button>' +
    '<h3>Live preview</h3>' +
    '<div class="embed-preview-frame">' + snippet + '</div>' +
    '</div>';
}

function renderEmbedGenerator() {
  embedPickedKind = '';
  embedPickedState = '';
  appEl.innerHTML = '<div class="narrow-page embed-generator-page"><h1>Embed a Question of the Day</h1>' +
    '<p class="muted page-intro-text">Add a real, rotating practice question to your site — a state subreddit, ' +
    'a forum, an agent blog — with a link back to the full question bank. A new question from the real pool ' +
    'shows automatically every day; no upkeep on your end.</p>' +
    '<div id="embed-picker-wrap">' + embedPickerHtml() + '</div>' +
    '<div id="embed-result-wrap">' + embedResultHtml() + '</div>' +
    '</div>';
}

// Public pass-rate transparency page (#/pass-rates) -- built 2026-09-02 as a marketing-ideas
// follow-on to renderGuarantee()'s own passRateNote, which only ever showed one sitewide number.
// Every figure here comes straight from /stats/public and /stats/pass-rates-by-category (real
// completed exam_attempts rows, scored against each attempt's own snapshotted pass_percent), same
// as the guarantee page -- nothing here is invented or hardcoded, per this site's standing
// no-fabricated-numbers rule. The one deliberate design choice: a category with fewer than
// minSampleSize completed attempts shows "Not enough data yet" instead of a percentage -- a
// sample-size gate only, never a value gate, so a real (if unflattering) rate is never hidden once
// there's enough data to trust it.
//
// Second section (2026-09-10) adds /stats/quiz-accuracy-by-category alongside it -- students who
// only ever use quiz mode and never submit a full scored exam were invisible to the page above.
// Deliberately kept as its own separate table, not blended into the pass-rate numbers: quiz
// accuracy and exam pass rate aren't the same kind of measurement, so merging them would read as
// more directly comparable than they actually are. Same suppression rule/threshold, but the UI
// copy never states the number, matching the pass-rate table's own existing copy.
function renderPassRates() {
  appEl.innerHTML = '<div class="narrow-page"><h1>Pass Rate Transparency</h1>' + loadingSkeletonHtml(6) + '</div>';
  Promise.all([
    apiFetch('/stats/public').catch(function () { return null; }),
    apiFetch('/stats/pass-rates-by-category').catch(function () { return null; }),
    apiFetch('/stats/quiz-accuracy-by-category').catch(function () { return null; }),
  ]).then(function (results) {
    var overall = results[0];
    var byCategory = results[1];
    var byQuiz = results[2];
    var minSample = (byCategory && byCategory.minSampleSize) || 20;
    var quizMinSample = (byQuiz && byQuiz.minSampleSize) || 20;

    var overallHtml = (overall && overall.passRate != null)
      ? '<div class="pass-rates-overall-card">' +
        '<div class="pass-rates-overall-value">' + overall.passRate + '%</div>' +
        '<p class="muted">of the ' + overall.examsCompleted.toLocaleString() + ' completed practice exams taken on PassExamHQ ended in a passing score (' + overall.examsPassed.toLocaleString() + ' of ' + overall.examsCompleted.toLocaleString() + ').</p>' +
        '</div>'
      : '<p class="muted">Not enough completed practice exams yet to show a sitewide number.</p>';

    var rows = ((byCategory && byCategory.categories) || []).map(function (cat) {
      var guideHref = cat.categorySlug ? '/guides/' + cat.categorySlug + '-requirements-by-state' : null;
      var rateCell = cat.passRate != null
        ? '<strong>' + cat.passRate + '%</strong>'
        : '<span class="guide-na">Not enough data yet</span>';
      var countCell = cat.attemptCount >= minSample
        ? cat.attemptCount.toLocaleString()
        : '<span class="guide-na">Not met minimum yet</span>';
      return '<tr>' +
        '<td>' + escapeHtml(cat.kind) + '</td>' +
        '<td>' + countCell + '</td>' +
        '<td>' + rateCell + '</td>' +
        '<td class="guide-table-cta">' +
        (cat.categorySlug ? '<a href="/' + cat.categorySlug + '">Practice ' + escapeHtml(cat.kind) + ' →</a>' : '') +
        '</td>' +
        '</tr>';
    }).join('');

    var quizRows = ((byQuiz && byQuiz.categories) || []).map(function (cat) {
      var accCell = cat.accuracyRate != null
        ? '<strong>' + cat.accuracyRate + '%</strong>'
        : '<span class="guide-na">Not enough data yet</span>';
      var qCountCell = cat.questionsAnswered >= quizMinSample
        ? cat.questionsAnswered.toLocaleString()
        : '<span class="guide-na">Not met minimum yet</span>';
      return '<tr>' +
        '<td>' + escapeHtml(cat.kind) + '</td>' +
        '<td>' + qCountCell + '</td>' +
        '<td>' + accCell + '</td>' +
        '<td class="guide-table-cta">' +
        (cat.categorySlug ? '<a href="/' + cat.categorySlug + '">Practice ' + escapeHtml(cat.kind) + ' →</a>' : '') +
        '</td>' +
        '</tr>';
    }).join('');
    var quizSectionHtml = quizRows
      ? '<h2 class="comparison-heading">Quiz Accuracy By Category</h2>' +
        '<p class="page-intro-text">Not everyone takes a full timed practice exam — plenty of students only ever use quiz mode, ' +
        'answering questions one at a time with instant feedback. This is that same real, live-computed accuracy, separate from ' +
        'the pass-rate table above: it measures how often quiz answers are correct, not whether a full scored exam was passed, so ' +
        'the two numbers aren\'t directly comparable. Categories with too few answered questions show "Not enough data yet" instead ' +
        'of a percentage, for the same reason as above.</p>' +
        '<div class="guide-table-wrap">' +
        '<table class="guide-table">' +
        '<thead><tr><th>Category</th><th>Questions Answered</th><th>Accuracy</th><th></th></tr></thead>' +
        '<tbody>' + quizRows + '</tbody>' +
        '</table>' +
        '</div>'
      : '';

    var examSectionHtml =
      '<h2 class="comparison-heading">Exam Pass Rate By Category</h2>' +
      '<p class="muted">Categories with fewer than ' + minSample + ' completed exams show "Not enough data yet" instead of a ' +
      'percentage — a rate computed from a handful of attempts is too noisy to mean anything, regardless of which way it points. ' +
      'We never hide a real rate just because it looks bad once there\'s enough data behind it.</p>' +
      '<div class="guide-table-wrap">' +
      '<table class="guide-table">' +
      '<thead><tr><th>Category</th><th>Completed Exams</th><th>Pass Rate</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '</div>' +
      '<p class="guide-source-note">Only fully completed (submitted) practice exams count. Each attempt is scored against the ' +
      'passing threshold that applied to it at the time it was taken. See our <a href="#/guarantee">pass-or-refund guarantee</a> ' +
      'for what this backs, or browse per-state exam mechanics on our <a href="/guides/notary-requirements-by-state">requirements-by-state guides</a>.</p>';

    appEl.innerHTML =
      '<div class="pass-rates-page">' +
      '<span class="section-eyebrow">Real numbers, not marketing copy</span>' +
      '<h1>Pass Rate Transparency</h1>' +
      '<p class="page-intro-text">Every pass-rate figure on PassExamHQ — here and everywhere else on the site — reflects practice ' +
      'mock exams completed <em>on PassExamHQ itself</em>, computed live from our own database. It is not, and cannot be, a claim ' +
      'about real official exam outcomes: no testing vendor or state licensing board shares that data with prep providers, so any ' +
      'site claiming an official pass rate is estimating or making it up. What you see below is the one number we can actually ' +
      'measure honestly, shown with the real sample sizes behind it.</p>' +
      overallHtml +
      quizSectionHtml +
      examSectionHtml +
      '</div>';
  });
}

// Public exam-mechanics changelog (#/changelog) -- marketing round 3, item #1. Real, dated
// corrections only (see examprep-api's track_registry_changelog schema comment for why this can
// never contain a fabricated/backfilled history): a row only exists here because an admin actually
// changed a track's real mechanics via the console, with a mandatory reason. A visitor with no
// entries yet sees an honest empty state, not padded content.
var CHANGELOG_FIELD_LABELS = {
  exam_question_count: 'Question count', exam_duration_sec: 'Exam duration',
  pass_percent: 'Passing score', min_correct: 'Minimum correct',
};

function changelogValueLabel(field, value) {
  if (value == null) return '—';
  if (field === 'exam_duration_sec') return Math.round(Number(value) / 60) + ' min';
  if (field === 'pass_percent') return value + '%';
  return value;
}

function renderChangelog() {
  appEl.innerHTML = '<div class="narrow-page"><h1>Exam Mechanics Changelog</h1>' + loadingSkeletonHtml(8) + '</div>';
  apiFetch('/changelog').then(function (res) {
    var items = (res && res.items) || [];
    var rows = items.map(function (it) {
      var trackHref = (it.kind && HUB_KIND_SLUGS[it.kind] && it.stateCode)
        ? '/' + kindSlug(it.kind) + '/' + it.stateCode.toLowerCase() : null;
      var trackLabelHtml = trackHref ? '<a href="' + trackHref + '">' + escapeHtml(it.trackLabel) + '</a>' : escapeHtml(it.trackLabel);
      var fieldLabel = CHANGELOG_FIELD_LABELS[it.field] || it.field;
      return '<div class="card changelog-entry">' +
        '<div class="changelog-entry-top"><strong>' + trackLabelHtml + '</strong>' +
        '<span class="muted">' + new Date(it.changedAt * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) + '</span></div>' +
        '<p class="changelog-entry-change">' + escapeHtml(fieldLabel) + ': ' + escapeHtml(changelogValueLabel(it.field, it.oldValue)) +
        ' → <strong>' + escapeHtml(changelogValueLabel(it.field, it.newValue)) + '</strong></p>' +
        '<p class="muted changelog-entry-reason">' + escapeHtml(it.reason) + '</p>' +
        '</div>';
    }).join('');

    appEl.innerHTML =
      '<div class="narrow-page changelog-page">' +
      '<span class="section-eyebrow">Real, dated corrections</span>' +
      '<h1>Exam Mechanics Changelog</h1>' +
      '<p class="page-intro-text">Every question count, time limit, and passing score on PassExamHQ is sourced from the current ' +
      'official handbook or statute for that state. When we catch a real correction — a source we misread, a bulletin the state ' +
      'updated — it\'s logged here, with the reason, rather than silently edited. ' +
      (items.length ? 'This log currently covers ' + items.length + ' correction' + (items.length === 1 ? '' : 's') + '.' :
        'Nothing has needed correcting yet — this page will show real entries as they happen.') + '</p>' +
      (rows || '<p class="muted">No corrections logged yet.</p>') +
      '</div>';
  });
}

// The only way app.js reaches anything above. Keep this list and app.js's DEEP_HASH_VIEWS in step:
// test/deep-bundle-split.test.js fails if a route points at a key that is not registered here.
registerDeep({
  renderTerms: renderTerms,
  renderPrivacy: renderPrivacy,
  renderAbout: renderAbout,
  renderFaq: renderFaq,
  renderGuarantee: renderGuarantee,
  renderPassRates: renderPassRates,
  renderChangelog: renderChangelog,
  renderContact: renderContact,
  renderEmbedGenerator: renderEmbedGenerator,
  renderBlogList: renderBlogList,
  renderBlogPost: renderBlogPost,
  drawBlogList: drawBlogList,
  blogListHref: blogListHref,
  embedPickerHtml: embedPickerHtml,
  embedResultHtml: embedResultHtml,
});
