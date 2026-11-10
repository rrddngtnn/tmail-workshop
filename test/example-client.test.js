import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { TMailClient } from '../examples/tmail-client.mjs';

const id = '12345678-1234-4234-8234-123456789abc';
const envelope = { from: 'a@example.test', to: 'b@example.test', received: '2026-01-01T00:00:00Z' };

async function serve(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('lists a page with bearer authentication and returns envelope', async t => {
  const base = await serve(t, (req, res) => {
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers.authorization, 'Bearer secret');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ messages: [{ id, size: 5, envelope }], cursor: null }));
  });
  const client = new TMailClient(base, 'secret');
  assert.deepEqual(await client.listPage(), { messages: [{ id, size: 5, envelope }], cursor: null });
});

test('passes an opaque cursor and retrieves exact raw bytes', async t => {
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  const base = await serve(t, (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer secret');
    if (req.url.startsWith('/v1/messages?')) {
      assert.equal(new URL(req.url, 'http://localhost').searchParams.get('cursor'), 'a+/= ?');
      res.end(JSON.stringify({ messages: [{ id, size: 5, envelope }], cursor: null }));
    } else {
      assert.equal(req.url, `/v1/messages/${id}/raw`);
      res.setHeader('content-type', 'message/rfc822');
      res.end(bytes);
    }
  });
  const client = new TMailClient(base, 'secret');
  assert.deepEqual((await client.listPage('a+/= ?')).messages[0].envelope, envelope);
  assert.deepEqual(await client.getRaw(id), bytes);
});

test('raw downloads reject missing or incorrect MIME types and accept message/rfc822', async t => {
  let type;
  const bytes = Buffer.from([0, 255, 13, 10]);
  const base = await serve(t, (req, res) => {
    if (type !== undefined) res.setHeader('content-type', type);
    res.end(bytes);
  });
  const client = new TMailClient(base, 'secret');
  for (type of [undefined, 'text/html', 'application/json', 'application/octet-stream', 'message/rfc822-evil']) {
    await assert.rejects(client.getRaw(id), /content.type/i);
  }
  for (type of ['message/rfc822', 'Message/RFC822; charset=binary']) {
    assert.deepEqual(await client.getRaw(id), bytes);
  }
});

test('listing requires size to be a nonnegative safe integer', async t => {
  let message;
  const base = await serve(t, (req, res) => res.end(JSON.stringify({ messages: [message], cursor: null })));
  const client = new TMailClient(base, 'secret');
  for (const size of [undefined, null, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    message = { id, envelope, ...(size === undefined ? {} : { size }) };
    await assert.rejects(client.listPage(), /message size/i);
  }
  for (const size of [0, 1, Number.MAX_SAFE_INTEGER]) {
    message = { id, envelope, size };
    assert.equal((await client.listPage()).messages[0].size, size);
  }
});

test('explicitly follows successive opaque page cursors', async t => {
  const seen = [];
  const base = await serve(t, (req, res) => {
    const cursor = new URL(req.url, 'http://localhost').searchParams.get('cursor');
    seen.push(cursor);
    res.end(JSON.stringify({ messages: [{ id, size: 5, envelope }], cursor: cursor === null ? 'next/+=' : null }));
  });
  const client = new TMailClient(base, 'secret');
  const first = await client.listPage();
  const second = await client.listPage(first.cursor);
  assert.equal(second.cursor, null);
  assert.deepEqual(seen, [null, 'next/+=']);
});

test('rejects malformed pages, bad identifiers, HTTP errors, and redirects', async t => {
  let mode = 'shape';
  const base = await serve(t, (req, res) => {
    if (mode === 'shape') res.end(JSON.stringify({ messages: [{ id, envelope: { from: 42, to: null, received: null } }], cursor: null }));
    else if (mode === 'cursor') res.end(JSON.stringify({ messages: [], cursor: 42 }));
    else if (mode === 'status') { res.statusCode = 401; res.end('unauthorized'); }
    else { res.writeHead(302, { location: 'http://example.com/' }); res.end(); }
  });
  const client = new TMailClient(base, 'secret');
  await assert.rejects(client.listPage(), /invalid/i);
  mode = 'cursor'; await assert.rejects(client.listPage(), /invalid/i);
  await assert.rejects(client.getRaw('../escape'), /invalid/i);
  mode = 'status'; await assert.rejects(client.getRaw(id), /401/);
  mode = 'redirect'; await assert.rejects(client.listPage());
  assert.throws(() => new TMailClient('https://user:password@example.com/', 'secret'));
});
