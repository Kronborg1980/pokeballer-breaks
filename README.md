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
```

The browser test starts its own local server and uses mock inventory. It never
submits orders or changes production data. Set `CHROMIUM_PATH` to select a custom
Chromium executable.

## Release

Publish `worker.js`, `admin.html` and `stock.html` together: inventory edits require
an admin session, and these clients send the login token. A previously opened admin
or stock page must be refreshed after the update. Public inventory reads remain
available without login. The storefront and seasonal CSS/JS can be published with
the other static files.
