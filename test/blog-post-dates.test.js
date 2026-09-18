// Every blog post page was a dead end. Found 2026-09-17 while verifying the bundle split.
//
// /api/blog returns published_at as an ISO-8601 STRING ('2026-09-08T04:13:41.488Z'), and three
// places multiplied it by 1000 as if it were Unix seconds. 'string' * 1000 is NaN, so:
//   - new Date(NaN).toISOString() THROWS (RangeError: Invalid time value) in the JSON-LD block,
//     and renderBlogPost's .catch() then rendered "Not found -- this article doesn't exist or
//     isn't published" over a post that exists and is published. All 621 of them.
//   - the list cards and the post byline printed "Invalid Date".
//
// The catch was the reason this stayed invisible: it reported a render exception as a missing
// article, so the page looked like a content problem rather than a crash. It now says loading
// failed, and logs, and only a genuinely absent post gets the not-found copy.
//
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../test-support/boot-app');

// Shaped exactly like a real /api/blog/<slug> response (see the field dump in that session).
function post(overrides) {
  return {
    post: Object.assign({
      id: 'blog-driver-ct-key-facts-digest',
      slug: 'inside-the-ct-driver-key-facts-digest',
      kind: 'driver',
      state_code: 'CT',
      title: 'Inside the Connecticut Driver Key Facts Digest',
      excerpt: 'A look at the quick-reference tables.',
      body_html: '<p>' + 'word '.repeat(400) + '</p>',
      seo_title: 'Inside the CT Driver Key Facts Digest',
      seo_description: 'What is in your resources tab.',
      status: 'published',
      published_at: '2026-09-08T04:13:41.488Z',
      created_at: '2026-09-08T04:13:41.488Z',
      updated_at: '2026-09-08T04:13:41.488Z',
      featured: 0,
    }, overrides || {}),
  };
}

async function bootPost(t, payload, listPayload) {
  const p = payload || post();
  const booted = await bootApp({
    url: 'https://passexamhq.com/blog/' + p.post.slug,
    fetchOverrides: [
      ['/blog/' + p.post.slug, p],
      ['/blog', listPayload || { posts: [p.post] }],
    ],
  });
  t.after(() => booted.dom.window.close());
  await settle();
  await settle();
  return booted;
}

test('a published post renders, instead of claiming it does not exist', async (t) => {
  const { document } = await bootPost(t);
  const text = document.getElementById('app').textContent;
  assert.ok(!/doesn't exist|isn't published/.test(text), 'got the not-found page for a real post: ' + text.slice(0, 120));
  assert.match(text, /Inside the Connecticut Driver Key Facts Digest/);
});

test('the byline shows a real date, not "Invalid Date"', async (t) => {
  const { document } = await bootPost(t);
  const text = document.getElementById('app').textContent;
  assert.ok(!/Invalid Date/.test(text), 'got: ' + text.slice(0, 200));
  assert.match(text, /2026/, 'the published year should appear in the byline');
  assert.match(text, /min read/);
});

test('the JSON-LD carries a valid ISO date', async (t) => {
  const { document } = await bootPost(t);
  const node = document.getElementById('blog-post-jsonld');
  assert.ok(node, 'the article JSON-LD should be injected');
  const data = JSON.parse(node.textContent);
  assert.equal(data.headline, 'Inside the Connecticut Driver Key Facts Digest');
  assert.equal(data.datePublished, '2026-09-08T04:13:41.488Z');
});

test('a Unix-seconds timestamp still works, in case the API ever sends one', async (t) => {
  // 1757304821 = 2025-09-08T04:13:41Z. Both shapes have to be readable: this bug was a disagreement
  // between the API's format and the page's assumption, and a test that only covers today's format
  // would let the reverse break silently.
  const { document } = await bootPost(t, post({ published_at: 1757304821 }));
  const text = document.getElementById('app').textContent;
  assert.ok(!/Invalid Date/.test(text), 'got: ' + text.slice(0, 160));
  assert.match(JSON.parse(document.getElementById('blog-post-jsonld').textContent).datePublished, /^2025-09-08T/);
});

test('an unparseable date drops the date instead of taking the page down', async (t) => {
  const { document } = await bootPost(t, post({ published_at: 'not-a-date' }));
  const text = document.getElementById('app').textContent;
  assert.match(text, /Inside the Connecticut Driver Key Facts Digest/, 'the post still renders');
  assert.ok(!/Invalid Date/.test(text));
  const data = JSON.parse(document.getElementById('blog-post-jsonld').textContent);
  assert.ok(!('datePublished' in data) || data.datePublished === undefined, 'no bogus date in the structured data');
});

test('a genuinely missing post still says so', async (t) => {
  const booted = await bootApp({
    url: 'https://passexamhq.com/blog/gone',
    fetchOverrides: [['/blog/gone', { post: null }], ['/blog', { posts: [] }]],
  });
  t.after(() => booted.dom.window.close());
  await settle();
  await settle();
  assert.match(booted.document.getElementById('app').textContent, /doesn't exist|isn't published/);
});

test('a failed request is reported as a failure, not as a missing article', async (t) => {
  // The distinction that hid this bug for as long as it lasted.
  const booted = await bootApp({
    url: 'https://passexamhq.com/blog/boom',
    fetchOverrides: [['/blog/boom', { status: 500, body: { error: 'server_error' } }], ['/blog', { posts: [] }]],
  });
  t.after(() => booted.dom.window.close());
  await settle();
  await settle();
  const text = booted.document.getElementById('app').textContent;
  assert.ok(!/doesn't exist/.test(text), 'a 500 is not "this article does not exist": ' + text.slice(0, 120));
  assert.match(text, /could not load|couldn't load|try again/i);
});

test('the list cards show real dates too', async (t) => {
  const p = post();
  const booted = await bootApp({
    url: 'https://passexamhq.com/blog',
    fetchOverrides: [['/blog', { posts: [p.post] }]],
  });
  t.after(() => booted.dom.window.close());
  await settle();
  await settle();
  const text = booted.document.getElementById('app').textContent;
  assert.ok(!/Invalid Date/.test(text), 'got: ' + text.slice(0, 200));
});
