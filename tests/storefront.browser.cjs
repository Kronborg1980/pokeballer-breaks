/* Browser regressions with local fixtures only. No request reaches production.
   Run: NODE_PATH=/path/to/playwright/node_modules node tests/storefront.browser.cjs
   Optional: CHROMIUM_PATH and PBM_SCREENSHOT_DIR. */
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const apiOrigin = 'https://pokeballer-worker.kronborgnielsen.workers.dev';
const screenshots = process.env.PBM_SCREENSHOT_DIR;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const fixtureItems = count => [
  ...Array.from({ length: count }, (_, i) => ({
    id: `bundle-${i}`, name: `Trainer Bundle ${i + 1}`, type: 'pack',
    displayTier: 'bundle', stockLabelType: 'bundles', stock: 3 + i % 3,
    minBuy: 2, maxBuy: 5, price: 24.5 + i,
    description: 'A live opening with booster packs, mystery pulls and shipping included. '.repeat(4),
    image: 'https://assets.pokemon.com/test-card.png', createdAt: 1000 - i
  })),
  { id: 'wheel', name: 'MSRP Wheel Entry', type: 'msrp', stock: 12, price: 8,
    description: 'Join the live wheel for a break spot.',
    image: 'https://assets.pokemon.com/test-wheel.png',
    googleFormLink: 'https://wheel.example/join', createdAt: 1 }
];

async function serve() {
  const server = http.createServer(async (req, res) => {
    try {
      const requested = decodeURIComponent(new URL(req.url, 'http://local').pathname);
      const file = path.resolve(root, '.' + (requested === '/' ? '/index.html' : requested));
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function fixturePage(browser, origin, count, options = {}, fixture = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, ...options });
  const page = await context.newPage();
  const errors = [], unexpectedApi = [];
  const items = fixture.items || fixtureItems(count);
  const placeholder = await fs.readFile(path.join(root, 'favicon-original.svg'));
  page.on('pageerror', error => errors.push(error.message));
  // Catch ALL requests before any network operation; even writes are fulfilled
  // locally and recorded as failures. This includes trackClick and checkout.
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.origin === apiOrigin) {
      let data;
      if (request.method() === 'GET' && url.pathname === '/api/items') data = items;
      else if (request.method() === 'GET' && url.pathname === '/api/settings') {
        data = { paymentMode: 'streamlabs', theme: fixture.theme || 'halloween', stripeReady: false };
      } else if (request.method() === 'GET' && url.pathname === '/api/youtube') data = [];
      else { unexpectedApi.push(`${request.method()} ${url.pathname}`); data = { error: 'Unexpected test request' }; }
      return route.fulfill({ json: data, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    if (request.resourceType() === 'image') {
      return route.fulfill({ contentType: 'image/svg+xml', body: placeholder });
    }
    if (request.resourceType() === 'script' || request.resourceType() === 'stylesheet') {
      return route.fulfill({ contentType: request.resourceType() === 'script' ? 'text/javascript' : 'text/css', body: '' });
    }
    return route.abort();
  });
  await page.goto(origin + '/index.html');
  await page.waitForFunction(() => typeof storeLoadBusy !== 'undefined' && !storeLoadBusy && typeof window.PBMDetails !== 'undefined');
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, fixture.theme || 'halloween');
  return { page, context, items, errors, unexpectedApi };
}

async function assertIndex(carousel, expected, count) {
  assert.equal(await carousel.getAttribute('data-index'), String(expected));
  assert.equal(await carousel.locator('.pbm-carousel-card[data-pos="0"]').getAttribute('data-card-index'), String(expected));
  assert.equal(await carousel.locator('.pbm-carousel-count').textContent(), `${expected + 1} / ${count}`);
  assert.equal(await carousel.locator('.pbm-carousel-dot[aria-current="true"]').getAttribute('data-jump'), String(expected));
}

async function touchGesture(carousel, cancel = false) {
  await carousel.evaluate((element, cancelled) => {
    const dispatch = (type, x, ended) => {
      const touch = new Touch({ identifier: 1, target: element, clientX: x, clientY: 250 });
      element.dispatchEvent(new TouchEvent(type, { bubbles: true,
        touches: ended ? [] : [touch], changedTouches: [touch] }));
    };
    dispatch('touchstart', 280, false);
    if (cancelled) dispatch('touchcancel', 280, true);
    dispatch('touchend', 100, true);
  }, cancel);
}

async function testCarousel(browser, origin, count) {
  const { page, context, items, errors, unexpectedApi } = await fixturePage(browser, origin, count);
  try {
    const carousel = page.locator('.pbm-product-carousel');
    await assertIndex(carousel, 0, count);
    await carousel.locator('[data-shift="-1"]').click();
    await assertIndex(carousel, count - 1, count);
    await carousel.locator('[data-shift="1"]').click();
    await assertIndex(carousel, 0, count);
    await carousel.locator(`[data-jump="${count - 1}"]`).click();
    await assertIndex(carousel, count - 1, count);
    await carousel.locator('[data-shift="1"]').focus();
    await page.keyboard.press('ArrowRight');
    await assertIndex(carousel, 0, count);
    await page.keyboard.press('ArrowLeft');
    await assertIndex(carousel, count - 1, count);
    await carousel.locator('[data-jump="0"]').click();
    // A real pointer tap on the exposed edge must select the side product.
    await carousel.locator('.pbm-carousel-stage').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll('.pbm-carousel-card')]
      .every(element => element.getAnimations().every(animation => animation.playState !== 'running')));
    const side = carousel.locator('.pbm-carousel-card[data-pos="1"]');
    const point = await side.evaluate(element => {
      const card = element.getBoundingClientRect();
      const bounds = element.closest('.pbm-product-carousel').getBoundingClientRect();
      return { x: Math.min(card.right, bounds.right) - 8,
        y: Math.max(8, Math.min(innerHeight - 8, card.top + card.height / 2)) };
    });
    await page.mouse.click(point.x, point.y);
    await assertIndex(carousel, 1, count);
    const inaccessible = await carousel.locator('.pbm-carousel-card').evaluateAll(cards =>
      cards.every(card => card.dataset.pos === '0' ? !card.firstElementChild.inert : card.firstElementChild.inert));
    assert.ok(inaccessible, 'Only the selected product may expose checkout controls');

    await carousel.locator('[data-jump="0"]').click();
    await touchGesture(carousel, true);
    await assertIndex(carousel, 0, count);
    await touchGesture(carousel);
    await assertIndex(carousel, 1, count);
    // Reproduces mobile browsers dispatching a click after touchend.
    await carousel.locator('[data-shift="1"]').dispatchEvent('click');
    await assertIndex(carousel, 1, count);
    // Subsequent intentional taps occur after the browser's compatibility-click
    // suppression window. Wait for that state, rather than a fixed sleep.
    await page.waitForFunction(() => Date.now() - Number(document.querySelector('.pbm-product-carousel').dataset.swipeAt) >= 550);

    // The hero must reveal its named product BEFORE scrolling to it.
    await page.evaluate(() => {
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args) {
        if (this.id.startsWith('card-')) window.__scrollSelection = {
          target: this.id, position: this.closest('.pbm-carousel-card')?.dataset.pos
        };
        return original.apply(this, args);
      };
    });
    const heroDot = page.locator(`.hero-carousel-dot[data-carousel-index="${count - 2}"]`);
    await heroDot.click();
    await page.locator('#hero-upcoming-slide').click();
    assert.deepEqual(await page.evaluate(() => window.__scrollSelection), {
      target: `card-bundle-${count - 1}`, position: '0'
    });
    await assertIndex(carousel, count - 1, count);

    const selected = items[count - 1];
    await page.locator(`#card-${selected.id} .buy-btn`).click();
    assert.equal(await page.locator('#co-title').textContent(), selected.name);
    assert.equal(await page.locator('#co-qty-label').textContent(), 'How many bundles?');
    assert.equal(await page.locator('#co-qty').inputValue(), '2');
    assert.equal(await page.locator('#co-qty').getAttribute('max'), String(selected.stock));
    await page.locator('#co-plus').click();
    assert.equal(await page.locator('#co-qty').inputValue(), '3');
    await page.evaluate(() => closeCheckout());
    assert.equal(await page.locator('#card-wheel .buy-btn').getAttribute('href'), 'https://wheel.example/join');
    if (count === 8) {
      const pending = await page.evaluate(() => {
        const originalFetch = window.fetch.bind(window);
        let requests = 0;
        window.__previousCard = document.getElementById('card-bundle-0');
        window.fetch = (url, options) => {
          if (String(url).endsWith('/api/items')) {
            requests++;
            return new Promise(resolve => {
              window.__releaseStore = () => resolve(originalFetch(url, options));
            });
          }
          return originalFetch(url, options);
        };
        window.__pendingStoreLoad = loadStore();
        loadStore();
        return { requests, retained: window.__previousCard === document.getElementById('card-bundle-0'),
          skeletons: document.querySelectorAll('#store-loading,.skeleton').length };
      });
      assert.deepEqual(pending, { requests: 1, retained: true, skeletons: 0 },
        'Concurrent background loads share one request and retain products while pending');
      await page.evaluate(async () => { window.__releaseStore(); await window.__pendingStoreLoad; });
      await assertIndex(page.locator('.pbm-product-carousel'), count - 1, count);
    }
    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    assert.deepEqual(unexpectedApi, [], 'No checkout, tracking, or unexpected API requests');
    console.log(`PASS mobile carousel ${count} products: arrows, dots, keyboard, side tap, swipe/cancel, hero, checkout`);
  } finally { await context.close(); }
}

async function testThemes(browser, origin) {
  const { page, context, errors, unexpectedApi } = await fixturePage(browser, origin, 8);
  try {
    const artwork = new Set();
    for (const theme of ['halloween', 'christmas', 'birthday', 'crystal']) {
      await page.evaluate(value => applyTheme(value), theme);
      await page.waitForFunction(value => document.querySelector('#collector-world-image')?.getAttribute('src')?.includes(value === 'crystal' ? 'original' : value), theme);
      assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'),
        theme === 'crystal' ? 'favicon-original.svg' : `favicon-${theme}.svg`);
      const worldImage = page.locator('#collector-world-image');
      assert.equal(await worldImage.count(), 1);
      if (theme !== 'crystal') artwork.add(await worldImage.getAttribute('src'));
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const metrics = await page.evaluate(() => ({
          width: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
          canvas: document.querySelector('#weather') ? getComputedStyle(document.querySelector('#weather')).display : 'none',
          movingEdges: [...document.querySelectorAll('main,.neon-card-wrapper,.buy-btn')]
            .filter(element => getComputedStyle(element).animationName.split(',').some(name => name.trim() === 'edgeSpin')).length
        }));
        assert.ok(metrics.scroll <= metrics.width + 1, `${theme} overflows at ${width}px (${metrics.scroll})`);
        assert.equal(metrics.canvas, 'none', 'Touch screens must not run full-screen weather');
        assert.equal(metrics.movingEdges, 0, 'Touch screens must not animate painted gradient edges');
      }
      if (screenshots && theme !== 'crystal') {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: path.join(screenshots, `storefront-${theme}-mobile.png`) });
      }
    }
    assert.equal(artwork.size, 3, 'Each season must have distinct local artwork');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => applyTheme('christmas'));
    assert.equal(await page.evaluate(() => document.querySelector('#weather') ? getComputedStyle(document.querySelector('#weather')).display : 'none'), 'none');
    const movingScene = await page.locator('#collector-world-image').evaluate(el =>
      el.getAnimations().some(animation => animation.playState === 'running'));
    assert.equal(movingScene, false, 'Reduced motion must stop seasonal decoration animation');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedApi, []);
    console.log('PASS seasonal switching, responsive widths 320/390/768/1440, static world artwork and reduced motion');
  } finally { await context.close(); }
}

async function captureScreenshots(browser, origin) {
  if (!screenshots) return;
  for (const device of ['mobile', 'desktop']) {
    const { page, context } = await fixturePage(browser, origin, 8, device === 'desktop'
      ? { viewport: { width: 1440, height: 1100 }, isMobile: false, hasTouch: false } : {});
    try {
      for (const theme of ['halloween', 'christmas']) {
        await page.evaluate(value => applyTheme(value), theme);
        await page.waitForFunction(value => document.querySelector('#collector-world-image')?.getAttribute('src')?.includes(value === 'crystal' ? 'original' : value), theme);
        const filename = path.join(screenshots, `storefront-${theme}-${device}.png`);
        await page.screenshot({ path: filename });
        console.log(`SCREENSHOT ${filename}`);
      }
      if (device === 'mobile') {
        await page.locator('.pbm-product-carousel').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(screenshots, 'storefront-bundles-mobile.png') });
        console.log('MOBILE RENDERING', JSON.stringify(await page.evaluate(() => ({
          animations: document.getAnimations().filter(a => a.playState === 'running').map(a => a.animationName),
          weatherCanvas: !!document.querySelector('canvas#weather'),
          perspective: getComputedStyle(document.querySelector('.pbm-carousel-stage')).perspective,
          cardFilter: getComputedStyle(document.querySelector('.pbm-carousel-card')).filter,
          wrapperTransform: getComputedStyle(document.querySelector('.pbm-carousel-card[data-pos="0"] .neon-card-wrapper')).transform
        }))));
      }
    } finally { await context.close(); }
  }
}

async function testDesktopMotion(browser, origin) {
  const { page, context, errors, unexpectedApi } = await fixturePage(browser, origin, 3, {
    viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false
  });
  try {
    for (const theme of ['crystal', 'halloween', 'christmas', 'birthday']) {
      await page.evaluate(value => applyTheme(value), theme);
      await page.waitForFunction(value => document.querySelector('#collector-world-image')?.getAttribute('src')?.includes(value === 'crystal' ? 'original' : value), theme);
      assert.equal(await page.locator('canvas').count(), 0, 'The collector design uses still artwork without a full-screen canvas');
      assert.equal(await page.evaluate(() => document.querySelector('#weather') ? getComputedStyle(document.querySelector('#weather')).display : 'none'), 'none');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 768, height: 1000 });
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(await page.locator('canvas').count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedApi, []);
    console.log('PASS desktop seasonal worlds remain static across viewport and motion preference changes');
  } finally { await context.close(); }
}

async function run() {
  if (screenshots) await fs.mkdir(screenshots, { recursive: true });
  const { server, origin } = await serve();
  let browser;
  try {
    const systemChromium = process.env.CHROMIUM_PATH ||
      (await fs.access('/usr/bin/chromium').then(() => '/usr/bin/chromium', () => undefined));
    browser = await chromium.launch({ headless: true, executablePath: systemChromium, args: ['--no-sandbox'] });
    await captureScreenshots(browser, origin);
    for (const count of [2, 3, 8]) await testCarousel(browser, origin, count);
    await testThemes(browser, origin);
    await testDesktopMotion(browser, origin);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

module.exports = { serve, fixturePage, fixtureItems };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
