import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const admin = 'a'.repeat(40), alice = 'b'.repeat(40), bob = 'c'.repeat(40);
const aliceAddr = 'alice@example.test', bobAddr = 'bob@example.test';
const seat = '/seatpool/alice%40example.test';
const scriptPath = fileURLToPath(new URL('./runtime-harness.mjs', import.meta.url));
const prefix = address => `mailboxes/${createHash('sha256').update(address.toLowerCase()).digest('hex')}/messages/`;
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function runtime(t, bindings = {}) {
  const mf = new Miniflare({ modules: true, scriptPath, compatibilityDate: '2025-04-01',
    r2Buckets: ['MAIL'], bindings: { API_TOKEN: admin, MAX_BYTES: '1024', ...bindings } });
  t.after(() => mf.dispose());
  return mf;
}
function request(mf, path, token, init = {}) {
  return mf.dispatchFetch('http://local.test' + path, { ...init, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...init.headers } });
}
async function send(mf, to, body, size) {
  return request(mf, '/__test_email', null, { method: 'POST', body, headers: {
    'x-test-from': 'sender@example.test', 'x-test-to': to, ...(size === undefined ? {} : { 'x-test-size': String(size) }),
  } });
}
const scoped = { MAILBOX_TOKENS: JSON.stringify({ [aliceAddr]: alice, [bobAddr]: bob }) };

test('legacy email stores exact bytes and metadata in real local R2; authenticated HTTP retrieves them', async t => {
  const mf = await runtime(t), raw = new Uint8Array([0, 255, 13, 10, 65]);
  const sent = await send(mf, aliceAddr, raw);
  assert.equal(sent.status, 200); assert.deepEqual(await sent.json(), { rejection: null });
  const bucket = await mf.getR2Bucket('MAIL');
  const objects = await bucket.list({ prefix: 'messages/', include: ['customMetadata'] });
  assert.equal(objects.objects.length, 1);
  assert.equal(objects.objects[0].customMetadata.to, aliceAddr);
  assert.equal(objects.objects[0].customMetadata.from, 'sender@example.test');
  assert.ok(!Number.isNaN(Date.parse(objects.objects[0].customMetadata.received)));
  assert.deepEqual(new Uint8Array(await (await bucket.get(objects.objects[0].key)).arrayBuffer()), raw);
  assert.equal((await request(mf, '/messages')).status, 401);
  assert.equal((await request(mf, '/messages', bob)).status, 401);
  const list = await request(mf, '/messages', admin);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const data = await list.json(); assert.equal(data.messages.length, 1);
  assert.equal(data.messages[0].size, raw.length); assert.equal(data.cursor, null);
  const response = await request(mf, '/messages/' + data.messages[0].id, admin);
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-disposition'), /^attachment/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), raw);
});

test('scoped delivery isolates real R2 data and admin access', async t => {
  const mf = await runtime(t, scoped);
  assert.equal((await send(mf, 'Alice@Example.Test', 'Subject: x\r\n\r\nhello')).status, 200);
  assert.equal((await send(mf, bobAddr, 'bob')).status, 200);
  const bucket = await mf.getR2Bucket('MAIL');
  assert.equal((await bucket.list({ prefix: prefix(aliceAddr) })).objects.length, 1);
  assert.equal((await bucket.list({ prefix: prefix(bobAddr) })).objects.length, 1);
  const list = await (await request(mf, '/messages', alice)).json();
  assert.equal(list.messages.length, 1); assert.equal(list.messages[0].to, 'Alice@Example.Test');
  const id = list.messages[0].id;
  assert.equal((await request(mf, '/messages/' + id, bob)).status, 404);
  assert.equal((await request(mf, '/admin/messages?mailbox=alice%40example.test', alice)).status, 404);
  assert.equal((await request(mf, seat, bob)).status, 404);
  const adminList = await (await request(mf, '/admin/messages?mailbox=ALICE%40EXAMPLE.TEST', admin)).json();
  assert.equal(adminList.messages[0].id, id);
  assert.equal(await (await request(mf, `/admin/messages/${id}?mailbox=alice%40example.test`, admin)).text(), 'Subject: x\r\n\r\nhello');
  assert.equal((await request(mf, '/admin/messages', admin)).status, 400);
  assert.equal((await request(mf, '/messages/not-a-uuid', alice)).status, 404);
});

test('v1 scoped API returns envelope and exact raw bytes from local R2', async t => {
  const mf = await runtime(t, scoped);
  const raw = new Uint8Array([0, 255, 13, 10, 65]);
  const sent = await send(mf, 'Alice@Example.Test', raw);
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { rejection: null });
  const list = await request(mf, '/v1/messages', alice);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const data = await list.json();
  assert.equal(data.cursor, null);
  assert.equal(data.messages.length, 1);
  const { id, size, envelope } = data.messages[0];
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(size, raw.length);
  assert.deepEqual(Object.keys(envelope).sort(), ['from', 'received', 'to']);
  assert.equal(envelope.from, 'sender@example.test');
  assert.equal(envelope.to, 'Alice@Example.Test');
  assert.ok(!Number.isNaN(Date.parse(envelope.received)));
  const path = `/v1/messages/${id}/raw`;
  const response = await request(mf, path, alice);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'message/rfc822');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="message.eml"');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), raw);
  for (const [token, status] of [[bob, 404], [admin, 404], [undefined, 401]]) {
    const denied = await request(mf, path, token);
    assert.equal(denied.status, status);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(await (await request(mf, '/v1/messages', bob)).json(), { messages: [], cursor: null });
});

test('removed seatpool integration returns 404 for authenticated clients', async t => {
  const mf = await runtime(t, scoped), bucket = await mf.getR2Bucket('MAIL');
  const raw = new Uint8Array([255, 0]);
  await bucket.put(prefix(aliceAddr) + uuid(1), raw, { customMetadata: { to: aliceAddr } });
  for (const token of [alice, bob, admin]) {
    for (const path of [seat, seat + '?limit=1000&cursor=invalid']) {
      assert.equal((await request(mf, path, token)).status, 404);
    }
  }
  const response = await request(mf, '/messages/' + uuid(1), alice);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), raw);
});

test('email rejects over-limit and mismatched sizes without writing to R2', async t => {
  const mf = await runtime(t, { MAX_BYTES: '3' }), bucket = await mf.getR2Bucket('MAIL');
  const over = await send(mf, aliceAddr, 'abcd');
  assert.deepEqual(await over.json(), { rejection: 'Message exceeds configured size limit' });
  assert.equal((await send(mf, aliceAddr, 'ab', 1)).status, 500);
  assert.equal((await bucket.list()).objects.length, 0);
});

test('invalid configuration fails closed in workerd', async t => {
  const mf = await runtime(t, { MAILBOX_TOKENS: '{' });
  assert.equal((await request(mf, '/messages', admin)).status, 503);
  assert.equal((await send(mf, aliceAddr, 'x')).status, 500);
  assert.equal((await (await mf.getR2Bucket('MAIL')).list()).objects.length, 0);
});
