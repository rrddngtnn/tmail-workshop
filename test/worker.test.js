import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.mjs';

test('active mailbox allowlist rejects unknown recipients before reading or storage', async () => {
  let rejected, stored = false;
  const env = { MAILBOX_TOKENS: JSON.stringify({ 'box@example.test': 'b'.repeat(40) }), ACTIVE_MAILBOXES: JSON.stringify(['box@example.test']), MAIL: { async put() { stored = true; } } };
  await worker.email({ to: 'other@example.test', setReject(reason) { rejected = reason; }, get raw() { throw new Error('must not read'); } }, env);
  assert.equal(rejected, 'Recipient not accepted');
  assert.equal(stored, false);
});

test('active mailbox configuration must be a JSON string', async () => {
  const old = console.error; console.error = () => {};
  try {
    await assert.rejects(worker.email({ to: 'box@example.test' }, { ACTIVE_MAILBOXES: [] }), /Invalid ACTIVE_MAILBOXES/);
  } finally { console.error = old; }
});

test('allowlisted recipient matching is case insensitive and stores in scoped mailbox', async () => {
  let saved;
  const env = { ACTIVE_MAILBOXES: '["box@example.test"]', MAILBOX_TOKENS: JSON.stringify({ 'box@example.test': 'b'.repeat(40) }), MAIL: { async put(key) { saved = key; return {}; } } };
  await worker.email({ from: '', to: 'Box@Example.Test', raw: new Response('x').body, rawSize: 1 }, env);
  assert.match(saved, /^mailboxes\/[a-f0-9]{64}\/messages\//);
});

test('invalid allowlist fails closed and empty list rejects all', async () => {
  const old = console.error; console.error = () => {};
  try {
    for (const value of ['{', '{}', '["BOX@example.test"]', '["x"]', '["box@example.test","box@example.test"]']) {
      await assert.rejects(worker.email({ to: 'box@example.test' }, { ACTIVE_MAILBOXES: value }));
    }
  } finally { console.error = old; }
  let rejected;
  await worker.email({ to: 'box@example.test', setReject(reason) { rejected = reason; } }, { ACTIVE_MAILBOXES: '[]' });
  assert.equal(rejected, 'Recipient not accepted');
});

test('private API rejects requests without a configured secret', async () => {
  const response = await worker.fetch(new Request('https://example.test/messages'), {});
  assert.equal(response.status, 503);
});

test('inbound stores exact bytes and envelope together', async () => {
  let saved;
  const raw = new Uint8Array([0, 255, 13, 10, 65]);
  const env = { MAIL: { async put(key, body, options) { assert.ok(body instanceof ArrayBuffer); saved = { key, bytes: new Uint8Array(body), options }; } } };
  await worker.email({ from: 'sender@example.test', to: 'box@example.test', raw: new Response(raw).body, rawSize: raw.length }, env);
  assert.deepEqual(saved.bytes, raw);
  assert.equal(saved.options.customMetadata.from, 'sender@example.test');
  assert.equal(saved.options.customMetadata.to, 'box@example.test');
  assert.match(saved.key, /^messages\/[0-9a-f-]{36}$/);
});

test('authenticated client lists stored message metadata', async () => {
  const token = 'a'.repeat(40);
  const env = { API_TOKEN: token, MAIL: { async list() { return { objects: [{ key: 'messages/abc', size: 5, customMetadata: { from: 'x', to: 'y' } }], truncated: false }; } } };
  const res = await worker.fetch(new Request('https://example.test/messages', { headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { messages: [{ id: 'abc', size: 5, from: 'x', to: 'y' }], cursor: null });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('authenticated client retrieves raw message as attachment', async () => {
  const token = 'a'.repeat(40), id = '12345678-1234-4234-8234-123456789abc';
  const env = { API_TOKEN: token, MAIL: { async get(key) { assert.equal(key, `messages/${id}`); return { body: new Response(new Uint8Array([0,255])).body }; } } };
  const res = await worker.fetch(new Request(`https://example.test/messages/${id}`, { headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array([0,255]));
  assert.match(res.headers.get('content-disposition'), /^attachment/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('storage errors are observable and propagate from inbound handler', async () => {
  let logged = '';
  const old = console.error;
  console.error = (...args) => { logged += args.join(' '); };
  try {
    await assert.rejects(worker.email({ from: 'private-sender', to: 'private-recipient', raw: new Response('x').body, rawSize: 1 }, { MAIL: { async put() { throw new Error('outage'); } } }), /outage/);
    assert.match(logged, /storage failure/);
    assert.doesNotMatch(logged, /private-sender|private-recipient|outage/);
  } finally { console.error = old; }
});

test('oversized inbound message is rejected before reading or storage', async () => {
  let rejected;
  const message = { rawSize: 11, setReject(reason) { rejected = reason; } };
  await worker.email(message, { MAX_BYTES: '10', MAIL: { put() { throw new Error('must not store'); } } });
  assert.equal(rejected, 'Message exceeds configured size limit');
});

test('inbound rejects and cancels a stream exceeding the limit despite understated rawSize', async () => {
  let rejected, cancelled = false, pulls = 0, stored = false;
  const raw = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(4));
      if (pulls === 3) controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await worker.email({ raw, rawSize: 2, setReject(reason) { rejected = reason; } }, {
    MAX_BYTES: '5', MAIL: { async put() { stored = true; } },
  });
  assert.equal(rejected, 'Message exceeds configured size limit');
  assert.equal(cancelled, true);
  assert.equal(pulls, 2);
  assert.equal(stored, false);
});

test('inbound preserves byte-exact multi-chunk data at the configured limit', async () => {
  let saved;
  const backing = new Uint8Array([99, 0, 255, 99]);
  const raw = new ReadableStream({ start(controller) {
    controller.enqueue(backing.subarray(1, 3));
    controller.enqueue(new Uint8Array([13, 10, 65]));
    controller.close();
  } });
  await worker.email({ from: '', to: 'x', raw, rawSize: 5 }, {
    MAX_BYTES: '5', MAIL: { async put(key, body) { saved = new Uint8Array(body); } },
  });
  assert.deepEqual(saved, new Uint8Array([0, 255, 13, 10, 65]));
});

test('inbound rejects a size mismatch within the limit without storage', async () => {
  let stored = false;
  const old = console.error; console.error = () => {};
  try {
    await assert.rejects(worker.email({ raw: new Response('abc').body, rawSize: 2 }, {
      MAX_BYTES: '5', MAIL: { async put() { stored = true; } },
    }), /Raw size mismatch/);
    assert.equal(stored, false);
  } finally { console.error = old; }
});

test('null storage result is surfaced as a failure', async () => {
  const old = console.error; console.error = () => {};
  try {
    await assert.rejects(worker.email({ from: '', to: 'x', raw: new Response('x').body, rawSize: 1 }, { MAIL: { async put() { return null; } } }), /storage/i);
  } finally { console.error = old; }
});

test('private API rejects wrong credentials and accepts a valid bearer', async () => {
  const env = { API_TOKEN: 'a'.repeat(40) };
  const bad = await worker.fetch(new Request('https://example.test/unknown', { headers: { Authorization: `Bearer ${'b'.repeat(40)}` } }), env);
  assert.equal(bad.status, 401);
  const good = await worker.fetch(new Request('https://example.test/unknown', { headers: { Authorization: `Bearer ${env.API_TOKEN}` } }), env);
  assert.equal(good.status, 404);
});


test('scoped credentials cannot fall through to another mailbox or legacy data', async () => {
  const env = { API_TOKEN: 'a'.repeat(40), MAILBOX_TOKENS: JSON.stringify({ 'box@example.test': 'b'.repeat(40) }), MAIL: { async list() { throw new Error('unauthorized read'); } } };
  const req = token => new Request('https://example.test/messages', { headers: { Authorization: 'Bearer ' + token.repeat(40) } });
  assert.equal((await worker.fetch(req('c'), env)).status, 401);
  delete env.API_TOKEN;
  assert.equal((await worker.fetch(req('c'), env)).status, 401);
});

test('malformed scoped configuration fails inbound before storage', async () => {
  let stored = false;
  const old = console.error; console.error = () => {};
  try {
    await assert.rejects(worker.email({ from: 'x', to: 'box@example.test', raw: new Response('x').body, rawSize: 1 }, { MAILBOX_TOKENS: '{', MAIL: { async put() { stored = true; } } }));
    assert.equal(stored, false);
  } finally { console.error = old; }
});

test('mailbox token lists only its own inbound messages', async () => {
  const token = 'b'.repeat(40);
  let prefix;
  const env = { MAILBOX_TOKENS: JSON.stringify({ 'box@example.test': token }), MAIL: { async list(options) { prefix = options.prefix; return { objects: [], truncated: false }; } } };
  const response = await worker.fetch(new Request('https://example.test/messages', { headers: { Authorization: 'Bearer ' + token } }), env);
  assert.equal(response.status, 200);
  assert.match(prefix, /^mailboxes\/[a-f0-9]{64}\/messages\/$/);
});


test('inbound mailbox isolation permits its owner to read exact raw bytes only', async () => {
  const objects = new Map();
  const MAIL = {
    async put(key, body, options) { objects.set(key, { bytes: new Uint8Array(body), customMetadata: options.customMetadata }); return {}; },
    async list({ prefix }) { return { objects: [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, obj]) => ({ key, size: obj.bytes.length, customMetadata: obj.customMetadata })), truncated: false }; },
    async get(key) { const o = objects.get(key); return o ? { body: new Response(o.bytes).body } : null; },
  };
  const env = { MAIL, MAILBOX_TOKENS: JSON.stringify({ 'box@example.test': 'b'.repeat(40), 'other@example.test': 'c'.repeat(40) }) };
  const raw = new Uint8Array([0, 255, 13, 10]);
  await worker.email({ from: '', to: 'Box@Example.Test', raw: new Response(raw).body, rawSize: raw.length }, env);
  const req = (path, token) => new Request('https://example.test' + path, { headers: { Authorization: 'Bearer ' + token.repeat(40) } });
  const list = await (await worker.fetch(req('/messages', 'b'), env)).json();
  assert.equal(list.messages.length, 1);
  assert.equal(list.messages[0].to, 'Box@Example.Test');
  assert.equal(list.messages[0].from, '');
  const path = '/messages/' + list.messages[0].id;
  assert.deepEqual(new Uint8Array(await (await worker.fetch(req(path, 'b'), env)).arrayBuffer()), raw);
  assert.equal((await worker.fetch(req(path, 'c'), env)).status, 404);
});


test('admin token can independently list a specified mailbox', async () => {
  let prefix;
  const env = { API_TOKEN: 'a'.repeat(40), MAILBOX_TOKENS: JSON.stringify({ 'box@example.test': 'b'.repeat(40) }), MAIL: { async list(opts) { prefix = opts.prefix; return { objects: [], truncated: false }; } } };
  const req = token => new Request('https://example.test/admin/messages?mailbox=box%40example.test', { headers: { Authorization: 'Bearer ' + token.repeat(40) } });
  assert.equal((await worker.fetch(req('b'), env)).status, 404);
  assert.equal((await worker.fetch(req('a'), env)).status, 200);
  assert.match(prefix, /^mailboxes\/[a-f0-9]{64}\/messages\/$/);
});


test('admin reads raw by mailbox and message id without granting inbox tokens admin access', async () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  let key;
  const env = { API_TOKEN: 'a'.repeat(40), MAILBOX_TOKENS: JSON.stringify({ 'box@example.test': 'b'.repeat(40) }), MAIL: { async get(k) { key = k; return { body: new Response('raw').body }; } } };
  const request = t => new Request('https://example.test/admin/messages/' + id + '?mailbox=box%40example.test', { headers: { Authorization: 'Bearer ' + t.repeat(40) } });
  assert.equal((await worker.fetch(request('b'), env)).status, 404);
  const res = await worker.fetch(request('a'), env);
  assert.equal(await res.text(), 'raw');
  assert.match(key, new RegExp('^mailboxes/[a-f0-9]{64}/messages/' + id + '$'));
});


test('v1 mailbox listing exposes only explicit envelope metadata', async () => {
  const token = 'b'.repeat(40);
  const env = { MAILBOX_TOKENS: JSON.stringify({ 'box@example.test': token }), MAIL: { async list({ prefix }) {
    return { objects: [{ key: prefix + '12345678-1234-4234-8234-123456789abc', size: 4, customMetadata: { from: '', to: 'Box@Example.Test', received: '2026-01-01T00:00:00.000Z', secret: token } }], truncated: false };
  } } };
  const res = await worker.fetch(new Request('https://example.test/v1/messages', { headers: { Authorization: 'Bearer ' + token } }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { messages: [{ id: '12345678-1234-4234-8234-123456789abc', size: 4, envelope: { from: '', to: 'Box@Example.Test', received: '2026-01-01T00:00:00.000Z' } }], cursor: null });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('v1 listing passes opaque pagination cursor to scoped R2 listing', async () => {
  const token = 'b'.repeat(40); let options;
  const env = { MAILBOX_TOKENS: JSON.stringify({ 'box@example.test': token }), MAIL: { async list(opts) { options = opts; return { objects: [], truncated: true, cursor: 'next+/=' }; } } };
  const res = await worker.fetch(new Request('https://example.test/v1/messages?cursor=previous%2B%2F%3D', { headers: { Authorization: 'Bearer ' + token } }), env);
  assert.equal(options.cursor, 'previous+/=');
  assert.equal(options.limit, 100);
  assert.deepEqual(await res.json(), { messages: [], cursor: 'next+/=' });
});

test('v1 returns exact raw MIME only to the owning mailbox', async () => {
  const objects = new Map();
  const MAIL = {
    async put(key, bytes, opts) { objects.set(key, { bytes: new Uint8Array(bytes), metadata: opts.customMetadata }); return {}; },
    async list({ prefix }) { return { objects: [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, o]) => ({ key, size: o.bytes.length, customMetadata: o.metadata })), truncated: false }; },
    async get(key) { const o = objects.get(key); return o ? { body: new Response(o.bytes).body } : null; },
  };
  const env = { MAIL, MAILBOX_TOKENS: JSON.stringify({ 'box@example.test': 'b'.repeat(40), 'other@example.test': 'c'.repeat(40) }) };
  const raw = new Uint8Array([0, 255, 13, 10]);
  await worker.email({ from: '', to: 'box@example.test', raw: new Response(raw).body, rawSize: raw.length }, env);
  const req = (path, t) => new Request('https://example.test' + path, { headers: { Authorization: 'Bearer ' + t.repeat(40) } });
  const listing = await (await worker.fetch(req('/v1/messages', 'b'), env)).json();
  const path = '/v1/messages/' + listing.messages[0].id + '/raw';
  const res = await worker.fetch(req(path, 'b'), env);
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), raw);
  assert.equal(res.headers.get('content-type'), 'message/rfc822');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await worker.fetch(req(path, 'c'), env)).status, 404);
});

test('v1 authentication errors are non-cacheable and admin credentials cannot access scoped routes', async () => {
  const env = { API_TOKEN: 'a'.repeat(40), MAILBOX_TOKENS: JSON.stringify({ 'box@example.test': 'b'.repeat(40) }), MAIL: { async list() { throw new Error('must not list'); } } };
  for (const token of ['a', 'c']) {
    const res = await worker.fetch(new Request('https://example.test/v1/messages', { headers: { Authorization: 'Bearer ' + token.repeat(40) } }), env);
    assert.equal(res.status, token === 'a' ? 404 : 401);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await res.text(), /a{40}|b{40}|c{40}/);
  }
});

test('v1 R2 list and get failures return sanitized noncacheable 503 responses', async () => {
  const token = 'b'.repeat(40);
  const env = { MAILBOX_TOKENS: JSON.stringify({ 'box@example.test': token }), MAIL: {
    async list() { throw new Error('private R2 list detail ' + token); },
    async get() { throw new Error('private R2 get detail ' + token); },
  } };
  for (const path of ['/v1/messages', '/v1/messages?cursor=invalid', '/v1/messages/12345678-1234-4234-8234-123456789abc/raw']) {
    const response = await worker.fetch(new Request('https://example.test' + path, { headers: { Authorization: 'Bearer ' + token } }), env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), 'Service unavailable');
  }
});

test('unsafe seatpool endpoint is unavailable rather than emitting spoofable or poison MIME', async () => {
  const env = { MAILBOX_TOKENS: JSON.stringify({ 'box@example.test': 'b'.repeat(40) }), MAIL: { async list() { throw new Error('must not list'); } } };
  const req = new Request('https://example.test/seatpool/box%40example.test', { headers: { Authorization: 'Bearer ' + 'b'.repeat(40) } });
  assert.equal((await worker.fetch(req, env)).status, 404);
});

