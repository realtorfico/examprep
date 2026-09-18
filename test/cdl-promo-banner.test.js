// Kind-scoped promotions (2026-09-16, "20% off full CDL access for first-time customers"): the
// site passes the current page's track kind to /promotions (the API filters on it -- see
// handlePromotionsList), and the CDL category landing page shows its own kind-scoped promo as a
// full card above the track card. Non-CDL pages must never ask for, or render, the CDL promo.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor, settle } = require('../test-support/boot-app');

const CDL_KIND = 'Commercial Driver (CDL)';
const CDL_PROMO = {
  id: 'promo-cdl', title: 'First-time customers: 20% off full CDL track access', body: 'New to PassExamHQ?',
  promoCode: 'NEWCDL20', discountType: 'percent', discountValue: 20, requiredTrackKind: CDL_KIND,
};
const EDU_PROMO = {
  id: 'promo-edu', title: 'Student Discount', body: '$5 off', promoCode: null,
  discountType: 'flat_cents', discountValue: 500, requiredEmailDomain: '.edu', requiredTrackKind: null,
};

// Mirrors the real API's filter: kind-scoped promos only come back when ?kind= matches.
function promotionsResponder(requests) {
  return (href) => {
    requests.push(href);
    const kind = new URL(href, 'https://passexamhq.com').searchParams.get('kind');
    return { promotions: kind === CDL_KIND ? [CDL_PROMO, EDU_PROMO] : [EDU_PROMO] };
  };
}

// The in-page promo card was removed from the category page on 2026-09-17 (the header ribbon
// already carries the same code -- it was one of the duplications that pass cleared). What still
// matters, and is what this always really guarded, is that the CDL-scoped promo reaches the ribbon
// and that the request carries the CDL kind.
test('/cdl category page: the ribbon shows the CDL promo, requested with the CDL kind', async (t) => {
  const requests = [];
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/cdl',
    fetchOverrides: [['/promotions', promotionsResponder(requests)]],
  });
  t.after(() => dom.window.close());
  await waitFor(() => document.getElementById('promo-ribbon-wrap').textContent.indexOf('NEWCDL20') !== -1);

  const ribbon = document.getElementById('promo-ribbon-wrap');
  assert.match(ribbon.textContent, /20% off full CDL track access/);
  assert.equal(document.getElementById('category-promotions-wrap'), null, 'the in-page card is gone: the ribbon says this already');
  assert.ok(requests.length > 0);
  requests.forEach((href) => assert.match(href, /kind=Commercial%20Driver%20\(CDL\)|kind=Commercial%20Driver%20%28CDL%29/));
});

test('/cdl/ca track landing page shows the CDL promo in its price card', async (t) => {
  const requests = [];
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/cdl/ca',
    fetchOverrides: [['/promotions', promotionsResponder(requests)]],
  });
  t.after(() => dom.window.close());
  await waitFor(() => {
    const wrap = document.getElementById('track-landing-promotions-wrap');
    return wrap && wrap.textContent.indexOf('NEWCDL20') !== -1;
  });
});

test('/notary category page never shows the CDL promo', async (t) => {
  const requests = [];
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/notary',
    fetchOverrides: [['/promotions', promotionsResponder(requests)]],
  });
  t.after(() => dom.window.close());
  await waitFor(() => document.getElementById('promo-ribbon-wrap').textContent.indexOf('Student Discount') !== -1);
  await settle();
  assert.equal(document.getElementById('category-promotions-wrap'), null, 'no in-page promo card on any category page now');
  assert.doesNotMatch(document.body.textContent, /NEWCDL20/);
  requests.forEach((href) => assert.match(href, /kind=Notary/));
});

test('home page asks for promotions with no kind (so kind-scoped promos are excluded)', async (t) => {
  const requests = [];
  const { dom, document } = await bootApp({
    url: 'https://passexamhq.com/',
    fetchOverrides: [['/promotions', promotionsResponder(requests)]],
  });
  t.after(() => dom.window.close());
  await waitFor(() => requests.length > 0);
  await settle();
  requests.forEach((href) => assert.doesNotMatch(href, /kind=/));
  assert.doesNotMatch(document.body.textContent, /NEWCDL20/);
});
