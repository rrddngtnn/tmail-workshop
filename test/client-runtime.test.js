import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { TMailClient } from '../examples/tmail-client.mjs';

// Real HTTP from the unmodified example client to workerd and local R2.
// No mocked global fetch and no cloud resources.
test('example client reads paginated workerd mailboxes and exact inbound bytes over HTTP', async t => {
  const token = 'b'.repeat(40), other = 'c'.repeat(40), admin = 'a'.repeat(40);
  const address = 'box@example.test';
  const mf = new Miniflare({ modules: true,
    scriptPath: fileURLToPath(new URL('./runtime-harness.mjs', import.meta.url)),
    compatibilityDate: '2025-04-01', host: '127.0.0.1', port: 0,
    r2Buckets: ['MAIL'], bindings: { API_TOKEN: admin,
      MAILBOX_TOKENS: JSON.stringify({ [address]: token, 'other@example.test': other }) },
  });
  t.after(() => mf.dispose());
  const origin = (await mf.ready).origin;
  const raw = Buffer.from([0, 255, 13, 10, 128]);
  const sent = await fetch(origin + '/__test_email', { method: 'POST', body: raw,
    headers: { 'x-test-from': 'sender@example.test', 'x-test-to': address } });
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { rejection: null });
  const client = new TMailClient(origin, token);
  const inbound = (await client.listPage()).messages[0];
  assert.equal(inbound.size, raw.length);
  assert.equal(inbound.envelope.from, 'sender@example.test');
  assert.equal(inbound.envelope.to, address);
  assert.ok(!Number.isNaN(Date.parse(inbound.envelope.received)));
  assert.deepEqual(await client.getRaw(inbound.id), raw);

  const bucket = await mf.getR2Bucket('MAIL');
  const prefix = `mailboxes/${createHash('sha256').update(address).digest('hex')}/messages/`;
  await Promise.all(Array.from({ length: 100 }, (_, i) => bucket.put(
    prefix + `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, raw)));
  const first = await client.listPage();
  assert.equal(first.messages.length, 100);
  assert.equal(typeof first.cursor, 'string');
  const second = await client.listPage(first.cursor);
  assert.equal(second.messages.length, 1);
  assert.equal(second.cursor, null);
  assert.equal(new Set([...first.messages, ...second.messages].map(m => m.id)).size, 101);
  assert.deepEqual(first.messages[0].envelope, { from: null, to: null, received: null });
  const otherClient = new TMailClient(origin, other);
  assert.deepEqual(await otherClient.listPage(), { messages: [], cursor: null });
  await assert.rejects(otherClient.getRaw(inbound.id), /404/);
  await assert.rejects(new TMailClient(origin, admin).listPage(), /404/);
  await assert.rejects(new TMailClient(origin, 'wrong').listPage(), /401/);
});
