# pokeballer-breaks

Static storefront with a Cloudflare Worker (`worker.js`), KV inventory and Durable Objects.

Run the storefront with `python3 -m http.server 8000`. For an isolated local API, run
`wrangler dev --local` using `wrangler.toml`. The HTML pages currently point to the
production API; browser regression tests intercept those requests with fixtures.

## Checks

Inventory authentication tests need only Node.js 24:

```sh
node tests/inventory-auth.test.mjs
```

Browser regression tests use Playwright and Chromium. Install the test tools outside
the checkout, keeping this dependency-free site's files unchanged:

```sh
npm install --prefix /tmp/pbm-browser-tests --no-audit --no-fund playwright@1.64.1
# If system Chromium is unavailable:
/tmp/pbm-browser-tests/node_modules/.bin/playwright install chromium
NODE_PATH=/tmp/pbm-browser-tests/node_modules node tests/storefront.browser.cjs
NODE_PATH=/tmp/pbm-browser-tests/node_modules node tests/collector-design.browser.cjs
```

The browser test starts its own local server and uses mock inventory. It never
submits orders or changes production data. Set `CHROMIUM_PATH` to select a custom
Chromium executable.

## Collector design

`collector.css` and `collector.js` style the main storefront and keep the featured
break connected to real stock. `collector-details.css` and `collector-details.js`
provide the accessible collectible detail sheet; purchases use the existing checkout.
The Vault has a matching, self-contained stylesheet in `vault.html`.

The existing admin theme setting chooses `crystal` (original), `halloween`,
`christmas` or `birthday`. Illustrated worlds are hosted locally in `assets/worlds/`;
responsive WebP variants keep mobile downloads smaller. The artwork is decorative;
product photography and stock come from inventory.

The Git tag `before-storefront-redesign-20261028` saves the previous appearance,
including the mobile stability and inventory authentication fixes. The collector
redesign is a separate commit so it can be reverted without removing those fixes.
Revert the redesign commit normally; avoid resetting over subsequent work.

Browser checks use sample inventory and intercept external services. Screenshots
therefore demonstrate the design, not live inventory or a real payment. Actual
iPhone Safari and real payment-provider transactions remain manual checks.

## Release

Publish `worker.js`, `admin.html` and `stock.html` together: inventory edits require
an admin session, and these clients send the login token. A previously opened admin
or stock page must be refreshed after the update. Public inventory reads remain
available without login. The storefront and seasonal CSS/JS can be published with
the other static files, including `collector*.css`, `collector*.js` and `assets/`.
