import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Miniflare, createFetchMock, fetch as mockFetch } from 'miniflare';

// Miniflare's fetchMock shortcut follows redirects in its Node outbound proxy.
// Keep the HTTP mock's boundary manual so workerd alone owns redirect policy.
const outboundMock = fetchMock => request => mockFetch(request, { dispatcher: fetchMock, redirect: 'manual' });

test('relay delivers byte-exact mail through real workerd fetch at the configured compatibility date', async t => {
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  let calls = 0, captured;
  fetchMock.get('https://ingress.example.test').intercept({ path: '/ingest', method: 'POST' }).reply(options => {
    calls++;
    captured = { body: new Response(options.body).arrayBuffer(), headers: options.headers };
    return { statusCode: 201, data: 'private upstream body' };
  });
  const mf = new Miniflare({ modules: true,
    scriptPath: fileURLToPath(new URL('./relay-runtime-harness.mjs', import.meta.url)),
    compatibilityDate: '2025-04-01', bindings: env, outboundService: outboundMock(fetchMock) });
  t.after(() => mf.dispose());
  const response = await mf.dispatchFetch('https://local.test', { method: 'POST', body: bytes });
  assert.equal(response.status, 204, await response.text());
  assert.equal(calls, 1);
  assert.deepEqual(Buffer.from(await captured.body), bytes);
  assert.equal(captured.headers.authorization, 'Bearer ' + secret);
  assert.equal(captured.headers['content-type'], 'message/rfc822');
  assert.equal(captured.headers['x-envelope-from'], '');
  assert.equal(captured.headers['x-envelope-to'], 'Box@Example.Test');
  fetchMock.assertNoPendingInterceptors();
});

test('workerd rejects redirects without forwarding credentials or MIME to their destination', async t => {
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  let ingestCalls = 0, redirectCalls = 0;
  const statuses = [200, 202, 204, 301, 302, 303, 307, 308, 400, 500];
  for (const statusCode of statuses) {
    fetchMock.get('https://ingress.example.test').intercept({ path: '/ingest', method: 'POST' }).reply(() => {
      ingestCalls++;
      return { statusCode, data: statusCode === 204 ? '' : 'private upstream response',
        responseOptions: { headers: { location: 'https://redirect.example.test/stolen' } } };
    });
  }
  fetchMock.get('https://redirect.example.test').intercept({ path: '/stolen', method: /.+/ }).reply(() => {
    redirectCalls++;
    return { statusCode: 201, data: '' };
  }).persist();
  const mf = new Miniflare({ modules: true,
    scriptPath: fileURLToPath(new URL('./relay-runtime-harness.mjs', import.meta.url)),
    compatibilityDate: '2025-04-01', bindings: env, outboundService: outboundMock(fetchMock) });
  t.after(() => mf.dispose());
  for (const status of statuses) {
    const response = await mf.dispatchFetch('https://local.test', { method: 'POST', body: 'private MIME' });
    assert.equal(response.status, 502, `upstream ${status} must fail`);
    assert.equal(await response.text(), 'Relay delivery failed');
  }
  assert.equal(ingestCalls, statuses.length);
  assert.equal(redirectCalls, 0);
});

const secret = 'i'.repeat(40), readToken = 'r'.repeat(40);
const env = { RELAY_INGEST_URL: 'https://ingress.example.test/ingest', RELAY_INGEST_TOKEN: secret };
function message(bytes, changes = {}) {
  return { from: '', to: 'Box@Example.Test', rawSize: bytes.length,
    raw: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } }), ...changes };
}

test('relay rejects unsafe configuration before reading or sending mail', async () => {
  const { createRelay } = await import('../apps/relay/worker.mjs');
  let calls = 0;
  const relay = createRelay({ fetch: async () => { calls++; return new Response(null, { status: 201 }); } });
  for (const change of [
    { RELAY_INGEST_URL: 'https://@host/ingest' }, { RELAY_INGEST_URL: 'https://host/ingest\n' },
    { RELAY_INGEST_URL: 'https://host/in\ngest' },
    { RELAY_INGEST_URL: 'http://localhost/ingest' }, { RELAY_INGEST_URL: 'https://user:password@host/ingest' },
    { RELAY_INGEST_URL: 'https://host/ingest#private' }, { RELAY_INGEST_URL: 'https://host/ingest#' },
    { RELAY_INGEST_URL: 'https://host/wrong' }, { RELAY_INGEST_URL: 'https://host/ingest?token=private' },
    { RELAY_INGEST_URL: undefined }, { RELAY_INGEST_URL: null }, { RELAY_INGEST_URL: ' https://host/ingest' },
    { RELAY_INGEST_TOKEN: undefined }, { RELAY_INGEST_TOKEN: 'short' }, { RELAY_INGEST_TOKEN: 'x'.repeat(257) },
    { RELAY_INGEST_TOKEN: 'x'.repeat(40) + '\n' }, { MAX_BYTES: '5\n' },
    { RELAY_INGEST_TOKEN: 'x'.repeat(40) + '\r\n' },
    { MAX_BYTES: null }, { MAX_BYTES: 5 }, { MAX_BYTES: '0' }, { MAX_BYTES: '01' }, { MAX_BYTES: '26214401' },
  ]) {
    let reads = 0;
    const input = message(Buffer.from('private'));
    Object.defineProperty(input, 'raw', { get() { reads++; throw new Error('private stream'); } });
    await assert.rejects(relay.email(input, { ...env, ...change }), { message: 'Relay configuration invalid' });
    assert.equal(reads, 0);
  }
  assert.equal(calls, 0);
});

test('relay bounds declared and streamed bytes, cancels overflow, and rejects invalid raw safely', async () => {
  const { createRelay } = await import('../apps/relay/worker.mjs');
  let calls = 0;
  const relay = createRelay({ fetch: async () => { calls++; return new Response(null, { status: 201 }); } });
  const config = { ...env, MAX_BYTES: '5' };
  for (const rawSize of [6, -1, NaN, undefined, '5']) {
    await assert.rejects(relay.email(message(Buffer.alloc(0), { rawSize }), config), /Relay message invalid/);
  }
  let cancelled = false;
  const raw = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(3)); c.enqueue(new Uint8Array(3)); }, cancel() { cancelled = true; } });
  await assert.rejects(relay.email(message(Buffer.alloc(5), { raw }), config), /Relay message invalid/);
  assert.equal(cancelled, true);
  await assert.rejects(relay.email(message(Buffer.alloc(2), { rawSize: 3 }), config), /Relay message invalid/);
  await assert.rejects(relay.email(message(Buffer.alloc(0), { raw: new ReadableStream({ start(c) { c.error(new Error('private raw')); } }) }), config), { message: 'Relay message invalid' });
  await assert.rejects(relay.email(message(Buffer.alloc(0), { raw: new ReadableStream({ start(c) { c.enqueue('not bytes'); c.close(); } }) }), config), /Relay message invalid/);
  assert.equal(calls, 0);
  await relay.email(message(Buffer.alloc(5)), config);
  await relay.email(message(Buffer.alloc(0)), config);
  assert.equal(calls, 2);
});

test('relay validates envelope without trusting MIME or allowing header injection', async () => {
  const { createRelay } = await import('../apps/relay/worker.mjs');
  let calls = 0;
  const relay = createRelay({ fetch: async () => { calls++; return new Response(null, { status: 201 }); } });
  for (const changes of [{ to: '' }, { to: 'invalid' }, { to: 'box@example.test\r\nX-Secret: yes' }, { from: undefined }, { from: 'not an address' }, { from: 'a@example.test\n' }]) {
    await assert.rejects(relay.email(message(Buffer.alloc(0), changes), env), { message: 'Relay message invalid' });
  }
  assert.equal(calls, 0);
  await relay.email(message(Buffer.alloc(0), { from: 'Sender@Example.Test' }), env);
  assert.equal(calls, 1);
});

test('relay fails explicitly and sanitized on redirects, failed status, or transport error without retries', async () => {
  const { createRelay } = await import('../apps/relay/worker.mjs');
  for (const status of [200, 202, 204, 301, 302, 307, 308, 400, 401, 413, 500, 503, null]) {
    let calls = 0, cancelled = false;
    const relay = createRelay({ fetch: async () => {
      calls++;
      if (status === null) throw new Error('private URL secret body');
      if (status === 204) return new Response(null, { status });
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { location: 'https://attacker.test' } });
    } });
    await assert.rejects(relay.email(message(Buffer.from('private body')), env), { message: 'Relay delivery failed' });
    assert.equal(calls, 1);
    if (status !== null && status !== 204) assert.equal(cancelled, true);
  }
});

test('relay delivers exact bytes and trusted envelope to actual VPS through injected loopback transport', async t => {
  const { createRelay } = await import('../apps/relay/worker.mjs');
  const { createBackend } = await import('../apps/vps/server.mjs');
  const backend = createBackend({ dbPath: ':memory:', ingestToken: secret, mailboxTokens: { 'box@example.test': readToken } });
  backend.server.listen(0, '127.0.0.1');
  await once(backend.server, 'listening');
  t.after(async () => { await new Promise(resolve => backend.server.close(resolve)); backend.close(); });
  const base = `http://127.0.0.1:${backend.server.address().port}`;
  let calls = 0;
  const relay = createRelay({ fetch: async (url, options) => {
    calls++;
    assert.equal(url, env.RELAY_INGEST_URL);
    assert.equal(options.redirect, 'manual');
    return fetch(base + '/ingest', options);
  } });
  const bytes = Buffer.concat([Buffer.from('To: spoof@example.test\r\n\r\n'), Buffer.from([255, 0, 128, 13, 10])]);
  await relay.email(message(bytes), env);
  assert.equal(calls, 1);
  const headers = { authorization: 'Bearer ' + readToken };
  const page = await (await fetch(base + '/v1/messages', { headers })).json();
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].size, bytes.length);
  assert.deepEqual({ ...page.messages[0].envelope, received: null }, { from: '', to: 'Box@Example.Test', received: null });
  const raw = await fetch(base + '/v1/messages/' + page.messages[0].id + '/raw', { headers });
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), bytes);
  assert.equal((await fetch(base + '/v1/messages', { headers: { authorization: 'Bearer ' + secret } })).status, 401);
});
