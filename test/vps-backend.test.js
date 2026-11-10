import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, chmod, writeFile, symlink, mkdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

async function streamingRequest(base, t) {
  const socket = connect(Number(new URL(base).port), '127.0.0.1');
  t.after(() => socket.destroy());
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(`POST /ingest HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${ingestToken}\r\nContent-Type: message/rfc822\r\nX-Envelope-To: box@example.test\r\nX-Envelope-From:\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n`);
  return socket;
}
import { TMailClient } from '../examples/tmail-client.mjs';

const ingestToken = 'i'.repeat(40), readToken = 'r'.repeat(40), otherToken = 's'.repeat(40);
const mailboxTokens = { 'box@example.test': readToken, 'other@example.test': otherToken };
async function fixture(t, overrides = {}) {
  const { createBackend } = await import('../apps/vps/server.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'tmail-vps-'));
  const options = { dbPath: join(dir, 'mail.sqlite'), ingestToken, mailboxTokens, ...overrides };
  let backend;
  async function start() {
    backend = createBackend(options);
    backend.server.listen(0, '127.0.0.1');
    await once(backend.server, 'listening');
    return `http://127.0.0.1:${backend.server.address().port}`;
  }
  async function stop() { await new Promise(resolve => backend.server.close(resolve)); backend.close(); }
  const base = await start();
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  return { base, stop, start, options, closeStorage: () => backend.close() };
}
function ingest(base, bytes, headers = {}, token = ingestToken) {
  return fetch(base + '/ingest', { method: 'POST', headers: {
    authorization: 'Bearer ' + token, 'content-type': 'message/rfc822',
    'x-envelope-to': 'Box@Example.Test', 'x-envelope-from': '', ...headers,
  }, body: bytes });
}

test('VPS shutdown bounds actively streaming requests and never commits a partial body', async t => {
  const { createBackend } = await import('../apps/vps/server.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'tmail-shutdown-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'mail.sqlite');
  const backend = createBackend({ dbPath, ingestToken, mailboxTokens, shutdownTimeoutMs: 50 });
  t.after(() => { backend.server.closeAllConnections(); backend.server.close(); backend.close(); });
  backend.server.listen(0, '127.0.0.1');
  await once(backend.server, 'listening');
  const received = once(backend.server, 'request');
  const socket = await streamingRequest(`http://127.0.0.1:${backend.server.address().port}`, t);
  await received;
  const trickle = setInterval(() => socket.write('1\r\nx\r\n'), 10);
  t.after(() => clearInterval(trickle));
  const closed = new Promise(resolve => socket.once('close', () => { clearInterval(trickle); resolve(); }));
  const deadline = AbortSignal.timeout(1000);
  await Promise.race([
    (async () => { await backend.shutdown(); await closed; })(),
    new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error('Shutdown exceeded deadline')), { once: true })),
  ]);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try { assert.equal(db.prepare('SELECT count(*) AS total FROM messages').get().total, 0); }
  finally { db.close(); }
});

test('VPS expires incomplete incoming bodies and headers without storing partial MIME', async t => {
  const f = await fixture(t, { requestTimeoutMs: 300 });
  for (const headersOnly of [false, true]) {
    const socket = headersOnly ? connect(Number(new URL(f.base).port), '127.0.0.1') : await streamingRequest(f.base, t);
    t.after(() => socket.destroy());
    socket.on('error', () => {});
    let response = '';
    socket.on('data', data => { response += data; });
    if (headersOnly) { await once(socket, 'connect'); socket.write('POST /ingest HTTP/1.1\r\nHost:'); }
    const timer = setTimeout(() => socket.destroy(), 1000);
    await new Promise(resolve => socket.once('close', resolve));
    clearTimeout(timer);
    assert.match(response, /HTTP\/1\.1 408/);
  }
  await f.stop();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(f.options.dbPath);
  try { assert.equal(db.prepare('SELECT count(*) AS total FROM messages').get().total, 0); }
  finally { db.close(); }
});

test('VPS creates private SQLite database and sidecars regardless of umask', async t => {
  const f = await fixture(t);
  await ingest(f.base, Buffer.from('private'));
  for (const suffix of ['', '-wal', '-shm']) {
    assert.equal((await stat(f.options.dbPath + suffix)).mode & 0o777, 0o600, suffix || 'database');
  }
});

test('VPS rejects unsafe SQLite paths without modifying link targets or permissions', async t => {
  const { createBackend } = await import('../apps/vps/server.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'tmail-paths-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { ingestToken, mailboxTokens };
  for (const kind of ['public-db', 'wal-link', 'database-link', 'shm-link', 'parent-link', 'public-parent', 'public-wal', 'hardlink']) {
    const parent = join(dir, kind);
    await mkdir(parent, { mode: 0o700 });
    const target = join(parent, 'target');
    await writeFile(target, '', { mode: 0o600 });
    let dbPath = join(parent, 'mail.sqlite');
    if (kind === 'database-link') await symlink(target, dbPath);
    if (kind === 'wal-link') await symlink(target, dbPath + '-wal');
    if (kind === 'shm-link') await symlink(target, dbPath + '-shm');
    if (kind === 'parent-link') { await symlink(parent, join(dir, 'alias')); dbPath = join(dir, 'alias', 'mail.sqlite'); }
    if (kind === 'public-parent') await chmod(parent, 0o755);
    if (kind === 'public-db') await writeFile(dbPath, '', { mode: 0o644 });
    if (kind === 'public-wal') await writeFile(dbPath + '-wal', '', { mode: 0o644 });
    if (kind === 'hardlink') await link(target, dbPath);
    let backend;
    try { assert.throws(() => { backend = createBackend({ ...options, dbPath }); }, /Unsafe SQLite path/, kind); }
    finally { backend?.close(); }
    assert.equal((await stat(target)).size, 0, kind);
    assert.equal((await stat(target)).mode & 0o777, 0o600, kind);
  }
});

test('VPS separates ingest authentication from mailbox reads and isolates recipients', async t => {
  const { base } = await fixture(t);
  for (const token of ['', readToken, otherToken, 'wrong']) assert.equal((await ingest(base, Buffer.from('no'), {}, token)).status, 401);
  const saved = await (await ingest(base, Buffer.from('yes'))).json();
  for (const token of ['', ingestToken, 'wrong']) {
    const response = await fetch(base + '/v1/messages', { headers: { authorization: 'Bearer ' + token } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual((await new TMailClient(base, otherToken).listPage()).messages, []);
  await assert.rejects(new TMailClient(base, otherToken).getRaw(saved.id), /404/);
  assert.equal((await new TMailClient(base, readToken).listPage()).messages.length, 1);
});

test('VPS rejects unknown or invalid envelope recipients without storing MIME', async t => {
  const { base } = await fixture(t);
  for (const to of ['unknown@example.test', 'invalid', 'a@example.test,b@example.test', '']) {
    assert.equal((await ingest(base, Buffer.from('To: box@example.test'), { 'x-envelope-to': to })).status, 400);
  }
  assert.equal((await ingest(base, Buffer.from('no'), { 'x-envelope-from': 'invalid' })).status, 400);
  const headers = { authorization: 'Bearer ' + ingestToken, 'content-type': 'message/rfc822' };
  assert.equal((await fetch(base + '/ingest', { method: 'POST', headers, body: 'no' })).status, 400);
  assert.deepEqual((await new TMailClient(base, readToken).listPage()).messages, []);
});

test('VPS enforces raw MIME byte limit on declared and chunked bodies', async t => {
  const { base } = await fixture(t, { maxBytes: 5 });
  assert.equal((await ingest(base, Buffer.alloc(6))).status, 413);
  const body = new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(3)); c.enqueue(Buffer.alloc(3)); c.close(); } });
  const response = await fetch(base + '/ingest', { method: 'POST', duplex: 'half', headers: {
    authorization: 'Bearer ' + ingestToken, 'content-type': 'message/rfc822', 'x-envelope-to': 'box@example.test', 'x-envelope-from': '',
  }, body });
  assert.equal(response.status, 413);
  assert.deepEqual((await new TMailClient(base, readToken).listPage()).messages, []);
  assert.equal((await ingest(base, Buffer.alloc(5))).status, 201);
  assert.equal((await ingest(base, Buffer.alloc(0))).status, 201);
  assert.equal((await ingest(base, Buffer.from('x'), { 'content-type': 'application/json' })).status, 415);
});

test('VPS pagination resumes after database reopen without skipping concurrent arrivals', async t => {
  const f = await fixture(t, { pageSize: 2 });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await (await ingest(f.base, Buffer.from([i, 255]))).json()).id);
  const first = await new TMailClient(f.base, readToken).listPage();
  assert.equal(first.messages.length, 2);
  assert.equal(typeof first.cursor, 'string');
  await f.stop();
  const base = await f.start();
  const client = new TMailClient(base, readToken);
  assert.deepEqual(await client.getRaw(ids[0]), Buffer.from([0, 255]));
  ids.push((await (await ingest(base, Buffer.from('new'))).json()).id);
  const seen = first.messages.map(m => m.id);
  let cursor = first.cursor;
  do {
    const page = await client.listPage(cursor);
    seen.push(...page.messages.map(m => m.id));
    cursor = page.cursor;
  } while (cursor !== null);
  assert.deepEqual(seen, ids);
  assert.equal((await fetch(base + '/v1/messages?cursor=garbage', { headers: { authorization: 'Bearer ' + readToken } })).status, 400);
  assert.equal((await fetch(base + '/v1/messages?cursor=' + encodeURIComponent(first.cursor), { headers: { authorization: 'Bearer ' + otherToken } })).status, 400);
});

test('VPS configuration fails closed for weak, overlapping or malformed credentials and limits', async () => {
  const { createBackend } = await import('../apps/vps/server.mjs');
  const options = { dbPath: ':memory:', ingestToken, mailboxTokens };
  for (const changes of [
    { ingestToken: undefined }, { ingestToken: 'short' }, { dbPath: '' },
    { mailboxTokens: {} }, { mailboxTokens: [] }, { mailboxTokens: null },
    { mailboxTokens: { 'box@example.test': ingestToken } },
    { mailboxTokens: { 'box@example.test': readToken, 'other@example.test': readToken } },
    { mailboxTokens: { 'Box@example.test': readToken } }, { mailboxTokens: { 'invalid': readToken } },
    { mailboxTokens: { 'box@example.test': 'weak' } },
    { maxBytes: 0 }, { maxBytes: 26214401 }, { maxBytes: NaN }, { maxBytes: '5' },
    { pageSize: 0 }, { pageSize: 101 },
    ...[0, -1, NaN, '50', 300001].flatMap(value => [{ shutdownTimeoutMs: value }, { requestTimeoutMs: value }]),
  ]) assert.throws(() => createBackend({ ...options, ...changes }), /Invalid/);
});

test('VPS storage failures return sanitized retryable responses rather than acknowledge delivery', async t => {
  const f = await fixture(t);
  f.closeStorage();
  const response = await fetch(f.base + '/v1/messages', { headers: { authorization: 'Bearer ' + readToken }, signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'Service unavailable');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const delivery = await ingest(f.base, Buffer.from('private body'));
  assert.equal(delivery.status, 503);
  assert.equal(await delivery.text(), 'Service unavailable');
});

test('VPS standalone command defaults to loopback and survives a process restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tmail-vps-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, TMAIL_DB_PATH: join(dir, 'mail.sqlite'), TMAIL_INGEST_TOKEN: ingestToken,
    MAILBOX_TOKENS: JSON.stringify(mailboxTokens), TMAIL_PORT: '0' };
  delete env.TMAIL_HOST;
  async function start() {
    const child = spawn(process.execPath, ['apps/vps/server.mjs'], { cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stderr.on('data', data => { errors += data; });
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('CLI did not listen: ' + errors)); }, 2000);
      child.stdout.on('data', data => {
        output += data;
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('CLI exited without loopback listener: ' + errors)); });
    });
    const stop = async () => { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; };
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) await stop(); });
    return { url, stop };
  }
  const first = await start();
  const id = (await (await ingest(first.url, Buffer.from([255, 0, 13, 10]))).json()).id;
  await first.stop();
  const second = await start();
  assert.deepEqual(await new TMailClient(second.url, readToken).getRaw(id), Buffer.from([255, 0, 13, 10]));
  await second.stop();
});

test('VPS command rejects malformed environment without listening or exposing secrets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tmail-vps-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const valid = { TMAIL_DB_PATH: join(dir, 'mail.sqlite'), TMAIL_INGEST_TOKEN: ingestToken,
    MAILBOX_TOKENS: JSON.stringify(mailboxTokens), TMAIL_PORT: '0' };
  for (const change of [
    { TMAIL_PORT: '' }, { TMAIL_PORT: '-1' }, { TMAIL_PORT: '1.5' }, { TMAIL_PORT: '65536' },
    { TMAIL_HOST: '' }, { TMAIL_MAX_BYTES: '0' }, { TMAIL_PAGE_SIZE: '101' },
    { MAILBOX_TOKENS: '{private-invalid-json' }, { TMAIL_DB_PATH: '' }, { TMAIL_INGEST_TOKEN: 'private-weak-secret' },
  ]) {
    const env = { ...process.env, ...valid };
    for (const key of ['TMAIL_HOST', 'TMAIL_MAX_BYTES', 'TMAIL_PAGE_SIZE']) delete env[key];
    Object.assign(env, change);
    const child = spawn(process.execPath, ['apps/vps/server.mjs'], {
      cwd: new URL('..', import.meta.url), env, timeout: 1000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const [code, signal] = await once(child, 'close');
    assert.equal(code, 1, `Invalid ${Object.keys(change)[0]} must exit with status 1 (signal ${signal})`);
    assert.equal(stdout, '');
    for (const value of [ingestToken, ...Object.values(mailboxTokens), valid.TMAIL_DB_PATH,
      '{private-invalid-json', 'private-weak-secret']) assert.ok(!stderr.includes(value), 'stderr must not expose private configuration');
    const diagnostic = /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g;
    assert.equal(stderr.replace(diagnostic, ''), 'VPS startup failed\n');
  }
});

test('VPS stores byte-exact MIME and trusted envelope compatible with existing client', async t => {
  const { base } = await fixture(t);
  const raw = Buffer.concat([Buffer.from('To: other@example.test\r\nDelivered-To: spoof@example.test\r\n\r\n'), Buffer.from([0, 255, 128, 13, 10])]);
  const response = await ingest(base, raw);
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const client = new TMailClient(base, readToken);
  const page = await client.listPage();
  assert.equal(page.cursor, null);
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].id, id);
  assert.equal(page.messages[0].size, raw.length);
  assert.deepEqual({ ...page.messages[0].envelope, received: null }, { from: '', to: 'Box@Example.Test', received: null });
  assert.ok(Number.isFinite(Date.parse(page.messages[0].envelope.received)));
  assert.deepEqual(await client.getRaw(id), raw);
  const download = await fetch(`${base}/v1/messages/${id}/raw`, { headers: { authorization: 'Bearer ' + readToken } });
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(download.headers.get('content-disposition'), /^attachment/);
});
