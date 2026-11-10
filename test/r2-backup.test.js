import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importArchive, exportArchive } from '../scripts/backup.mjs';

import { spawnSync } from 'node:child_process';

test('CLI refuses restore without explicit flag and never prints credentials', () => {
  const result = spawnSync(process.execPath, ['scripts/r2-backup.mjs', 'restore', 'unused'], { cwd: new URL('..', import.meta.url), env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--allow-restore/);
  assert.ok(!result.stderr.includes('fake-secret'));
});

const env = { R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com', R2_BUCKET: 'mail-test', R2_ACCESS_KEY_ID: 'fake-access', R2_SECRET_ACCESS_KEY: 'fake-secret' };
async function tooling() {
  assert.ok(await fs.access(new URL('../scripts/r2-backup.mjs', import.meta.url)).then(() => true, () => false), 'R2 connector must exist');
  return import('../scripts/r2-backup.mjs');
}
async function archivePath(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2-backup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'archive');
}
test('restore is gated and conditional PUT preserves metadata and refuses conflicts', async t => {
  const { createR2Client, restoreR2 } = await tooling();
  assert.equal(typeof restoreR2, 'function', 'restore API must exist');
  const source = await archivePath(t);
  await exportArchive([{ key: 'messages/a', bytes: Buffer.from([0, 255]), customMetadata: { from: 'sender@example.test', to: 'inbox@example.test', received: 'today' } }], source);
  const calls = [];
  let conflict = false;
  const client = createR2Client(env, { fetchImpl: async (url, init) => {
    calls.push(init);
    return new Response(null, { status: conflict ? 412 : 200 });
  } });
  await assert.rejects(restoreR2(client, source), /explicit/i);
  assert.equal(calls.length, 0);
  await restoreR2(client, source, { allowRestore: true });
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].headers.get('if-none-match'), '*');
  assert.equal(calls[0].headers.get('x-amz-meta-from'), 'sender@example.test');
  assert.deepEqual(calls[0].body, Buffer.from([0, 255]));
  conflict = true;
  await assert.rejects(restoreR2(client, source, { allowRestore: true }), e => e.code === 'ARCHIVE_RESTORE_FAILED' && e.completed === 0);
  conflict = false;
  await restoreR2(client, source, { allowRestore: true, overwrite: true });
  assert.equal(calls.at(-1).headers.has('if-none-match'), false);
});

test('backup rejects question-mark keys before any object GET and removes the incomplete archive', async t => {
  const { createR2Client, backupR2 } = await tooling();
  for (const key of ['messages/a?', 'messages/a?versionId=other', 'messages/a?one?two']) {
    const destination = await archivePath(t);
    const calls = [];
    const client = createR2Client(env, { fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), method: init.method });
      return new Response(new URL(url).searchParams.has('list-type') ? listing([key]) : 'bad');
    } });
    await assert.rejects(backupR2(client, destination), /Unsupported R2 object key/);
    assert.equal(calls.length, 1, 'only the listing request is allowed');
    assert.equal(calls[0].method, 'GET');
    assert.ok(calls[0].url.searchParams.has('list-type'));
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  }
});

test('restore rejects question-mark keys without issuing a PUT', async t => {
  const { createR2Client, restoreR2 } = await tooling();
  const source = await archivePath(t);
  await exportArchive([{ key: 'messages/a?versionId=other', bytes: Buffer.from('bad'), customMetadata: {} }], source);
  let requests = 0;
  const client = createR2Client(env, { fetchImpl: async () => {
    requests++;
    return new Response(null);
  } });
  await assert.rejects(restoreR2(client, source, { allowRestore: true }), e => e.code === 'ARCHIVE_RESTORE_FAILED' && e.completed === 0);
  assert.equal(requests, 0);
});

test('literal percent-encoded question marks remain distinct supported keys', async () => {
  const { createR2Client } = await tooling();
  const calls = [];
  const client = createR2Client(env, { fetchImpl: async url => {
    calls.push(new URL(url));
    return new Response('abc');
  } });
  await client.getObject('messages/a%3FversionId=other');
  assert.equal(calls.length, 1);
  assert.equal(decodeURIComponent(calls[0].pathname), '/mail-test/messages/a%3FversionId=other');
  assert.equal(calls[0].searchParams.has('versionId'), false);
  assert.ok(calls[0].searchParams.has('X-Amz-Signature'));
});

test('configuration fails closed without exposing environment values', async () => {
  const { createR2Client } = await tooling();
  for (const input of [{}, { ...env, R2_SECRET_ACCESS_KEY: '' }, { ...env, R2_ENDPOINT: 'http://account.r2.cloudflarestorage.com' }, { ...env, R2_ENDPOINT: 'https://fake-secret@example.com' }, { ...env, R2_ENDPOINT: 'https://example.com/path' }, { ...env, R2_BUCKET: 'bad/bucket' }]) {
    assert.throws(() => createR2Client(input), e => /configuration/i.test(e.message) && !e.message.includes('fake-secret'));
  }
});

test('invalid backup limits fail before touching remote or local state', async t => {
  const { backupR2 } = await tooling();
  for (const options of [{ maxPages: Infinity }, { pageSize: 0 }, { maxObjects: 10001 }, { maxTotalBytes: -1 }, { maxObjectBytes: 17000000 }, { prefix: 42 }, { unknown: true }]) {
    const destination = await archivePath(t);
    await assert.rejects(backupR2({}, destination, options), /option|limit/i);
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  }
});

test('backup stops duplicate cursors, extra pages, oversized bodies and cleans incomplete archives', async t => {
  const { createR2Client, backupR2 } = await tooling();
  for (const mode of ['cursor', 'page', 'body', 'xml', 'total', 'count', 'outside', 'fetch']) {
    const destination = await archivePath(t);
    let lists = 0;
    let gets = 0;
    const client = createR2Client(env, { fetchImpl: async url => {
      if (mode === 'fetch') throw new Error('fake-secret signed request failure');
      if (new URL(url).searchParams.has('list-type')) {
        lists++;
        if (mode === 'xml') return new Response('x'.repeat(1024 * 1024 + 1));
        return new Response(listing([mode === 'outside' ? 'not-mail/key' : `messages/${lists}`], ['cursor', 'page', 'count'].includes(mode) ? 'same' : ''));
      }
      gets++;
      return new Response(Buffer.alloc(mode === 'body' ? 4 : 3));
    } });
    await assert.rejects(backupR2(client, destination, { prefix: 'messages/', pageSize: 1, maxPages: mode === 'page' ? 1 : 3, maxObjectBytes: mode === 'body' ? 3 : 16 * 1024 * 1024, maxTotalBytes: mode === 'total' ? 2 : 256 * 1024 * 1024, maxObjects: mode === 'count' ? 1 : 10000 }), e => !e.message.includes('fake-secret'));
    assert.ok(lists <= (mode === 'page' ? 1 : 2));
    if (['total', 'outside'].includes(mode)) assert.equal(gets, 0);
    if (mode === 'count') assert.equal(gets, 1);
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  }
});

test('empty truncated pages cannot bypass page budget and parser failures are sanitized', async t => {
  const { createR2Client, backupR2 } = await tooling();
  for (const xml of [listing([], 'next'), '<secret>fake-secret</secret>']) {
    let requests = 0;
    const client = createR2Client(env, { fetchImpl: async () => {
      if (++requests > 3) throw new Error('test emergency stop');
      return new Response(xml);
    } });
    await assert.rejects(backupR2(client, await archivePath(t), { maxPages: 1 }), e => !e.message.includes('fake-secret'));
    assert.equal(requests, 1);
  }
});

const listing = (keys, token = '') => `<ListBucketResult>${keys.map(key => `<Contents><Key>${key}</Key><Size>3</Size><ETag>"etag"</ETag></Contents>`).join('')}<IsTruncated>${!!token}</IsTruncated>${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ''}</ListBucketResult>`;

test('backup signs only GET requests and archives paginated bytes and metadata', async t => {
  const { createR2Client, backupR2 } = await tooling();
  const calls = [];
  const client = createR2Client(env, { fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    if (new URL(url).searchParams.get('list-type')) {
      return new Response(listing([new URL(url).searchParams.has('continuation-token') ? 'messages/b' : 'messages/a'], new URL(url).searchParams.has('continuation-token') ? '' : 'next'));
    }
    return new Response(Uint8Array.of(0, 255, 10), { headers: { 'x-amz-meta-from': 'sender@example.test', 'x-amz-meta-to': 'inbox@example.test', 'x-amz-meta-received': '2026-01-01' } });
  } });
  const destination = await archivePath(t);
  await backupR2(client, destination, { prefix: 'messages/', pageSize: 1 });
  const records = [];
  await importArchive(destination, { put: async (key, bytes, { customMetadata }) => records.push({ key, bytes, customMetadata }) });
  assert.deepEqual(records.map(r => r.key), ['messages/a', 'messages/b']);
  assert.deepEqual(records[0].bytes, Buffer.from([0, 255, 10]));
  assert.deepEqual(records[0].customMetadata, { from: 'sender@example.test', to: 'inbox@example.test', received: '2026-01-01' });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url.searchParams.get('max-keys'), '1');
  assert.ok(calls.every(c => c.url.searchParams.has('X-Amz-Signature')));
});
