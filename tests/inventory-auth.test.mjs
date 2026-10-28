import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../worker.js';

function fixture() {
  const records = new Map([
    ['admin:trainer', { password: 'test-password' }],
    ['session:valid-session', { user: 'trainer' }],
    ['item:1', { id: 'item:1', type: 'bundle', name: 'Original', images: [], stock: 3 }],
    ['purchase:item:1:buyer', { qty: 1 }]
  ]);
  const effects = [];
  const env = {
    POKEBALLER_KV: {
      async get(key, type) {
        const value = records.get(key);
        return value == null ? null : type === 'json' ? structuredClone(value) : JSON.stringify(value);
      },
      async put(key, value) { effects.push(['put', key]); records.set(key, JSON.parse(value)); },
      async delete(key) { effects.push(['delete', key]); records.delete(key); },
      async list({ prefix }) {
        return { keys: [...records.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) };
      }
    },
    ORDER_DESK: {
      idFromName(id) { return id; },
      get(id) {
        return { async fetch(_url, options) {
          effects.push(['desk', id, JSON.parse(options.body).op]);
          return Response.json({ ok: true });
        } };
      }
    }
  };
  async function request(method, path, body) {
    return worker.fetch(new Request('https://local.test' + path, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })
    }), env, {});
  }
  return { records, effects, request };
}

for (const [method, path] of [
  ['POST', '/api/items'], ['PUT', '/api/items/item:1'], ['DELETE', '/api/items/item:1']
]) {
  for (const token of [undefined, 'expired-session']) {
    test(`${method} inventory rejects ${token ? 'invalid' : 'missing'} session before side effects`, async () => {
      const { effects, records, request } = fixture();
      const before = structuredClone([...records]);
      const response = await request(method, path, { token, images: ['data:image/png;base64,fixture'] });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'Unauthorized' });
      assert.deepEqual(effects, []);
      assert.deepEqual([...records], before);
    });
  }
}

test('inventory DELETE without a JSON body is rejected', async () => {
  const { effects, request } = fixture();
  assert.equal((await request('DELETE', '/api/items/item:1')).status, 401);
  assert.deepEqual(effects, []);
});

test('authorized inventory CRUD works and never persists the session token', async () => {
  const { records, request, effects } = fixture();
  const response = await request('POST', '/api/items', {
    token: 'valid-session', type: 'bundle', name: 'New bundle', stock: 4, images: []
  });
  assert.equal(response.status, 200);
  const { item } = await response.json();
  assert.equal(item.name, 'New bundle');
  assert.equal(Object.hasOwn(item, 'token'), false);
  assert.equal(Object.hasOwn(records.get(item.id), 'token'), false);

  assert.equal((await request('PUT', '/api/items/item:1', {
    token: 'valid-session', name: 'Updated', images: [], stock: 8
  })).status, 200);
  assert.equal(records.get('item:1').name, 'Updated');
  assert.equal(records.get('item:1').stock, 8);
  assert.equal(Object.hasOwn(records.get('item:1'), 'token'), false);

  assert.equal((await request('DELETE', '/api/items/item:1', { token: 'valid-session' })).status, 200);
  assert.equal(records.has('item:1'), false);
  assert.equal(records.has('purchase:item:1:buyer'), false);
  assert.ok(effects.some(([type, id, op]) => type === 'desk' && id === 'item:1' && op === 'wipe'));
});

test('public inventory remains readable without a session', async () => {
  const { request, effects } = fixture();
  const response = await request('GET', '/api/items');
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].name, 'Original');
  assert.deepEqual(effects, []);
});

test('login returns a session accepted by inventory mutations', async () => {
  const { request } = fixture();
  assert.equal((await request('POST', '/api/login', { username: 'trainer', password: 'wrong' })).status, 401);
  const login = await request('POST', '/api/login', { username: 'trainer', password: 'test-password' });
  const { token } = await login.json();
  assert.equal(login.status, 200);
  assert.ok(token);
  assert.equal((await request('PUT', '/api/items/item:1', { token, stock: 7, images: [] })).status, 200);
});
