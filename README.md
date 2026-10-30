# pokeballer-breaks

Static storefront with a Cloudflare Worker (`worker.js`), KV inventory and Durable Objects.

Run the storefront with `python3 -m http.server 8000`. For an isolated local API, run
`wrangler dev --local` using `wrangler.toml`. The HTML pages currently point to the
production API; browser regression tests intercept those requests with fixtures.

## Checks

Inventory authentication tests need only Node.js 24:

```sh
node tests/inventory-auth.test.mjs
node tests/catalog-quota.test.mjs
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

The product catalogue uses a persistent ID index in the existing SiteHub Durable
Object. Its first access migrates existing `item:` keys with a paginated KV scan;
normal browsing and stock refreshes perform no KV List calls afterward, including
after a SiteHub restart. Authenticated item edits maintain the index. Item content
is cached in SiteHub for five minutes; edits patch that cache immediately and pack
stock is still read live from OrderDesk. Use the admin/stock pages to create or
delete items; adding new KV keys directly does not update the catalogue index.

KV listing remains for the infrequent all-orders admin view and purchase-archive
cleanup when deleting an item. Durable Object `storage.list()` calls are separate
from the Workers KV List quota. Stock polling now runs at most once a minute per
visible storefront tab. Existing daily usage is not reset by this change.

Deploy the updated Worker to activate the index. If KV List is already blocked by
the quota, the initial migration must wait until listing is available again.

Deploy `worker.js` before publishing `admin.html` and `stock.html`: inventory edits
require an admin session, sent in the Authorization header. An older Worker rejects
the new clients' cross-origin preflight until it is upgraded. Session tokens stay
out of item payloads during a mixed-version rollout. A previously opened admin or
stock page must be refreshed after the update. Public inventory reads remain
available without login. Publish the storefront and all static assets, including
`cinematic-seasons.css`, `cinematic-seasons.js` and the favicon files, with the other static files.
