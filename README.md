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
NODE_PATH=/tmp/pbm-browser-tests/node_modules node tests/video-preview.browser.cjs
```

The browser test starts its own local server and uses mock inventory. It never
submits orders or changes production data. Set `CHROMIUM_PATH` to select a custom
Chromium executable.

## Original appearance

The original neon storefront and Vault have been restored from the
`before-storefront-redesign-20261028` checkpoint. Mobile stability fixes,
Authorization-header inventory protection and the video preview fallback remain.
The illustrated hybrid is saved at `before-original-restore-20261028`.

Browser checks use sample inventory and intercept external services. Screenshots
therefore demonstrate the design, not live inventory or a real payment. Actual
iPhone Safari and real payment-provider transactions remain manual checks.

## Release

Deploy `worker.js` before publishing `admin.html` and `stock.html`: inventory edits
require an admin session, sent in the Authorization header. An older Worker rejects
the new clients' cross-origin preflight until it is upgraded. Session tokens stay
out of item payloads during a mixed-version rollout. A previously opened admin or
stock page must be refreshed after the update. Public inventory reads remain
available without login. Publish the storefront and all static assets, including
`cinematic-seasons.css`, `cinematic-seasons.js` and the favicon files, with the other static files.
