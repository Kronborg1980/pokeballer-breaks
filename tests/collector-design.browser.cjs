/* Collector redesign regressions. All remote traffic is intercepted locally.
   Run with NODE_PATH pointing to an installed Playwright package.
   Optional CHROMIUM_PATH, PBM_SCREENSHOT_DIR. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, fixturePage, fixtureItems } = require('./storefront.browser.cjs');
const screenshotDir = process.env.PBM_SCREENSHOT_DIR;

async function noErrors(fixture) {
  assert.deepEqual(fixture.errors, [], 'No browser runtime errors');
  assert.deepEqual(fixture.unexpectedApi, [], 'No order, tracking or unexpected API requests');
}

async function testDetails(browser, origin, mobile) {
  const fixture = await fixturePage(browser, origin, 3, mobile ? {} : {
    viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false
  });
  const { page, context, items } = fixture;
  try {
    const trigger = page.locator('#card-bundle-0 .collector-details-link[data-details-id="bundle-0"]');
    await trigger.click();
    const dialog = page.locator('#collector-details');
    assert.equal(await dialog.evaluate(el => el.open), true);
    assert.equal(await dialog.getAttribute('aria-labelledby'), 'cd-title');
    assert.equal(await page.locator('#cd-title').textContent(), items[0].name);
    assert.equal(await dialog.locator('.cd-price').textContent(), '$24.50');
    assert.equal(await dialog.locator('.cd-price-unit').textContent(), 'per bundle');
    assert.equal(await dialog.locator('.cd-stock').textContent(), '3 bundles remaining');
    assert.equal(await dialog.locator('.cd-description').textContent(), items[0].description);
    assert.match(await dialog.locator('.cd-limits').textContent(), /2–5 bundles/);
    assert.equal(await dialog.locator('.cd-pack-action').isEnabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), 'hidden');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('#collector-details').contains(document.activeElement)), true);
    if (screenshotDir) {
      await page.screenshot({ animations: 'disabled', path: path.join(screenshotDir, `collector-details-${mobile ? 'mobile' : 'desktop'}.png`) });
    }
    await page.keyboard.press('Escape');
    assert.equal(await dialog.evaluate(el => el.open), false);
    assert.equal(await trigger.evaluate(el => document.activeElement === el), true, 'Escape restores focus');
    assert.notEqual(await page.evaluate(() => document.documentElement.style.overflow), 'hidden');

    await trigger.click();
    await dialog.locator('.cd-pack-action').click();
    assert.equal(await dialog.evaluate(el => el.open), false);
    assert.equal(await page.locator('#checkoutModal').evaluate(el => getComputedStyle(el).display), 'flex');
    assert.equal(await page.locator('#co-title').textContent(), items[0].name);
    assert.equal(await page.locator('#co-qty').inputValue(), '2');
    assert.equal(await page.locator('#co-total').textContent(), '49.00');
    assert.equal(await page.locator('#co-name').evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('collector-modal-open'));
    assert.equal(await trigger.evaluate(el => document.activeElement === el), true, 'Checkout returns focus to the product details trigger');

    // State can change after the sheet opens. The action must recheck stock.
    await trigger.click();
    await page.evaluate(() => { window.storeItems.find(item => item.id === 'bundle-0').stock = 0; });
    await dialog.locator('.cd-pack-action').click();
    assert.equal(await dialog.evaluate(el => el.open), true);
    assert.equal(await dialog.locator('.cd-status').getAttribute('data-state'), 'sold');
    assert.equal(await dialog.locator('.cd-pack-action').isDisabled(), true);
    assert.equal(await page.locator('#checkoutModal').evaluate(el => getComputedStyle(el).display), 'none');
    await page.keyboard.press('Escape');

    for (const [state, patch] of [
      ['upcoming', { stock: 3, goLiveTime: '2099-12-01T12:00', scheduleEnd: '' }],
      ['closed', { stock: 3, goLiveTime: '', scheduleEnd: '2000-01-01T12:00' }],
      ['sold', { stock: 0, goLiveTime: '', scheduleEnd: '' }]
    ]) {
      await page.evaluate(({ patch }) => {
        Object.assign(window.storeItems.find(item => item.id === 'bundle-0'), patch);
        window.PBMDetails.open('bundle-0');
      }, { patch });
      assert.equal(await dialog.locator('.cd-status').getAttribute('data-state'), state);
      assert.equal(await dialog.locator('.cd-pack-action').isDisabled(), true, `${state} cannot reserve`);
      await page.keyboard.press('Escape');
    }

    // External entry links retain the wheel semantics and cannot execute JS URLs.
    await page.evaluate(() => window.PBMDetails.open('wheel'));
    assert.equal(await dialog.locator('.cd-link-action').getAttribute('href'), 'https://wheel.example/join');
    assert.equal(await dialog.locator('.cd-link-label').textContent(), 'Join the wheel');
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const item = window.storeItems.find(item => item.id === 'wheel');
      item.googleFormLink = 'javascript:window.__executed=true';
      item.description = '<img src=x onerror="window.__executed=true">';
      window.PBMDetails.open('wheel');
    });
    assert.equal(await dialog.locator('.cd-link-action').getAttribute('href'), null);
    assert.equal(await dialog.locator('.cd-pack-action').isDisabled(), true);
    assert.equal(await dialog.locator('.cd-description img').count(), 0, 'Descriptions render as text');
    assert.equal(await page.evaluate(() => window.__executed), undefined);
    await page.keyboard.press('Escape');
    await noErrors(fixture);
    console.log(`PASS ${mobile ? 'mobile' : 'desktop'} collectible details: data, focus, checkout handoff, stock/schedule guards and URL safety`);
  } finally { await context.close(); }
}

async function testFeaturedAndEmpty(browser, origin) {
  const fixture = await fixturePage(browser, origin, 3);
  try {
    const { page, items } = fixture;
    assert.equal(await page.locator('#featured-break-title').textContent(), items[0].name);
    assert.match(await page.locator('#featured-break-price').textContent(), /24\.50/);
    const detailsId = await page.locator('#featured-break').getAttribute('data-details-id');
    assert.equal(detailsId, 'bundle-0');
    await page.locator('#featured-break').click();
    assert.equal(await page.locator('#collector-details').evaluate(el => el.open), true);
    assert.equal(await page.locator('#cd-title').textContent(), items[0].name);
    await page.keyboard.press('Escape');
    // Every local in-page navigation target must exist.
    const badAnchors = await page.locator('nav a[href^="#"]').evaluateAll(links => links
      .filter(link => link.getAttribute('href').length > 1 && !document.getElementById(link.getAttribute('href').slice(1)))
      .map(link => link.getAttribute('href')));
    assert.deepEqual(badAnchors, []);
    assert.equal(await page.locator('#card-wheel .buy-btn').getAttribute('href'), 'https://wheel.example/join');
    await noErrors(fixture);
    console.log('PASS featured break data and navigation targets');
  } finally { await fixture.context.close(); }

  const empty = await fixturePage(browser, origin, 0, {}, { items: [] });
  try {
    const { page } = empty;
    assert.equal(await page.locator('.pbm-carousel-card').count(), 0);
    assert.equal(await page.locator('#featured-break').isHidden(), true, 'No fabricated featured product for an empty inventory');
    assert.equal(await page.locator('#store-sections .buy-btn:not(.sold-out)').count(), 0);
    assert.equal(await page.evaluate(() => (window.storeItems || []).length), 0);
    const hero = await page.locator('header').textContent();
    assert.equal(/NaN|undefined/.test(hero), false);
    await noErrors(empty);
    console.log('PASS empty inventory keeps the hero and storefront honest');
  } finally { await empty.context.close(); }
}

async function testFeaturedAvailability(browser, origin) {
  const pack = fixtureItems(1)[0];
  for (const [state, patch] of [
    ['upcoming', { goLiveTime: '2099-12-01T12:00' }],
    ['sold', { stock: 0 }],
    ['hidden', { hidden: true }]
  ]) {
    const fixture = await fixturePage(browser, origin, 1, {}, { items: [{ ...pack, ...patch }] });
    try {
      const { page } = fixture;
      const featured = page.locator('#featured-break');
      if (state === 'upcoming') {
        await page.waitForFunction(() => document.querySelector('#featured-break-title').textContent.length > 0);
        assert.equal(await featured.isVisible(), true);
        assert.equal(await page.locator('#featured-break-status').textContent(), 'COMING UP NEXT');
        await featured.click();
        assert.equal(await page.locator('.cd-status').getAttribute('data-state'), 'upcoming');
        assert.equal(await page.locator('.cd-pack-action').isDisabled(), true);
        await page.keyboard.press('Escape');
      } else {
        assert.equal(await featured.isHidden(), true, `${state} inventory is never promoted as purchasable`);
      }
      await noErrors(fixture);
    } finally { await fixture.context.close(); }
  }
  console.log('PASS featured inventory respects future opening, sold-out and hidden states');
}

async function captureWorlds(browser, origin) {
  if (!screenshotDir) return;
  await fs.mkdir(screenshotDir, { recursive: true });
  for (const mobile of [false, true]) {
    const fixture = await fixturePage(browser, origin, 8, mobile ? {} : {
      viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false
    }, { theme: 'crystal' });
    try {
      const { page } = fixture;
      for (const theme of ['crystal', 'halloween', 'christmas', 'birthday']) {
        await page.evaluate(value => applyTheme(value), theme);
        await page.waitForFunction(value => document.querySelector('#collector-world-image')?.getAttribute('src')?.includes(value === 'crystal' ? 'original' : value), theme);
        await page.locator('#collector-world-image').evaluate(el => el.decode());
        await page.screenshot({ animations: 'disabled', path: path.join(screenshotDir, `collector-${theme}-${mobile ? 'mobile' : 'desktop'}.png`) });
      }
      await page.locator('.pbm-product-carousel').scrollIntoViewIfNeeded();
      await page.screenshot({ animations: 'disabled', path: path.join(screenshotDir, `collector-products-${mobile ? 'mobile' : 'desktop'}.png`) });
      await noErrors(fixture);
    } finally { await fixture.context.close(); }
  }
  console.log(`SCREENSHOTS ${screenshotDir}`);
}

(async () => {
  const { server, origin } = await serve();
  let browser;
  try {
    const executablePath = process.env.CHROMIUM_PATH ||
      (await fs.access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined));
    browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
    if (screenshotDir) await fs.mkdir(screenshotDir, { recursive: true });
    await testDetails(browser, origin, true);
    await testDetails(browser, origin, false);
    await testFeaturedAndEmpty(browser, origin);
    await testFeaturedAvailability(browser, origin);
    await captureWorlds(browser, origin);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
