// Regression test for the 2026-09-18 "footer links open the page but not at its start" bug.
//
// A hash route like "#/faq" names no element, so the browser leaves the window scrolled wherever it
// was when the link was clicked. For the footer that meant the new page rendered into #app while the
// visitor was still looking at the bottom of it (measured live: FAQ at scrollY 2267, Privacy 1329).
// Plain in-page anchors ("#tracks") must keep their own scrolling, and clicking the link for the
// route already on screen fires no hashchange at all, so that case needs handling too.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, settle } = require('../test-support/boot-app');

async function bootRecordingScrolls(url) {
  const scrolls = [];
  const booted = await bootApp({
    url: url,
    windowSetup(win) {
      win.scrollTo = function (x, y) {
        scrolls.push(typeof x === 'object' ? x.top : y);
      };
    },
  });
  return { booted, scrolls };
}

// jsdom queues the hashchange event itself, same as a browser, so settle() after this sees it.
function fireHashChange(window, hash) {
  window.location.hash = hash;
}

test('navigating to a hash route scrolls the window back to the top', async (t) => {
  const { booted, scrolls } = await bootRecordingScrolls('https://passexamhq.com/cdl');
  t.after(() => booted.dom.window.close());
  await settle();
  scrolls.length = 0;
  for (const hash of ['#/faq', '#/privacy', '#/redeem', '#/gift', '#/feedback']) {
    fireHashChange(booted.window, hash);
    await settle();
    assert.ok(scrolls.includes(0), hash + ' should scroll to the top, got ' + JSON.stringify(scrolls));
    scrolls.length = 0;
  }
});

test('a plain in-page anchor does not get pulled back to the top', async (t) => {
  const { booted, scrolls } = await bootRecordingScrolls('https://passexamhq.com/');
  t.after(() => booted.dom.window.close());
  await settle();
  scrolls.length = 0;
  fireHashChange(booted.window, '#tracks');
  await settle();
  assert.ok(!scrolls.includes(0), '#tracks should keep its own anchor scrolling, got ' + JSON.stringify(scrolls));
});

test('clicking the link for the route already showing scrolls to its top', async (t) => {
  const { booted, scrolls } = await bootRecordingScrolls('https://passexamhq.com/cdl#/faq');
  t.after(() => booted.dom.window.close());
  await settle();
  const faqLink = booted.window.document.querySelector('#site-footer a[href="#/faq"]');
  assert.ok(faqLink, 'footer should have an FAQ link');
  scrolls.length = 0;
  faqLink.dispatchEvent(new booted.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  assert.ok(scrolls.includes(0), 'same-route click should scroll to the top, got ' + JSON.stringify(scrolls));
});
