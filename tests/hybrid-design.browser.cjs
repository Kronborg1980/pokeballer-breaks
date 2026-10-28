/* Old neon storefront + illustrated worlds. All remote traffic is intercepted.
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

async function testCompactDesign(browser, origin, mobile) {
  const fixture = await fixturePage(browser, origin, 3, mobile ? {} : {
    viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false
  });
  const { page, context } = fixture;
  try {
    assert.equal((await page.locator('#site-title').textContent()).replace(/\s+/g, ' ').trim(), 'PBM BREAKS');
    assert.equal(await page.locator('.top-nav .nav-link').count(), 2, 'Original compact navigation is retained');
    assert.equal(await page.locator('.collector-how,.collector-faq,.collector-hero-copy,#featured-break,#collector-details').count(), 0,
      'Editorial descriptions and extra product sheet are removed');
    assert.equal(await page.locator('script[src*="collector-details"]').count(), 0);
    assert.equal(await page.locator('#hero-plate .hero-status-title').first().textContent(), fixture.items[0].name);
    assert.equal(/Small packs|Legendary nights|Something good could be in here/.test(await page.locator('header').textContent()), false);
    const badAnchors = await page.locator('nav a[href^="#"]').evaluateAll(links => links
      .filter(link => link.getAttribute('href').length > 1 && !document.getElementById(link.getAttribute('href').slice(1)))
      .map(link => link.getAttribute('href')));
    assert.deepEqual(badAnchors, []);
    await noErrors(fixture);
    console.log(`PASS ${mobile ? 'mobile' : 'desktop'} compact neon identity and direct product browsing`);
  } finally { await context.close(); }
}

async function testCheckout(browser, origin, mobile) {
  const fixture = await fixturePage(browser, origin, 3, mobile ? {} : {
    viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false
  });
  const { page, context, items } = fixture;
  try {
    const trigger = page.locator('#card-bundle-0 .buy-btn');
    await trigger.click();
    const modal = page.locator('#checkoutModal');
    assert.equal(await modal.isVisible(), true);
    assert.equal(await modal.getAttribute('role'), 'dialog');
    assert.equal(await modal.getAttribute('aria-modal'), 'true');
    assert.equal(await modal.getAttribute('aria-labelledby'), 'co-title');
    assert.equal(await page.locator('#co-title').textContent(), items[0].name);
    assert.equal(await page.locator('#co-qty-label').textContent(), 'How many bundles?');
    assert.equal(await page.locator('#co-qty').inputValue(), '2');
    assert.equal(await page.locator('#co-qty').getAttribute('min'), '2');
    assert.equal(await page.locator('#co-qty').getAttribute('max'), '3');
    assert.equal(await page.locator('#co-total').textContent(), '49.00');
    assert.equal(await page.locator('#co-name').evaluate(el => document.activeElement === el), true);
    const locked = await page.evaluate(() => [document.body,document.documentElement]
      .some(element => getComputedStyle(element).overflowY === 'hidden'));
    assert.equal(locked, true, 'Opening checkout locks background scrolling');
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      assert.equal(await modal.evaluate(el => el.contains(document.activeElement)), true, 'Tab remains inside checkout');
    }
    await page.locator('#co-plus').click();
    assert.equal(await page.locator('#co-qty').inputValue(), '3');
    assert.equal(await page.locator('#co-plus').isDisabled(), true);
    assert.equal(await page.locator('#co-total').textContent(), '73.50');
    if (screenshotDir) {
      await page.screenshot({ animations: 'disabled', path: path.join(screenshotDir, `checkout-${mobile ? 'mobile' : 'desktop'}.png`) });
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#checkoutModal')).display === 'none');
    assert.equal(await trigger.evaluate(el => document.activeElement === el), true, 'Checkout returns focus to its purchase button');
    assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
    assert.equal(await page.locator('#card-wheel .buy-btn').getAttribute('href'), 'https://wheel.example/join');
    await noErrors(fixture);
    console.log(`PASS ${mobile ? 'mobile' : 'desktop'} direct checkout: quantity, keyboard containment, close and focus restoration`);
  } finally { await context.close(); }
}

async function testInventoryStates(browser, origin) {
  const pack = fixtureItems(1)[0];
  for (const [state, patch] of [
    ['upcoming', { goLiveTime: '2099-12-01T12:00' }],
    ['closed', { scheduleEnd: '2000-01-01T12:00' }],
    ['sold', { stock: 0 }],
    ['hidden', { hidden: true }],
    ['empty', null]
  ]) {
    const fixture = await fixturePage(browser, origin, 1, {}, { items: patch ? [{ ...pack, ...patch }] : [] });
    try {
      const { page } = fixture;
      const card = page.locator('#card-bundle-0');
      if (state === 'upcoming') {
        assert.equal(await card.locator('.live-countdown').count(), 1);
        assert.equal(await card.locator('button.buy-btn,a.buy-btn').count(), 0);
        assert.equal(await page.locator('#hero-upcoming-slide .hero-status-title').textContent(), pack.name);
      } else if (state === 'hidden' || state === 'empty') {
        assert.equal(await card.count(), 0);
        assert.equal(await page.locator('#hero-plate .hero-live,#hero-upcoming-slide').count(), 0);
      } else {
        assert.equal(await card.locator('.sold-out').count(), 1);
        assert.equal(await card.locator('button.buy-btn,a.buy-btn').count(), 0);
        assert.equal(await page.locator('#hero-plate .hero-live').count(), 0);
      }
      assert.equal(/NaN|undefined/.test(await page.locator('header').textContent()), false);
      const image = page.locator('#collector-world-image');
      await image.evaluate(el => el.decode());
      assert.ok(await image.evaluate(el => el.naturalWidth) > 0, 'The illustrated header remains available');
      await noErrors(fixture);
    } finally { await fixture.context.close(); }
  }

  const safe = await fixturePage(browser, origin, 1, {}, { items: [{ ...pack,
    name:'<img src=x onerror="window.__executed=true">',
    description:'<script>window.__executed=true</script>'
  }] });
  try {
    assert.equal(await safe.page.locator('#card-bundle-0 h3 img,#card-bundle-0 .desc script').count(), 0);
    assert.equal(await safe.page.evaluate(() => window.__executed), undefined);
    await noErrors(safe);
  } finally { await safe.context.close(); }
  console.log('PASS empty, future, closed, sold and hidden inventory states; text rendering stays safe');
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
        await page.waitForFunction(value => document.querySelector('#collector-world-image')?.dataset.world === (value === 'crystal' ? 'original' : value), theme);
        await page.locator('#collector-world-image').evaluate(el => el.decode());
        await page.screenshot({ animations: 'disabled', path: path.join(screenshotDir, `${theme}-${mobile ? 'mobile' : 'desktop'}.png`) });
      }
      await page.locator('.pbm-product-carousel').scrollIntoViewIfNeeded();
      await page.screenshot({ animations: 'disabled', path: path.join(screenshotDir, `products-${mobile ? 'mobile' : 'desktop'}.png`) });
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
    await testCompactDesign(browser, origin, true);
    await testCompactDesign(browser, origin, false);
    await testCheckout(browser, origin, true);
    await testCheckout(browser, origin, false);
    await testInventoryStates(browser, origin);
    await captureWorlds(browser, origin);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
