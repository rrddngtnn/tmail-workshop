import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const moduleURL = new URL('../scripts/backup.mjs', import.meta.url);
async function tooling() {
  assert.ok(await fs.access(moduleURL).then(() => true, () => false), 'standalone backup tooling must exist');
  return import(pathToFileURL(moduleURL.pathname));
}
async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tmail-backup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('unsafe manifest schemas and payload paths fail before writes', async t => {
  const { exportArchive, importArchive } = await tooling();
  const root = await workspace(t);
  const archive = path.join(root, 'archive');
  await exportArchive(records(), archive);
  const file = path.join(archive, 'manifest.json');
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  const mutations = [
    m => { m.version = 2; },
    m => { m.objects[0].file = '../escape'; },
    m => { m.objects[0].file = '/absolute'; },
    m => { m.objects[0].file = 'nested/../0.bin'; },
    m => { m.objects[1].key = m.objects[0].key; },
    m => { m.objects[0].customMetadata = { from: 123 }; },
    m => { m.objects[0].size = -1; },
    m => { m.objects[0].sha256 = 'invalid'; },
  ];
  for (const mutate of mutations) {
    const manifest = structuredClone(original);
    mutate(manifest);
    const raw = JSON.stringify(manifest);
    await fs.writeFile(file, raw);
    await fs.writeFile(path.join(archive, 'manifest.sha256'), createHash('sha256').update(raw).digest('hex'));
    let writes = 0;
    await assert.rejects(importArchive(archive, { put: async () => writes++ }));
    assert.equal(writes, 0);
  }
});

test('invalid export records are rejected without publishing a partial archive', async t => {
  const { exportArchive } = await tooling();
  const root = await workspace(t);
  const invalid = [
    [...records(), records()[0]],
    [{ ...records()[0], key: '' }],
    [{ ...records()[0], customMetadata: { from: 123 } }],
    [{ ...records()[0], bytes: 'not raw bytes' }],
  ];
  for (const input of invalid) {
    const archive = path.join(root, 'archive');
    await assert.rejects(exportArchive(input, archive));
    await assert.rejects(fs.lstat(archive), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(root), []);
  }
});

test('symlinked archive components are rejected before sink writes', async t => {
  const { exportArchive, importArchive } = await tooling();
  const root = await workspace(t);
  for (const target of ['manifest.json', 'manifest.sha256', '0.bin', 'source', 'parent']) {
    const base = path.join(root, target.replace('.', '-'));
    await fs.mkdir(base);
    const archive = path.join(base, 'archive');
    await exportArchive(records(), archive);
    let source = archive;
    if (target === 'source' || target === 'parent') {
      const link = path.join(root, `link-${target}`);
      await fs.symlink(target === 'source' ? archive : base, link);
      source = target === 'source' ? link : path.join(link, 'archive');
    } else {
      const original = path.join(archive, target);
      await fs.rename(original, `${original}.real`);
      await fs.symlink(`${original}.real`, original);
    }
    let writes = 0;
    await assert.rejects(importArchive(source, { put: async () => writes++ }), /symlink/i);
    assert.equal(writes, 0);
  }
});

test('manifest checksum detects key and metadata corruption before writes', async t => {
  const { exportArchive, importArchive } = await tooling();
  const root = await workspace(t);
  const archive = path.join(root, 'archive');
  await exportArchive(records(), archive);
  const file = path.join(archive, 'manifest.json');
  const original = await fs.readFile(file, 'utf8');
  for (const field of ['key', 'customMetadata']) {
    const manifest = JSON.parse(original);
    if (field === 'key') manifest.objects[0].key = 'altered-key';
    else manifest.objects[0].customMetadata.from = 'altered@example.test';
    await fs.writeFile(file, JSON.stringify(manifest));
    let writes = 0;
    await assert.rejects(importArchive(archive, { put: async () => writes++ }), /manifest checksum/i);
    assert.equal(writes, 0);
  }
});

test('resource limits bound export and import before writes', async t => {
  const { exportArchive, importArchive } = await tooling();
  const root = await workspace(t);
  for (const limits of [{ maxObjects: 1 }, { maxObjectBytes: 4 }, { maxTotalBytes: 4 }, { maxManifestBytes: 32 }]) {
    const destination = path.join(root, 'limited');
    await assert.rejects(exportArchive(records(), destination, { limits }), /limit/i);
    await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
  }
  const archive = path.join(root, 'archive');
  await exportArchive(records(), archive);
  for (const limits of [{ maxObjects: 1 }, { maxObjectBytes: 4 }, { maxTotalBytes: 4 }, { maxManifestBytes: 32 }]) {
    let writes = 0;
    await assert.rejects(importArchive(archive, { put: async () => writes++ }, { limits }), /limit/i);
    assert.equal(writes, 0);
  }
});

test('sink failure reports partial restore and stops without rollback claims', async t => {
  const { exportArchive, importArchive } = await tooling();
  const root = await workspace(t);
  const archive = path.join(root, 'archive');
  await exportArchive([...records(), { ...records()[0], key: 'third' }], archive);
  const attempted = [];
  const failure = new Error('sink refused');
  await assert.rejects(importArchive(archive, { put: async key => {
    attempted.push(key);
    if (attempted.length === 2) throw failure;
  } }), error => {
    assert.equal(error.code, 'ARCHIVE_RESTORE_FAILED');
    assert.equal(error.completed, 1);
    assert.equal(error.failedKey, records()[1].key);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.deepEqual(attempted, records().map(record => record.key));
});

test('existing export destinations are preserved including symlinks and empty directories', async t => {
  const { exportArchive } = await tooling();
  const root = await workspace(t);
  const existing = path.join(root, 'existing');
  await fs.mkdir(existing);
  await assert.rejects(exportArchive(records(), existing));
  assert.deepEqual(await fs.readdir(existing), []);
  await fs.writeFile(path.join(existing, 'keep'), 'unchanged');
  await assert.rejects(exportArchive(records(), existing));
  const link = path.join(root, 'link');
  await fs.symlink(existing, link);
  await assert.rejects(exportArchive(records(), link));
  assert.equal(await fs.readFile(path.join(existing, 'keep'), 'utf8'), 'unchanged');
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test('export iterator failure removes the incomplete archive', async t => {
  const { exportArchive } = await tooling();
  const root = await workspace(t);
  const archive = path.join(root, 'archive');
  async function* interrupted() {
    yield records()[0];
    throw new Error('interrupted source');
  }
  await assert.rejects(exportArchive(interrupted(), archive), /interrupted source/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('payload changes during restore are rechecked and report partial completion', async t => {
  const { exportArchive, importArchive } = await tooling();
  const root = await workspace(t);
  const archive = path.join(root, 'archive');
  await exportArchive(records(), archive);
  let writes = 0;
  await assert.rejects(importArchive(archive, { put: async () => {
    writes++;
    await fs.writeFile(path.join(archive, '1.bin'), 'changed');
  } }), error => {
    assert.equal(error.code, 'ARCHIVE_RESTORE_FAILED');
    assert.equal(error.completed, 1);
    assert.match(error.cause.message, /checksum|size/);
    return true;
  });
  assert.equal(writes, 1);
});

const records = () => [
  { key: 'messages/one', bytes: Buffer.from([0, 255, 13, 10, 128]), customMetadata: { from: 'sender@example.test', to: 'inbox@example.test', received: '2026-01-01T00:00:00.000Z', extra: '日本語' } },
  { key: 'mailboxes/abc/messages/two', bytes: Buffer.alloc(0), customMetadata: {} },
];

test('portable archive round trips exact raw bytes, keys and all custom metadata', async t => {
  const { exportArchive, importArchive } = await tooling();
  const root = await workspace(t);
  const archive = path.join(root, 'archive');
  await exportArchive(records(), archive);
  const restored = [];
  await importArchive(archive, { put: async (key, bytes, options) => restored.push({ key, bytes, customMetadata: options.customMetadata }) });
  assert.deepEqual(restored, records());
  const manifest = JSON.parse(await fs.readFile(path.join(archive, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.match(manifest.objects[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.objects[0].size, 5);
});

test('corruption is rejected before any sink writes including later objects', async t => {
  const { exportArchive, importArchive } = await tooling();
  const root = await workspace(t);
  const archive = path.join(root, 'archive');
  await exportArchive(records(), archive);
  await fs.writeFile(path.join(archive, '1.bin'), 'tampered');
  const writes = [];
  await assert.rejects(importArchive(archive, { put: async (...args) => writes.push(args) }), /checksum|size/i);
  assert.equal(writes.length, 0);
});
