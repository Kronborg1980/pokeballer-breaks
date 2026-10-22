/**
 * PBM Breaks worker — module format.
 *
 * Two Durable Objects:
 *   OrderDesk  — one per item. The only thing that may approve an order.
 *                Holds true stock, per-buyer limits, and every reservation.
 *   SiteHub    — one globally. Holds site settings, the Stripe keys, and the
 *                live alert feed for the OBS overlay.
 *
 * KV still holds item content, images, sessions and the order archive, but it
 * never decides whether an order is allowed: KV reads are cached at each edge
 * location for up to 60 seconds, so ten buyers in ten cities could all read
 * "5 in stock" at once and all be told yes. A Durable Object handles one
 * request at a time, so that cannot happen.
 *
 * Payment modes (switched in the admin panel, no redeploy):
 *   streamlabs — reservation is confirmed immediately, buyer pays on the tip
 *                page, you reconcile by order reference. (Original behaviour.)
 *   stripe     — reservation is held as PENDING, buyer pays on Stripe Checkout,
 *                and Stripe's webhook confirms it. Unpaid holds expire on their
 *                own and the stock goes back on the shelf.
 */

/* ============================================================
   ORDER DESK — the single source of truth for one item
   ============================================================ */
export class OrderDesk {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    let body = {};
    try { body = await request.json(); } catch (e) { body = {}; }

    let result;
    switch (body.op) {
      case 'reserve': result = await this.reserve(body); break;
      case 'confirm': result = await this.confirm(body); break;
      case 'refund.inspect': result = await this.refundInspect(body); break;
      case 'refund.claim': result = await this.refundClaim(body); break;
      case 'refund.record': result = await this.refundRecord(body); break;
      case 'release': result = await this.release(body); break;
      case 'lookup':  result = await this.lookup(body); break;
      case 'sync':    result = await this.sync(body); break;
      case 'state':   result = await this.readState(body); break;
      case 'orders':  result = await this.orders(); break;
      case 'clear':   result = await this.clear(body); break;
      case 'wipe':    result = await this.wipe(); break;
      default:        result = { error: 'Unknown op' };
    }
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }

  // Items created before this object existed get seeded once from KV.
  // After that the desk is authoritative and KV is only a display copy.
  async ensureInit(seed) {
    let stock = await this.state.storage.get('stock');
    let limits = await this.state.storage.get('limits');

    const writes = {};
    if (typeof stock !== 'number') {
      stock = Math.max(0, toInt(seed && seed.stock, 0));
      writes.stock = stock;
    }
    if (!limits) {
      limits = normaliseLimits(Object.assign({ type: 'pack' }, seed || {}));
      writes.limits = limits;
    }
    if (Object.keys(writes).length) await this.state.storage.put(writes);
    return { stock, limits };
  }

  /* An unpaid Stripe hold that ran out of time gives its units back and
     unlocks the email. Runs on the alarm, and again before any reservation
     so a buyer never waits on the alarm's timing. */
  async sweepExpired() {
    const now = Date.now();
    const map = await this.state.storage.list({ prefix: 'buyer:' });
    let stock = toInt(await this.state.storage.get('stock'), 0);
    let released = 0;
    let nextDue = null;

    for (const [key, rec] of map) {
      if (!rec || rec.status !== 'pending' || !rec.expiresAt) continue;
      if (now >= rec.expiresAt) {
        stock += toInt(rec.qty, 0);
        await this.state.storage.delete(key);
        if (rec.orderRef) await this.state.storage.delete('ref:' + rec.orderRef);
        released++;
      } else {
        nextDue = nextDue == null ? rec.expiresAt : Math.min(nextDue, rec.expiresAt);
      }
    }

    if (released) await this.state.storage.put('stock', Math.max(0, stock));
    if (nextDue) await this.state.storage.setAlarm(nextDue + 2000);
    return { released, stock };
  }

  async alarm() {
    await this.sweepExpired();
  }

  async reserve({ qty, email, name, address, seed, pending, holdMinutes, meta }) {
    const { limits } = await this.ensureInit(seed);
    await this.sweepExpired();

    const stock = toInt(await this.state.storage.get('stock'), 0);
    const { minBuy, maxBuy } = limits;

    if (stock <= 0) {
      return { error: 'This item is sold out.', code: 409, stock: 0, maxBuy };
    }

    const hardMax = Math.min(maxBuy, stock);
    const hardMin = Math.min(Math.max(1, minBuy), hardMax);

    if (qty < hardMin) {
      return { error: `Minimum order for this item is ${hardMin}.`, code: 400, stock, minBuy: hardMin, maxBuy: hardMax };
    }
    if (qty > hardMax) {
      const tail = stock < maxBuy ? `, and only ${stock} left in stock` : '';
      return {
        error: `Limit is ${maxBuy} per person for this item${tail}. You tried to order ${qty}.`,
        code: 400, stock, minBuy: hardMin, maxBuy: hardMax
      };
    }

    const key = 'buyer:' + email;
    const existing = await this.state.storage.get(key);
    if (existing) {
      return {
        error: existing.status === 'pending'
          ? 'You already have an order waiting for payment on this item. Finish paying, or try again in a few minutes once the hold expires.'
          : 'This email has already ordered this item. Limit is one order per email per pack type.',
        code: 409, stock, maxBuy
      };
    }

    const orderRef = makeOrderRef();
    const now = Date.now();
    const hold = Math.max(30, Math.min(1440, toInt(holdMinutes, 30)));
    const rec = Object.assign({
      orderRef, email, name, address, qty,
      status: pending ? 'pending' : 'manual',
      at: now,
      expiresAt: pending ? now + hold * 60000 : null
    }, meta || {});

    // One atomic write: the buyer lock, the ref index and the new stock all
    // land together or not at all.
    await this.state.storage.put({
      [key]: rec,
      ['ref:' + orderRef]: email,
      stock: stock - qty
    });
    if (rec.expiresAt) await this.state.storage.setAlarm(rec.expiresAt + 2000);

    return {
      ok: true, orderRef, qty, remainingStock: stock - qty,
      minBuy: hardMin, maxBuy, status: rec.status, expiresAt: rec.expiresAt
    };
  }

  // Stripe retries webhooks, so confirming twice must be harmless.
  async confirm({ orderRef, payment }) {
    const email = await this.state.storage.get('ref:' + orderRef);
    if (!email) return { ok: false, error: 'Unknown order reference.' };

    const key = 'buyer:' + email;
    const rec = await this.state.storage.get(key);
    if (!rec) return { ok: false, error: 'That hold is no longer on file.' };

    const stock = toInt(await this.state.storage.get('stock'), 0);
    if (rec.status === 'paid') return { ok: true, already: true, record: rec, stock };

    rec.status = 'paid';
    rec.expiresAt = null;
    rec.paidAt = Date.now();
    if (payment) rec.payment = payment;
    await this.state.storage.put(key, rec);

    return { ok: true, already: false, record: rec, stock };
  }

  // Refund state is stored with the order under its item-scoped Durable Object.
  // Never restore inventory automatically after a card refund: packs may already
  // have been opened, and refunds do not imply that physical goods are resellable.
  async refundInspect({ orderRef }) {
    const email = await this.state.storage.get('ref:' + orderRef);
    if (!email) return { ok: false, error: 'Order reference not found.' };
    const rec = await this.state.storage.get('buyer:' + email);
    if (!rec || rec.orderRef !== orderRef) return { ok: false, error: 'Order not found.' };
    if (['refunded', 'refund_pending', 'refund_processing', 'refund_failed'].includes(rec.status)) {
      return { ok: true, already: true, status: rec.status, refund: rec.refund || null };
    }
    if (rec.status !== 'paid' || !rec.payment || rec.payment.provider !== 'stripe' || !rec.payment.paymentIntent) {
      return { ok: false, error: 'Only paid Stripe orders with a payment intent can be refunded here.' };
    }
    return { ok: true, paymentIntent: rec.payment.paymentIntent, orderRef: rec.orderRef, status: rec.status };
  }
  async refundClaim({ orderRef }) {
    const checked = await this.refundInspect({ orderRef });
    if (!checked.ok || checked.already) return checked;
    const email = await this.state.storage.get('ref:' + orderRef);
    const key = 'buyer:' + email;
    const rec = await this.state.storage.get(key);
    if (!rec || rec.status !== 'paid') return { ok: false, error: 'Order status changed.' };
    // Once-only durable claim, even beyond Stripe's API idempotency window.
    // An uncertain refund must be reconciled manually rather than repeated.
    rec.status = 'refund_processing';
    rec.refundStartedAt = Date.now();
    await this.state.storage.put(key, rec);
    return { ok: true, paymentIntent: rec.payment.paymentIntent };
  }
  async refundRecord({ orderRef, refund }) {
    const email = await this.state.storage.get('ref:' + orderRef);
    if (!email) return { ok: false, error: 'Order no longer exists.' };
    const key = 'buyer:' + email;
    const rec = await this.state.storage.get(key);
    if (!rec || rec.orderRef !== orderRef) return { ok: false, error: 'Order mismatch.' };
    if (['refunded', 'refund_pending', 'refund_processing', 'refund_failed'].includes(rec.status)) {
      return { ok: true, already: true, status: rec.status, refund: rec.refund };
    }
    if (!['refund_processing', 'refund_pending', 'refunded'].includes(rec.status)) return { ok: false, error: 'Refund request was not claimed.' };
    if (!refund || !refund.id) return { ok: false, error: 'Refund receipt missing.' };
    rec.status = refund.status === 'succeeded' ? 'refunded' : refund.status === 'failed' || refund.status === 'canceled' ? 'refund_failed' : 'refund_pending';
    rec.refund = { id: refund.id, status: refund.status, amount: refund.amount, currency: refund.currency, at: Date.now() };
    await this.state.storage.put(key, rec);
    return { ok: true, status: rec.status, refund: rec.refund };
  }

  async release({ orderRef, email, restoreStock = true, onlyIfPending = false }) {
    let addr = email ? String(email).trim().toLowerCase() : null;
    if (!addr && orderRef) addr = await this.state.storage.get('ref:' + orderRef);
    if (!addr) return { ok: true, cleared: 0 };

    const key = 'buyer:' + addr;
    const rec = await this.state.storage.get(key);
    if (!rec) return { ok: true, cleared: 0 };
    if (onlyIfPending && rec.status !== 'pending') return { ok: true, cleared: 0, skipped: 'already ' + rec.status };

    await this.state.storage.delete(key);
    if (rec.orderRef) await this.state.storage.delete('ref:' + rec.orderRef);

    let restored = 0;
    if (restoreStock) {
      const stock = toInt(await this.state.storage.get('stock'), 0);
      restored = toInt(rec.qty, 0);
      await this.state.storage.put('stock', Math.max(0, stock + restored));
    }
    return { ok: true, cleared: 1, restored, email: addr };
  }

  async lookup({ orderRef }) {
    const email = await this.state.storage.get('ref:' + orderRef);
    if (!email) return { found: false };
    const rec = await this.state.storage.get('buyer:' + email);
    if (!rec) return { found: false };
    return {
      found: true, status: rec.status, qty: rec.qty, orderRef: rec.orderRef,
      itemName: rec.itemName || null, total: rec.total || null, unit: rec.stockLabelType || 'packs'
    };
  }

  // Saving an item in the admin panel is what (re)stocks the desk.
  async sync({ stock, minBuy, maxBuy, type }) {
    const limits = normaliseLimits({ type: type || 'pack', minBuy, maxBuy });
    const writes = { limits };
    if (stock !== undefined && stock !== null) writes.stock = Math.max(0, toInt(stock, 0));
    await this.state.storage.put(writes);
    const current = await this.state.storage.get('stock');
    return { ok: true, stock: typeof current === 'number' ? current : null, limits };
  }

  async readState({ seed }) {
    let stock = await this.state.storage.get('stock');
    let limits = await this.state.storage.get('limits');
    if (typeof stock !== 'number' && seed) {
      const init = await this.ensureInit(seed);
      stock = init.stock; limits = init.limits;
    }
    await this.sweepExpired();
    stock = await this.state.storage.get('stock');
    return { stock: typeof stock === 'number' ? stock : null, limits: limits || null };
  }

  async orders() {
    await this.sweepExpired();
    const map = await this.state.storage.list({ prefix: 'buyer:' });
    const records = [];
    map.forEach(v => records.push(v));
    records.sort((a, b) => (b.at || 0) - (a.at || 0));
    return { orders: records };
  }

  async clear({ email, restoreStock }) {
    if (!email) {
      const map = await this.state.storage.list({ prefix: 'buyer:' });
      const keys = [...map.keys()];
      for (const k of keys) await this.state.storage.delete(k);
      const refs = await this.state.storage.list({ prefix: 'ref:' });
      for (const k of refs.keys()) await this.state.storage.delete(k);
      return { ok: true, cleared: keys.length };
    }
    return this.release({ email, restoreStock: !!restoreStock });
  }

  async wipe() {
    await this.state.storage.deleteAll();
    return { ok: true };
  }
}

/* ============================================================
   SITE HUB — settings, Stripe keys, and the live alert feed
   ============================================================ */
export class SiteHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Overlay connects here and is pushed alerts as they happen.
    if (url.pathname.endsWith('/ws')) {
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      server.accept();
      this.sockets.add(server);
      server.addEventListener('close', () => this.sockets.delete(server));
      server.addEventListener('error', () => this.sockets.delete(server));
      const seq = toInt(await this.state.storage.get('seq'), 0);
      try { server.send(JSON.stringify({ type: 'hello', seq })); } catch (e) { /* socket already gone */ }
      return new Response(null, { status: 101, webSocket: client });
    }

    let body = {};
    try { body = await request.json(); } catch (e) { body = {}; }

    let result;
    switch (body.op) {
      case 'settings.get': result = await this.getSettings(); break;
      case 'settings.put': result = await this.putSettings(body.settings); break;
      case 'secrets.get':  result = await this.getSecrets(); break;
      case 'secrets.put':  result = await this.putSecrets(body.secrets); break;
      case 'alert.push':   result = await this.pushAlert(body.alert); break;
      case 'alert.since':  result = await this.alertsSince(toInt(body.seq, 0)); break;
      default:             result = { error: 'Unknown op' };
    }
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }

  async getSettings() {
    const stored = await this.state.storage.get('settings');
    return Object.assign({}, DEFAULT_SETTINGS, stored || {});
  }

  async putSettings(incoming) {
    const current = await this.getSettings();
    const next = Object.assign({}, current);
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (incoming && Object.prototype.hasOwnProperty.call(incoming, key)) next[key] = incoming[key];
    }
    next.paymentMode = next.paymentMode === 'stripe' ? 'stripe' : 'streamlabs';
    const THEMES = ['crystal', 'birthday', 'halloween', 'christmas'];
    if (THEMES.indexOf(next.theme) === -1) next.theme = 'crystal';
    next.holdMinutes = Math.max(30, Math.min(1440, toInt(next.holdMinutes, 30)));
    next.currency = String(next.currency || 'usd').toLowerCase().slice(0, 3);
    if (!next.overlayToken) next.overlayToken = makeToken();
    await this.state.storage.put('settings', next);
    return { ok: true, settings: next };
  }

  async getSecrets() {
    return (await this.state.storage.get('secrets')) || {};
  }

  // Empty string means "leave the stored value alone", so the admin can save
  // the rest of the form without retyping keys it never shows back.
  async putSecrets(incoming) {
    const current = await this.getSecrets();
    const next = Object.assign({}, current);
    for (const key of ['stripeSecretKey', 'stripeWebhookSecret', 'streamlabsToken']) {
      if (!incoming || incoming[key] === undefined) continue;
      const val = String(incoming[key] || '').trim();
      if (val === '__CLEAR__') delete next[key];
      else if (val) next[key] = val;
    }
    await this.state.storage.put('secrets', next);
    return { ok: true, saved: Object.keys(next) };
  }

  async pushAlert(alert) {
    const seq = toInt(await this.state.storage.get('seq'), 0) + 1;
    const entry = Object.assign({ seq, at: Date.now() }, alert || {});
    const recent = (await this.state.storage.get('recent')) || [];
    recent.push(entry);
    while (recent.length > 40) recent.shift();
    await this.state.storage.put({ seq, recent });

    let delivered = 0;
    const payload = JSON.stringify({ type: 'alert', alert: entry });
    for (const ws of [...this.sockets]) {
      try { ws.send(payload); delivered++; } catch (e) { this.sockets.delete(ws); }
    }
    return { ok: true, seq, delivered, listeners: this.sockets.size };
  }

  async alertsSince(seq) {
    const recent = (await this.state.storage.get('recent')) || [];
    return { alerts: recent.filter(a => toInt(a.seq, 0) > seq), seq: toInt(await this.state.storage.get('seq'), 0) };
  }
}

/* ============================================================
   WORKER
   ============================================================ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const baseUrl = url.origin;

    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (method === 'OPTIONS') return new Response(null, { headers });

    try {
      // 1. YouTube Feed Proxy
      if (path === '/api/youtube' && method === 'GET') {
        const channelId = "UCdFYy9uChCNAWbvVhTYwHaQ";
        const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}&t=${Date.now()}`;
        const ytResponse = await fetch(feedUrl);
        const text = await ytResponse.text();
        return new Response(text, { headers: { ...headers, 'Content-Type': 'application/xml' } });
      }

      if (!env.POKEBALLER_KV) {
        return new Response(JSON.stringify({ error: "KV namespace not bound." }), { status: 500, headers });
      }
      const KV = env.POKEBALLER_KV;
      const requireAdmin = async token => (token ? await KV.get(`session:${token}`) : null);

      /* ---------- OVERLAY WEBSOCKET (must come before anything that reads a body) ---------- */
      if (path === '/api/alerts/ws') {
        const settings = await hubCall(env, { op: 'settings.get' });
        const token = url.searchParams.get('token') || '';
        if (!settings.overlayToken || token !== settings.overlayToken) {
          return new Response('Bad overlay token', { status: 401 });
        }
        if (request.headers.get('Upgrade') !== 'websocket') {
          return new Response('Expected a websocket upgrade', { status: 426 });
        }
        const id = env.SITE_HUB.idFromName('site');
        return env.SITE_HUB.get(id).fetch('https://hub.internal/ws', request);
      }

      // Catch-up feed for an overlay that just reconnected.
      if (path === '/api/alerts/since' && method === 'GET') {
        const settings = await hubCall(env, { op: 'settings.get' });
        const token = url.searchParams.get('token') || '';
        if (!settings.overlayToken || token !== settings.overlayToken) {
          return new Response(JSON.stringify({ error: 'Bad overlay token' }), { status: 401, headers });
        }
        const res = await hubCall(env, { op: 'alert.since', seq: toInt(url.searchParams.get('seq'), 0) });
        return new Response(JSON.stringify(res), { headers });
      }

      /* ---------- STRIPE WEBHOOK (raw body, no CORS) ---------- */
      if (path === '/api/stripe-webhook' && method === 'POST') {
        const raw = await request.text();
        const secrets = await hubCall(env, { op: 'secrets.get' });
        const whSecret = env.STRIPE_WEBHOOK_SECRET || secrets.stripeWebhookSecret;
        if (!whSecret) return new Response('Webhook secret not configured', { status: 500 });

        const verdict = await verifyStripeSignature(raw, request.headers.get('Stripe-Signature'), whSecret);
        if (!verdict.ok) return new Response('Signature check failed: ' + verdict.reason, { status: 400 });

        let event;
        try { event = JSON.parse(raw); } catch (e) { return new Response('Bad JSON', { status: 400 }); }

        // Answer Stripe immediately; do the work after, so a slow email never
        // makes Stripe think the webhook failed and retry it.
        ctx.waitUntil(handleStripeEvent(env, event).catch(err => console.error('stripe event', err)));
        return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      /* ---------- PUBLIC SETTINGS (what the storefront is allowed to know) ---------- */
      if (path === '/api/settings' && method === 'GET') {
        const s = await hubCall(env, { op: 'settings.get' });
        const secrets = await hubCall(env, { op: 'secrets.get' });
        return new Response(JSON.stringify({
          paymentMode: s.paymentMode,
          tipUrl: s.tipUrl,
          currency: s.currency,
          holdMinutes: s.holdMinutes,
          refInstructions: s.refInstructions,
          theme: s.theme || 'crystal',
          featuredVideoUrl: s.featuredVideoUrl || '',
          featuredVideoTitle: s.featuredVideoTitle || '',
          stripeReady: !!(env.STRIPE_SECRET_KEY || secrets.stripeSecretKey)
        }), { headers });
      }

      /* ---------- STRIPE CHECKOUT ---------- */
      if (path === '/api/checkout' && method === 'POST') {
        const data = await request.json();
        const settings = await hubCall(env, { op: 'settings.get' });
        const secrets = await hubCall(env, { op: 'secrets.get' });
        const stripeKey = env.STRIPE_SECRET_KEY || secrets.stripeSecretKey;

        if (settings.paymentMode !== 'stripe') {
          return new Response(JSON.stringify({ error: 'Card checkout is switched off right now.' }), { status: 409, headers });
        }
        if (!stripeKey) {
          return new Response(JSON.stringify({ error: 'Card checkout is not finished setting up yet.' }), { status: 503, headers });
        }

        const vetted = await vetOrderRequest(env, KV, data);
        if (vetted.error) return new Response(JSON.stringify({ error: vetted.error }), { status: vetted.code || 400, headers });
        const { item, qty, buyerEmail, buyerName, buyerAddress } = vetted;

        const unitPrice = Number(item.price) || 0;
        const unitAmount = Math.round(unitPrice * 100);
        if (unitAmount < 50) {
          return new Response(JSON.stringify({ error: 'This item is priced too low for card checkout.' }), { status: 400, headers });
        }

        const reserved = await deskCall(env, item.id, {
          op: 'reserve',
          qty, email: buyerEmail, name: buyerName, address: buyerAddress,
          pending: true,
          holdMinutes: settings.holdMinutes,
          seed: { type: 'pack', stock: item.stock, minBuy: item.minBuy, maxBuy: item.maxBuy },
          meta: {
            itemId: item.id, itemName: item.name || '',
            unitPrice, total: (unitPrice * qty).toFixed(2),
            stockLabelType: item.stockLabelType || 'packs',
            notifyEmail: settings.notifyEmail
          }
        });
        if (!reserved || !reserved.ok) {
          return new Response(JSON.stringify({
            error: (reserved && reserved.error) || 'Could not hold this order.',
            stock: reserved && reserved.stock, maxBuy: reserved && reserved.maxBuy
          }), { status: (reserved && reserved.code) || 409, headers });
        }

        const store = (settings.storeUrl || request.headers.get('Origin') || 'https://pbmbreaks.com').replace(/\/+$/, '');
        const q = `ref=${encodeURIComponent(reserved.orderRef)}&item=${encodeURIComponent(item.id)}`;
        const params = {
          mode: 'payment',
          success_url: `${store}?paid=1&${q}`,
          cancel_url: `${store}?canceled=1&${q}`,
          customer_email: buyerEmail,
          client_reference_id: reserved.orderRef,
          expires_at: Math.floor((reserved.expiresAt || (Date.now() + 1800000)) / 1000),
          'line_items[0][quantity]': qty,
          'line_items[0][price_data][currency]': settings.currency || 'usd',
          'line_items[0][price_data][unit_amount]': unitAmount,
          'line_items[0][price_data][product_data][name]': String(item.name || 'PBM Breaks order').slice(0, 250),
          'metadata[orderRef]': reserved.orderRef,
          'metadata[itemId]': item.id,
          'metadata[qty]': String(qty),
          'metadata[buyerName]': buyerName.slice(0, 120),
          'metadata[shipTo]': buyerAddress.slice(0, 480)
        };
        if (item.description) {
          params['line_items[0][price_data][product_data][description]'] = String(item.description).slice(0, 250);
        }

        const session = await stripePost(stripeKey, '/v1/checkout/sessions', params);
        if (!session.ok || !session.json || !session.json.url) {
          // Payment page never opened, so give the units straight back.
          await deskCall(env, item.id, { op: 'release', orderRef: reserved.orderRef, restoreStock: true });
          const detail = session.json && session.json.error ? session.json.error.message : `HTTP ${session.status}`;
          return new Response(JSON.stringify({ error: 'Stripe refused the checkout: ' + detail }), { status: 502, headers });
        }

        return new Response(JSON.stringify({
          ok: true, url: session.json.url, orderRef: reserved.orderRef,
          qty, total: (unitPrice * qty).toFixed(2), remainingStock: reserved.remainingStock
        }), { headers });
      }

      /* ---------- ORDER STATUS (the success page polls this) ---------- */
      if (path === '/api/order-status' && method === 'GET') {
        const ref = url.searchParams.get('ref');
        const itemId = url.searchParams.get('item');
        if (!ref || !itemId) return new Response(JSON.stringify({ error: 'ref and item are required' }), { status: 400, headers });
        const res = await deskCall(env, itemId, { op: 'lookup', orderRef: ref });
        return new Response(JSON.stringify(res), { headers });
      }

      /* ---------- EMAIL SELF-TEST ---------- */
      if (path === '/api/email-test' && method === 'GET') {
        if (!env.RESEND_API_KEY) {
          return new Response(JSON.stringify({
            ok: false,
            reason: 'RESEND_API_KEY is not bound to this worker deployment.',
            fix: 'Cloudflare dashboard > your Worker > Settings > Variables and Secrets > add RESEND_API_KEY'
          }), { status: 500, headers });
        }
        const settings = await hubCall(env, { op: 'settings.get' });
        const result = await sendEmail(env, {
          to: [settings.notifyEmail || 'michael.lorenz.10@gmail.com'],
          subject: 'PBM Breaks worker email test',
          html: '<p>If you are reading this, Resend is working and the order emails can go out.</p>'
        });
        return new Response(JSON.stringify(result), { status: result.ok ? 200 : 502, headers });
      }

      /* ---------- DESK CHECK ---------- */
      if (path === '/api/desk' && method === 'GET') {
        const itemId = url.searchParams.get('itemId');
        if (!itemId) return new Response(JSON.stringify({ error: 'itemId required' }), { status: 400, headers });
        const item = await KV.get(itemId, 'json');
        const state = await deskCall(env, itemId, { op: 'state', seed: item || null });
        return new Response(JSON.stringify({ itemId, kvStock: item ? item.stock : null, desk: state }), { headers });
      }

      /* ---------- ADMIN: SETTINGS ---------- */
      if (path === '/api/admin/settings' && method === 'GET') {
        if (!await requireAdmin(url.searchParams.get('token'))) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
        }
        const settings = await hubCall(env, { op: 'settings.get' });
        const secrets = await hubCall(env, { op: 'secrets.get' });
        return new Response(JSON.stringify({
          settings,
          webhookUrl: `${baseUrl}/api/stripe-webhook`,
          overlayUrl: `${baseUrl}/api/alerts/ws?token=${encodeURIComponent(settings.overlayToken || '')}`,
          status: {
            stripeKey: describeSecret(env.STRIPE_SECRET_KEY, secrets.stripeSecretKey),
            webhookSecret: describeSecret(env.STRIPE_WEBHOOK_SECRET, secrets.stripeWebhookSecret),
            streamlabsToken: describeSecret(null, secrets.streamlabsToken),
            resend: env.RESEND_API_KEY ? { set: true, source: 'cloudflare', hint: 'configured' } : { set: false, source: null, hint: 'not set' }
          }
        }), { headers });
      }

      if (path === '/api/admin/settings' && method === 'POST') {
        const body = await request.json();
        if (!await requireAdmin(body.token)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
        }
        const saved = await hubCall(env, { op: 'settings.put', settings: body.settings || {} });
        if (body.secrets) await hubCall(env, { op: 'secrets.put', secrets: body.secrets });
        const secrets = await hubCall(env, { op: 'secrets.get' });
        return new Response(JSON.stringify({
          ok: true,
          settings: saved.settings,
          overlayUrl: `${baseUrl}/api/alerts/ws?token=${encodeURIComponent(saved.settings.overlayToken || '')}`,
          status: {
            stripeKey: describeSecret(env.STRIPE_SECRET_KEY, secrets.stripeSecretKey),
            webhookSecret: describeSecret(env.STRIPE_WEBHOOK_SECRET, secrets.stripeWebhookSecret),
            streamlabsToken: describeSecret(null, secrets.streamlabsToken)
          }
        }), { headers });
      }

      /* ---------- ADMIN: CHECK THE STRIPE KEY ACTUALLY WORKS ---------- */
      if (path === '/api/admin/stripe-check' && method === 'GET') {
        if (!await requireAdmin(url.searchParams.get('token'))) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
        }
        const secrets = await hubCall(env, { op: 'secrets.get' });
        const key = env.STRIPE_SECRET_KEY || secrets.stripeSecretKey;
        if (!key) return new Response(JSON.stringify({ ok: false, reason: 'No Stripe secret key saved yet.' }), { headers });

        const res = await stripeGet(key, '/v1/balance');
        if (!res.ok) {
          const detail = res.json && res.json.error ? res.json.error.message : `HTTP ${res.status}`;
          return new Response(JSON.stringify({ ok: false, reason: detail }), { headers });
        }
        return new Response(JSON.stringify({
          ok: true,
          livemode: !!(res.json && res.json.livemode),
          keyKind: key.startsWith('rk_') ? 'restricted' : 'secret',
          testMode: key.includes('_test_')
        }), { headers });
      }

      /* ---------- ADMIN: TEST ALERT ---------- */
      if (path === '/api/admin/test-alert' && method === 'POST') {
        const body = await request.json();
        if (!await requireAdmin(body.token)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
        }
        const report = await fireAlert(env, {
          kind: 'test',
          name: 'Test Buyer',
          qty: 2,
          unit: 'bundles',
          itemName: 'Test Drop',
          amount: '90.00',
          ref: 'PBM-TEST01'
        });
        return new Response(JSON.stringify(report), { headers });
      }

      /* ---------- IMAGE SERVING ---------- */
      if (path.startsWith('/api/image/') && method === 'GET') {
        const imgId = path.split('/').pop();
        const dataUrl = await KV.get(imgId);
        if (!dataUrl) return new Response('Image not found', { status: 404 });

        const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) return new Response('Invalid image', { status: 500 });

        const mimeType = matches[1];
        const binaryString = atob(matches[2]);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

        return new Response(bytes.buffer, {
          headers: {
            'Content-Type': mimeType,
            'Cache-Control': 'public, max-age=31536000',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      async function processImages(imagesArray) {
        const processed = [];
        if (!imagesArray) return processed;
        for (const imgStr of imagesArray) {
          if (imgStr.startsWith('data:image')) {
            const imgId = `img_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            await KV.put(imgId, imgStr);
            processed.push(`${baseUrl}/api/image/${imgId}`);
          } else {
            processed.push(imgStr);
          }
        }
        return processed;
      }

      /* ---------- ADMIN LOGIN ---------- */
      if (path === '/api/login' && method === 'POST') {
        const { username, password } = await request.json();
        const storedUser = await KV.get(`admin:${username}`, 'json');
        if (storedUser && storedUser.password === password) {
          const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
          await KV.put(`session:${token}`, JSON.stringify({ user: username, created: Date.now() }), { expirationTtl: 60 * 60 * 24 * 30 });
          return new Response(JSON.stringify({ success: true, token }), { headers });
        }
        return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401, headers });
      }

      /* ---------- CLICK TRACKING ---------- */
      if (path === '/api/click' && method === 'POST') {
        const { id } = await request.json();
        const item = await KV.get(id, 'json');
        if (item) {
          item.clickCount = (item.clickCount || 0) + 1;
          await KV.put(id, JSON.stringify(item));
          return new Response(JSON.stringify({ success: true, count: item.clickCount }), { headers });
        }
        return new Response(JSON.stringify({ error: 'Item not found' }), { status: 404, headers });
      }

      /* ---------- WINNER EMAILS ---------- */
      if (path === '/api/notify-winners' && method === 'POST') {
        if (!env.RESEND_API_KEY) {
          return new Response(JSON.stringify({ error: 'RESEND_API_KEY secret is not set on the worker.' }), { status: 500, headers });
        }
        const { token, breakName, paymentLink, price, emails, message } = await request.json();
        if (!await requireAdmin(token)) {
          return new Response(JSON.stringify({ error: 'Unauthorized — log out and log in again' }), { status: 401, headers });
        }
        if (!Array.isArray(emails) || emails.length === 0 || emails.length > 100) {
          return new Response(JSON.stringify({ error: 'Provide 1-100 winner emails' }), { status: 400, headers });
        }
        if (!paymentLink || !/^https:\/\/[^\s"'<>]+$/.test(paymentLink)) {
          return new Response(JSON.stringify({ error: 'Payment link must be a clean https:// URL' }), { status: 400, headers });
        }
        if (!breakName || String(breakName).length > 200) {
          return new Response(JSON.stringify({ error: 'Missing or too-long break name' }), { status: 400, headers });
        }

        const settings = await hubCall(env, { op: 'settings.get' });
        const clean = [...new Set(emails.map(e => String(e).trim().toLowerCase()).filter(isEmail))];
        const sent = [], failed = [];
        for (const to of clean) {
          const result = await sendEmail(env, {
            to: [to],
            replyTo: settings.notifyEmail,
            subject: `🎉 You've been picked — ${breakName}`,
            html: winnerEmailHTML({ breakName, paymentLink, price, message, contact: settings.publicContactEmail })
          });
          if (result.ok) sent.push(to);
          else failed.push({ to, status: result.status, detail: result.detail });
        }
        return new Response(JSON.stringify({ sent, failed }), { headers });
      }

      /* ============================================================
         PACK ORDER — Streamlabs mode. Every limit is decided by the desk.
         ============================================================ */
      if (path === '/api/purchase-notification' && method === 'POST') {
        const data = await request.json();
        const settings = await hubCall(env, { op: 'settings.get' });

        const vetted = await vetOrderRequest(env, KV, data);
        if (vetted.error) return new Response(JSON.stringify({ error: vetted.error }), { status: vetted.code || 400, headers });
        const { item, qty, buyerEmail, buyerName, buyerAddress } = vetted;

        const unitPrice = Number(item.price) || 0;
        const serverTotal = (unitPrice * qty).toFixed(2);

        const reserved = await deskCall(env, item.id, {
          op: 'reserve',
          qty, email: buyerEmail, name: buyerName, address: buyerAddress,
          pending: false,
          seed: { type: 'pack', stock: item.stock, minBuy: item.minBuy, maxBuy: item.maxBuy },
          meta: {
            itemId: item.id, itemName: item.name || '',
            unitPrice, total: serverTotal,
            stockLabelType: item.stockLabelType || 'packs',
            notifyEmail: settings.notifyEmail
          }
        });

        if (!reserved || !reserved.ok) {
          return new Response(JSON.stringify({
            error: (reserved && reserved.error) || 'Could not reserve this order.',
            stock: reserved && reserved.stock,
            minBuy: reserved && reserved.minBuy,
            maxBuy: reserved && reserved.maxBuy
          }), { status: (reserved && reserved.code) || 409, headers });
        }

        const { orderRef, remainingStock } = reserved;

        item.stock = remainingStock;
        ctx.waitUntil(KV.put(item.id, JSON.stringify(item)));
        ctx.waitUntil(KV.put(`purchase:${item.id}:${buyerEmail}`, JSON.stringify({
          orderRef, itemId: item.id, itemName: item.name || '', email: buyerEmail,
          name: buyerName, address: buyerAddress, qty, unitPrice, total: serverTotal, at: Date.now()
        })));

        let emailStatus;
        if (!env.RESEND_API_KEY) {
          emailStatus = 'RESEND_API_KEY is not bound to this worker deployment';
        } else {
          const result = await sendEmail(env, {
            to: [data.notifyEmail || settings.notifyEmail],
            replyTo: buyerEmail,
            subject: `📦 NEW ORDER ${orderRef}: ${qty}x ${item.name || ''}`,
            html: purchaseEmailHTML({
              orderRef, itemName: item.name || '', qty,
              unitPrice: unitPrice.toFixed(2), totalPrice: serverTotal,
              clientTotal: String(data.totalPrice || ''),
              buyerName, buyerEmail, buyerAddress,
              remainingStock, maxBuy: reserved.maxBuy,
              stockLabelType: item.stockLabelType,
              paidVia: 'Streamlabs tip — verify the money arrived before shipping'
            })
          });
          emailStatus = result.ok ? 'sent' : `failed (${result.status}): ${result.detail}`;
        }

        ctx.waitUntil(fireAlert(env, {
          kind: 'order',
          name: buyerName, qty,
          unit: unitWordFor(item.stockLabelType, qty),
          itemName: item.name || '', amount: serverTotal, ref: orderRef
        }).catch(() => {}));

        return new Response(JSON.stringify({
          success: true, orderRef, qty, total: serverTotal, remainingStock, emailStatus
        }), { headers });
      }

      /* ---------- ADMIN: LIST ORDERS ---------- */
      if (path === '/api/purchases' && method === 'GET') {
        if (!await requireAdmin(url.searchParams.get('token'))) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
        }
        const wantedItem = url.searchParams.get('itemId');
        if (wantedItem) {
          const res = await deskCall(env, wantedItem, { op: 'orders' });
          return new Response(JSON.stringify(res.orders || []), { headers });
        }
        const { keys } = await KV.list({ prefix: 'purchase:' });
        const records = [];
        for (const key of keys) {
          const rec = await KV.get(key.name, 'json');
          if (rec) records.push(rec);
        }
        records.sort((a, b) => (b.at || 0) - (a.at || 0));
        return new Response(JSON.stringify(records), { headers });
      }

      /* ---------- ADMIN: FULL STRIPE REFUND ---------- */
      if (path === '/api/purchases/refund' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (!await requireAdmin(body.token)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
        }
        const itemId = String(body.itemId || '').trim();
        const orderRef = String(body.orderRef || '').trim();
        if (!itemId || !/^PBM-[A-Z0-9]{6}$/.test(orderRef) || body.confirmOrderRef !== orderRef) {
          return new Response(JSON.stringify({ error: 'Re-enter the exact order reference to confirm the full refund.' }), { status: 400, headers });
        }
        const check = await deskCall(env, itemId, { op: 'refund.claim', orderRef });
        if (!check || !check.ok) {
          return new Response(JSON.stringify({ error: check?.error || 'Order not eligible for card refund.' }), { status: 409, headers });
        }
        if (check.already) {
          return new Response(JSON.stringify({ ok: true, already: true, status: check.status, refund: check.refund }), { headers });
        }
        const secrets = await hubCall(env, { op: 'secrets.get' });
        const key = env.STRIPE_SECRET_KEY || secrets.stripeSecretKey;
        if (!key) return new Response(JSON.stringify({ error: 'Stripe key is not configured.' }), { status: 503, headers });

        // Stripe idempotency is permanent at PBM's reference level: retries of
        // the same refund request cannot create multiple card refunds.
        const refundBody = new URLSearchParams({
          payment_intent: check.paymentIntent,
          reason: 'requested_by_customer',
          'metadata[pbmOrderRef]': orderRef,
          'metadata[pbmItemId]': itemId
        });
        let refundResponse;
        try {
          const response = await fetch('https://api.stripe.com/v1/refunds', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + key,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Idempotency-Key': 'pbm-full-refund-' + orderRef
            },
            body: refundBody
          });
          refundResponse = { ok: response.ok, json: await response.json().catch(() => null), status: response.status };
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Stripe request status unknown. Check the Stripe dashboard before retrying.', detail: String(e) }), { status: 502, headers });
        }
        if (!refundResponse.ok || !refundResponse.json?.id) {
          return new Response(JSON.stringify({
            error: 'Stripe did not accept the refund. Verify permissions and refund balance.',
            detail: refundResponse.json?.error?.message || 'HTTP ' + refundResponse.status
          }), { status: 502, headers });
        }
        const refund = refundResponse.json;
        const recorded = await deskCall(env, itemId, {
          op: 'refund.record', orderRef,
          refund: { id: refund.id, status: refund.status, amount: refund.amount, currency: refund.currency }
        });
        if (!recorded?.ok) {
          return new Response(JSON.stringify({
            error: 'Stripe accepted the refund but PBM could not update the order record. Reconcile this refund in Stripe.',
            refundId: refund.id
          }), { status: 500, headers });
        }
        // The original inventory remains consumed. Any restock must be handled
        // separately only after checking physical packs and fulfillment.
        return new Response(JSON.stringify({ ok: true, status: recorded.status, refund: recorded.refund }), { headers });
      }

      /* ---------- ADMIN: CLEAR AN ORDER LOCK ---------- */
      if (path === '/api/purchases/clear' && method === 'POST') {
        const { token, itemId, email, restoreStock } = await request.json();
        if (!await requireAdmin(token)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
        }
        if (!itemId) return new Response(JSON.stringify({ error: 'itemId is required' }), { status: 400, headers });

        // Never erase financial evidence by resetting a Stripe-paid/refunded order.
        // Reset controls are for pending/manual buyer locks, not financial refunds.
        if (email) {
          const existing = await deskCall(env, itemId, { op: 'orders' });
          const match = (existing.orders || []).find(x => String(x.email).toLowerCase() === String(email).trim().toLowerCase());
          if (match && ['paid', 'refunded', 'refund_pending', 'refund_processing'].includes(match.status)) {
            return new Response(JSON.stringify({ error: 'Paid/refunded Stripe orders cannot be cleared. Keep the audit record; use Refund instead.' }), { status: 409, headers });
          }
        } else {
          const existing = await deskCall(env, itemId, { op: 'orders' });
          if ((existing.orders || []).some(x => ['paid', 'refunded', 'refund_pending', 'refund_processing'].includes(x.status))) {
            return new Response(JSON.stringify({ error: 'Bulk reset is blocked for items with paid/refunded orders.' }), { status: 409, headers });
          }
        }
        const res = await deskCall(env, itemId, { op: 'clear', email, restoreStock: !!restoreStock });
        if (email) await KV.delete(`purchase:${itemId}:${String(email).trim().toLowerCase()}`);
        return new Response(JSON.stringify(res), { headers });
      }

      /* ---------- ITEMS ---------- */
      if (path === '/api/items' && method === 'GET') {
        const { keys } = await KV.list({ prefix: 'item:' });
        const items = [];
        for (const key of keys) {
          const item = await KV.get(key.name, 'json');
          if (item) items.push(item);
        }
        const packs = items.filter(i => i.type === 'pack');
        await Promise.all(packs.map(async p => {
          try {
            const st = await deskCall(env, p.id, {
              op: 'state',
              seed: { type: 'pack', stock: p.stock, minBuy: p.minBuy, maxBuy: p.maxBuy }
            });
            if (st && typeof st.stock === 'number') p.stock = st.stock;
            if (st && st.limits) { p.minBuy = st.limits.minBuy; p.maxBuy = st.limits.maxBuy; }
          } catch (e) { /* fall back to the KV copy */ }
        }));
        return new Response(JSON.stringify(items), { headers });
      }

      if (path === '/api/items' && method === 'POST') {
        const body = await request.json();
        const itemId = `item:${Date.now()}`;

        const finalImages = await processImages(body.images || []);
        const finalImage = finalImages.length > 0 ? finalImages[0] : '';
        const limits = normaliseLimits(body);

        const newItem = {
          ...body,
          id: itemId,
          image: finalImage,
          images: finalImages,
          createdAt: body.createdAt || Date.now(),
          clickCount: 0,
          goLiveTime: body.goLiveTime || null,
          stockLabelType: body.stockLabelType || 'packs',
          minBuy: limits.minBuy,
          maxBuy: limits.maxBuy
        };

        await KV.put(itemId, JSON.stringify(newItem));
        if (newItem.type === 'pack') {
          await deskCall(env, itemId, { op: 'sync', type: 'pack', stock: newItem.stock, minBuy: limits.minBuy, maxBuy: limits.maxBuy });
        }
        return new Response(JSON.stringify({ success: true, item: newItem }), { headers });
      }

      if (path.startsWith('/api/items/') && method === 'PUT') {
        const itemId = path.split('/').pop();
        const body = await request.json();
        const existing = await KV.get(itemId, 'json');
        if (!existing) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });

        const finalImages = await processImages(body.images || []);
        const finalImage = finalImages.length > 0 ? finalImages[0] : '';
        const limits = normaliseLimits({ ...existing, ...body });

        const updatedItem = {
          ...existing,
          ...body,
          image: finalImage,
          images: finalImages,
          id: itemId,
          goLiveTime: body.goLiveTime !== undefined ? body.goLiveTime : existing.goLiveTime,
          stockLabelType: body.stockLabelType || existing.stockLabelType || 'packs',
          minBuy: limits.minBuy,
          maxBuy: limits.maxBuy
        };

        await KV.put(itemId, JSON.stringify(updatedItem));
        if (updatedItem.type === 'pack') {
          await deskCall(env, itemId, { op: 'sync', type: 'pack', stock: updatedItem.stock, minBuy: limits.minBuy, maxBuy: limits.maxBuy });
        }
        return new Response(JSON.stringify({ success: true, item: updatedItem }), { headers });
      }

      if (path.startsWith('/api/items/') && method === 'DELETE') {
        const itemId = path.split('/').pop();
        await KV.delete(itemId);
        const { keys } = await KV.list({ prefix: `purchase:${itemId}:` });
        for (const key of keys) await KV.delete(key.name);
        try { await deskCall(env, itemId, { op: 'wipe' }); } catch (e) { /* nothing to wipe */ }
        return new Response(JSON.stringify({ success: true }), { status: 200, headers });
      }

      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });

    } catch (e) {
      console.error(e);
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }
};

/* ============================================================
   STRIPE EVENT HANDLING
   ============================================================ */
async function handleStripeEvent(env, event) {
  const type = event && event.type;
  const obj = event && event.data && event.data.object;
  if (!obj) return;
  // Stripe can report refund status transitions asynchronously.
  if (type === 'refund.updated' || type === 'refund.failed') {
    const orderRef = obj.metadata && obj.metadata.pbmOrderRef;
    const itemId = obj.metadata && obj.metadata.pbmItemId;
    if (!orderRef || !itemId) return;
    const r = await deskCall(env, itemId, {
      op: 'refund.record', orderRef,
      refund: { id: obj.id, status: obj.status, amount: obj.amount, currency: obj.currency }
    });
    if (!r || !r.ok) throw new Error('Could not reconcile Stripe refund ' + obj.id);
    return;
  }

  const orderRef = (obj.metadata && obj.metadata.orderRef) || obj.client_reference_id;
  const itemId = obj.metadata && obj.metadata.itemId;
  if (!orderRef || !itemId) return;

  if (type === 'checkout.session.completed') {
    // Only treat it as paid when the money is actually there. Some methods
    // complete the session first and settle later.
    if (obj.payment_status && obj.payment_status !== 'paid') return;
    await confirmPaidOrder(env, itemId, orderRef, {
      provider: 'stripe',
      sessionId: obj.id,
      paymentIntent: obj.payment_intent || null,
      amountTotal: obj.amount_total != null ? (obj.amount_total / 100).toFixed(2) : null,
      currency: obj.currency || null
    });
    return;
  }

  if (type === 'checkout.session.async_payment_succeeded') {
    await confirmPaidOrder(env, itemId, orderRef, {
      provider: 'stripe', sessionId: obj.id,
      paymentIntent: obj.payment_intent || null,
      amountTotal: obj.amount_total != null ? (obj.amount_total / 100).toFixed(2) : null,
      currency: obj.currency || null
    });
    return;
  }

  if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') {
    const released = await deskCall(env, itemId, {
      op: 'release', orderRef, restoreStock: true, onlyIfPending: true
    });
    if (released && released.cleared) {
      await mirrorStock(env, itemId);
    }
  }
}

async function confirmPaidOrder(env, itemId, orderRef, payment) {
  const result = await deskCall(env, itemId, { op: 'confirm', orderRef, payment });
  if (!result || !result.ok || result.already) return;

  const rec = result.record || {};
  const settings = await hubCall(env, { op: 'settings.get' });
  const KV = env.POKEBALLER_KV;

  await mirrorStock(env, itemId, result.stock);

  if (KV) {
    await KV.put(`purchase:${itemId}:${rec.email}`, JSON.stringify({
      orderRef, itemId, itemName: rec.itemName || '', email: rec.email,
      name: rec.name || '', address: rec.address || '',
      qty: rec.qty, unitPrice: rec.unitPrice, total: rec.total,
      at: rec.at, paidAt: rec.paidAt, payment
    })).catch(() => {});
  }

  // If Stripe's total disagrees with ours, say so loudly in the email.
  let paidLine = 'Paid by card through Stripe.';
  if (payment && payment.amountTotal && rec.total && payment.amountTotal !== rec.total) {
    paidLine = `Stripe collected $${payment.amountTotal} but the order total was $${rec.total} — check this before shipping.`;
  }

  if (env.RESEND_API_KEY) {
    await sendEmail(env, {
      to: [rec.notifyEmail || settings.notifyEmail],
      replyTo: rec.email,
      subject: `✅ PAID ${orderRef}: ${rec.qty}x ${rec.itemName || ''}`,
      html: purchaseEmailHTML({
        orderRef, itemName: rec.itemName || '', qty: rec.qty,
        unitPrice: Number(rec.unitPrice || 0).toFixed(2),
        totalPrice: rec.total,
        buyerName: rec.name, buyerEmail: rec.email, buyerAddress: rec.address,
        remainingStock: result.stock, maxBuy: null,
        stockLabelType: rec.stockLabelType,
        paid: true, paidVia: paidLine
      })
    });
  }

  await fireAlert(env, {
    kind: 'order',
    name: rec.name, qty: rec.qty,
    unit: unitWordFor(rec.stockLabelType, rec.qty),
    itemName: rec.itemName || '', amount: rec.total, ref: orderRef
  }).catch(() => {});
}

// Keep the KV copy of stock roughly current so the site and admin show a sane
// number. Nothing reads this to make a decision.
async function mirrorStock(env, itemId, known) {
  const KV = env.POKEBALLER_KV;
  if (!KV) return;
  try {
    const item = await KV.get(itemId, 'json');
    if (!item) return;
    let stock = known;
    if (typeof stock !== 'number') {
      const st = await deskCall(env, itemId, { op: 'state' });
      stock = st && typeof st.stock === 'number' ? st.stock : null;
    }
    if (typeof stock !== 'number') return;
    item.stock = stock;
    await KV.put(itemId, JSON.stringify(item));
  } catch (e) { /* display copy only */ }
}

/* ============================================================
   ALERTS
   ============================================================ */
async function fireAlert(env, alert) {
  const settings = await hubCall(env, { op: 'settings.get' });
  const report = { overlay: 'off', streamlabs: 'off' };
  if (!settings.alertsEnabled && alert.kind !== 'test') return report;

  const message = alertMessage(settings, alert);
  const payload = Object.assign({}, alert, { message, title: settings.alertTitle || 'NEW ORDER' });

  if (settings.alertToOverlay) {
    try {
      const res = await hubCall(env, { op: 'alert.push', alert: payload });
      report.overlay = res && res.ok
        ? `queued (seq ${res.seq}, ${res.delivered} overlay${res.delivered === 1 ? '' : 's'} connected)`
        : 'push failed';
    } catch (e) { report.overlay = 'push failed: ' + String(e.message || e); }
  }

  if (settings.alertToStreamlabs) {
    const secrets = await hubCall(env, { op: 'secrets.get' });
    const token = secrets.streamlabsToken;
    if (!token) {
      report.streamlabs = 'no Streamlabs token saved';
    } else {
      try {
        const body = new URLSearchParams();
        body.append('access_token', token);
        body.append('type', 'donation');
        body.append('message', message);
        if (settings.alertImageUrl) body.append('image_href', settings.alertImageUrl);
        if (settings.alertSoundUrl) body.append('sound_href', settings.alertSoundUrl);
        const res = await fetch('https://streamlabs.com/api/v1.0/alerts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        const text = await res.text();
        report.streamlabs = res.ok ? 'sent' : `failed (${res.status}): ${text.slice(0, 200)}`;
      } catch (e) {
        report.streamlabs = 'failed: ' + String(e.message || e);
      }
    }
  }

  return report;
}

function alertMessage(settings, a) {
  const tpl = settings.alertTemplate || '{name} grabbed {qty} {unit} — {item}';
  let message = tpl
    .replace(/\{name\}/g, a.name || 'Someone')
    .replace(/\{qty\}/g, a.qty != null ? a.qty : '')
    .replace(/\{unit\}/g, a.unit || 'packs')
    .replace(/\{item\}/g, a.itemName || '')
    .replace(/\{amount\}/g, a.amount != null ? '$' + a.amount : '')
    .replace(/\{ref\}/g, a.ref || '')
    .replace(/\s+/g, ' ')
    .trim();
  // Keep unique code untouched; always show the break name beside it.
  if (a.kind === 'order' && a.ref && !message.includes(a.ref)) message += ' · Ref: ' + a.ref;
  if (a.kind === 'order' && a.itemName && !message.includes(a.itemName)) message += ' · Break: ' + a.itemName;
  return message.slice(0,255);
}

/* ============================================================
   SHARED HELPERS
   ============================================================ */

const DEFAULT_SETTINGS = {
  paymentMode: 'streamlabs',
  tipUrl: 'https://streamlabs.com/pokballer/tip',
  storeUrl: 'https://pbmbreaks.com',
  currency: 'usd',
  holdMinutes: 30,
  notifyEmail: 'michael.lorenz.10@gmail.com',
  publicContactEmail: 'pokeballer4free@gmail.com',
  refInstructions: 'Copy your unique order code and break name into the Streamlabs tip message with your YouTube username.',
  alertsEnabled: false,
  alertToOverlay: true,
  alertToStreamlabs: false,
  alertTitle: 'NEW ORDER',
  alertTemplate: '{name} grabbed {qty} {unit} — {item} · Ref: {ref}',
  alertImageUrl: '',
  alertSoundUrl: '',
  overlayToken: '',
  // How the public pages dress themselves, and the clip pinned to the feed.
  theme: 'crystal',
  featuredVideoUrl: '',
  featuredVideoTitle: ''
};

async function deskCall(env, itemId, payload) {
  const id = env.ORDER_DESK.idFromName(String(itemId));
  const stub = env.ORDER_DESK.get(id);
  const res = await stub.fetch('https://desk.internal/' + (payload.op || 'op'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json();
}

async function hubCall(env, payload) {
  const id = env.SITE_HUB.idFromName('site');
  const stub = env.SITE_HUB.get(id);
  const res = await stub.fetch('https://hub.internal/' + (payload.op || 'op'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json();
}

/* Everything an order request must pass before the desk is even asked.
   Shared by the Streamlabs and Stripe paths so the two cannot drift. */
async function vetOrderRequest(env, KV, data) {
  const itemId = String(data.itemId || '');
  const buyerEmail = String(data.buyerEmail || '').trim().toLowerCase();
  const buyerName = String(data.buyerName || '').trim().slice(0, 120);
  const buyerAddress = String(data.buyerAddress || '').trim().slice(0, 600);

  if (!itemId) return { error: 'Missing item.', code: 400 };
  if (!isEmail(buyerEmail)) return { error: 'A valid email address is required.', code: 400 };
  if (!buyerName || !buyerAddress) return { error: 'Name and shipping address are required.', code: 400 };

  // Quantity must be a genuine whole number — no coercion of odd types.
  const rawQty = data.qty;
  const qtyLooksOk = (typeof rawQty === 'number') || (typeof rawQty === 'string' && /^\s*\d+\s*$/.test(rawQty));
  const qty = qtyLooksOk ? Number(rawQty) : NaN;
  if (!qtyLooksOk || !Number.isInteger(qty) || qty < 1 || qty > 9999) {
    return { error: 'Invalid quantity.', code: 400 };
  }

  const item = await KV.get(itemId, 'json');
  if (!item) return { error: 'That item is no longer available.', code: 404 };
  if (item.hidden) return { error: 'That item is not on sale.', code: 403 };
  if (item.type !== 'pack') return { error: 'That item is not bought through this checkout.', code: 400 };

  const nowMs = Date.now();
  const goLiveMs = centralToMs(item.goLiveTime);
  if (goLiveMs && nowMs < goLiveMs) return { error: 'This drop has not gone live yet.', code: 403 };
  const endMs = centralToMs(item.scheduleEnd);
  if (endMs && nowMs >= endMs) return { error: 'This drop has closed.', code: 403 };

  return { item, qty, buyerEmail, buyerName, buyerAddress };
}

function makeOrderRef() {
  return 'PBM-' +
    Math.random().toString(36).slice(2, 6).toUpperCase() +
    Math.random().toString(36).slice(2, 4).toUpperCase();
}

function makeToken() {
  return crypto.randomUUID().replace(/-/g, '') + Math.random().toString(36).slice(2, 8);
}

// Never returns the key itself — just enough for you to tell which one is saved.
function describeSecret(envValue, storedValue) {
  if (envValue) return { set: true, source: 'cloudflare', hint: 'stored in Cloudflare secrets' };
  if (storedValue) {
    const s = String(storedValue);
    const tail = s.length > 4 ? s.slice(-4) : '••••';
    const head = s.slice(0, Math.min(8, s.length));
    return { set: true, source: 'admin', hint: `${head}…${tail}`, testMode: s.includes('_test_') };
  }
  return { set: false, source: null, hint: 'not set' };
}

function toInt(n, fallback) {
  const v = parseInt(n, 10);
  return Number.isFinite(v) ? v : (fallback != null ? fallback : 0);
}

function isEmail(s) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());
}

function unitWordFor(kind, n) {
  const map = {
    packs: ['pack', 'packs'],
    bundles: ['bundle', 'bundles'],
    spots: ['spot', 'spots']
  };
  const pair = map[kind] || map.packs;
  return toInt(n, 2) === 1 ? pair[0] : pair[1];
}

// A pack with no max set becomes 10, never unlimited.
function normaliseLimits(body) {
  if (body.type !== 'pack') return { minBuy: null, maxBuy: null };
  const min = Math.max(1, toInt(body.minBuy, 1));
  const maxRaw = toInt(body.maxBuy, 0);
  const max = Math.max(min, maxRaw > 0 ? maxRaw : 10);
  return { minBuy: min, maxBuy: max };
}

// Admin types times as US Central wall-clock ("2026-09-12T19:00"). DST included.
function centralToMs(localStr) {
  if (!localStr || String(localStr).indexOf('T') === -1) return null;
  try {
    const [d, tm] = String(localStr).split('T');
    const [y, mo, da] = d.split('-').map(Number);
    const [h, mi] = (tm || '00:00').split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, da, h, mi);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(guess));
    const m = {};
    parts.forEach(p => m[p.type] = p.value);
    const hh = m.hour === '24' ? 0 : Number(m.hour);
    const seen = Date.UTC(Number(m.year), Number(m.month) - 1, Number(m.day), hh, Number(m.minute), Number(m.second));
    return guess - (seen - guess);
  } catch (e) {
    return new Date(localStr + '-06:00').getTime();
  }
}

/* ---------- STRIPE ---------- */

async function stripePost(secretKey, endpoint, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    body.append(k, String(v));
  }
  try {
    const res = await fetch('https://api.stripe.com' + endpoint, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: { error: { message: String(err.message || err) } } };
  }
}

async function stripeGet(secretKey, endpoint) {
  try {
    const res = await fetch('https://api.stripe.com' + endpoint, {
      headers: { 'Authorization': 'Bearer ' + secretKey }
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: { error: { message: String(err.message || err) } } };
  }
}

/* Stripe signs every webhook. Without this check anyone who finds the URL
   could POST a fake "paid" event and walk off with stock. */
async function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader) return { ok: false, reason: 'no Stripe-Signature header' };

  const pieces = sigHeader.split(',').map(p => p.trim());
  const tPart = pieces.find(p => p.startsWith('t='));
  const v1s = pieces.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!tPart || v1s.length === 0) return { ok: false, reason: 'malformed signature header' };

  const t = Number(tPart.slice(2));
  if (!Number.isFinite(t)) return { ok: false, reason: 'bad timestamp' };
  const age = Math.abs(Math.floor(Date.now() / 1000) - t);
  if (age > toleranceSec) return { ok: false, reason: 'timestamp too old — check the worker clock' };

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');

  return v1s.some(v => timingSafeEqual(v, expected))
    ? { ok: true }
    : { ok: false, reason: 'signature mismatch — wrong webhook secret?' };
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- EMAIL ---------- */

async function sendEmail(env, { to, subject, html, replyTo }) {
  const payload = { from: 'Pokeballer Mike <mike@pbmbreaks.com>', to, subject, html };
  if (replyTo && isEmail(replyTo)) payload.reply_to = replyTo;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, detail: body.slice(0, 300) };
  } catch (err) {
    return { ok: false, status: 0, detail: String(err.message || err).slice(0, 300) };
  }
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function winnerEmailHTML({ breakName, paymentLink, price, message, contact }) {
  const name = escHtml(breakName);
  const link = escHtml(paymentLink);
  const mail = escHtml(contact || 'pokeballer4free@gmail.com');
  const priceRow = (price != null && isFinite(Number(price)) && Number(price) > 0)
    ? `<p style="color:#ffd700;font-size:28px;font-weight:bold;margin:0 0 24px;">$${Number(price).toFixed(2)}</p>`
    : '';
  const messageRow = message
    ? `<p style="color:#c9c9e8;font-size:14px;line-height:1.7;margin:0 0 24px;background:#0d0d1e;border:1px solid #2c2c4a;border-radius:10px;padding:14px 18px;">${escHtml(message)}</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#0b0b16;">
  <div style="background-color:#0b0b16;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background-color:#12122a;border-radius:16px;overflow:hidden;border:1px solid #2c2c4a;">
      <div style="height:4px;background:#00c9b7;background:linear-gradient(90deg,#00c9b7,#8a2be2,#ffd700);font-size:0;line-height:0;">&nbsp;</div>
      <div style="padding:36px 32px;text-align:center;">
        <p style="color:#ffd700;letter-spacing:3px;font-size:11px;font-weight:bold;margin:0 0 12px;text-transform:uppercase;">PBM Breaks &middot; Pokeballer Mike</p>
        <h1 style="color:#ffffff;font-size:28px;margin:0 0 18px;">&#127881; You've been picked!</h1>
        <p style="color:#c9c9e8;font-size:15px;line-height:1.6;margin:0 0 6px;">The wheel landed on you for:</p>
        <p style="color:#00e5da;font-size:20px;font-weight:bold;margin:0 0 18px;">${name}</p>
        ${priceRow}
        ${messageRow}
        <a href="${link}" style="display:inline-block;background-color:#8a2be2;background:linear-gradient(90deg,#00c9b7,#8a2be2);color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:16px 42px;border-radius:12px;letter-spacing:1px;">PAY FOR YOUR SPOT &rarr;</a>
        <p style="color:#8a8ab0;font-size:12px;line-height:1.7;margin:26px 0 0;">Payment locks in your spot. Button not working? Copy this link:<br><a href="${link}" style="color:#00e5da;word-break:break-all;">${link}</a></p>
      </div>
      <div style="background-color:#0d0d1e;padding:18px;text-align:center;border-top:1px solid #2c2c4a;">
        <p style="color:#8a8ab0;font-size:12px;line-height:1.7;margin:0;">Pokeballer Mike &middot; PBM Breaks<br>Questions? Just reply to this email, or write to<br><a href="mailto:${mail}" style="color:#00e5da;">${mail}</a></p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function purchaseEmailHTML(data) {
  const mismatch = data.clientTotal && data.clientTotal !== data.totalPrice
    ? `<p style="color:#ffb020;font-size:13px;margin:0 0 16px;border:1px solid #6b4a00;background:#241a00;border-radius:8px;padding:10px 14px;">Heads up: the page reported $${escHtml(data.clientTotal)} but the correct total is $${escHtml(data.totalPrice)}. Collect the correct total.</p>`
    : '';
  const unitLabel = unitWordFor(data.stockLabelType, data.qty);
  const limitNote = data.maxBuy ? ` <span style="color:#8a8ab0;">(limit ${escHtml(data.maxBuy)} per person)</span>` : '';
  const bannerColor = data.paid ? '#00ff9d' : '#00c9b7';
  const bannerText = data.paid ? '✅ Paid order' : '📦 New order';

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#0b0b16;">
  <div style="background-color:#0b0b16;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background-color:#12122a;border-radius:16px;overflow:hidden;border:1px solid #2c2c4a;">
      <div style="height:4px;background:${bannerColor};font-size:0;line-height:0;">&nbsp;</div>
      <div style="padding:36px 32px;text-align:left;">
        <h1 style="color:${bannerColor};font-size:24px;margin:0 0 6px;">${bannerText}</h1>
        <p style="color:#ffd700;font-size:16px;font-weight:bold;margin:0 0 8px;letter-spacing:1px;">Ref ${escHtml(data.orderRef)}</p>
        <p style="color:#fff;font-size:17px;font-weight:bold;margin:0 0 20px;line-height:1.5;">Break: ${escHtml(data.itemName)}</p>
        ${mismatch}
        <p style="color:#c9c9e8;font-size:15px;margin:0 0 8px;"><strong>Item:</strong> <span style="color:#fff;">${escHtml(data.itemName)}</span></p>
        <p style="color:#c9c9e8;font-size:15px;margin:0 0 8px;"><strong>Quantity:</strong> <span style="color:#fff;">${escHtml(data.qty)} ${escHtml(unitLabel)}</span>${limitNote}</p>
        <p style="color:#c9c9e8;font-size:15px;margin:0 0 8px;"><strong>Unit price:</strong> <span style="color:#fff;">$${escHtml(data.unitPrice)}</span></p>
        <p style="color:#c9c9e8;font-size:15px;margin:0 0 8px;"><strong>${data.paid ? 'Amount paid' : 'Amount to collect'}:</strong> <span style="color:#ffd700;font-weight:bold;font-size:18px;">$${escHtml(data.totalPrice)}</span></p>
        <p style="color:#c9c9e8;font-size:15px;margin:0 0 24px;"><strong>Stock left:</strong> <span style="color:#00e5da;font-weight:bold;">${escHtml(data.remainingStock)}</span></p>

        <h3 style="color:#8a8ab0;font-size:14px;text-transform:uppercase;border-bottom:1px solid #2c2c4a;padding-bottom:8px;margin-bottom:16px;">Buyer info</h3>
        <p style="color:#c9c9e8;font-size:15px;margin:0 0 8px;"><strong>Name:</strong> ${escHtml(data.buyerName)}</p>
        <p style="color:#c9c9e8;font-size:15px;margin:0 0 16px;"><strong>Email:</strong> <a href="mailto:${escHtml(data.buyerEmail)}" style="color:#00e5da;">${escHtml(data.buyerEmail)}</a></p>

        <div style="background:#0d0d1e;border:1px solid #2c2c4a;border-radius:10px;padding:14px 18px;">
          <p style="color:#fff;font-size:14px;line-height:1.6;margin:0;">${escHtml(data.buyerAddress).replace(/\n/g, '<br>')}</p>
        </div>

        <p style="color:#8a8ab0;font-size:12px;line-height:1.7;margin:26px 0 0;text-align:center;">${escHtml(data.paidVia || '')}</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}
