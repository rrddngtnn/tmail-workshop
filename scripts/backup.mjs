// Offline archive transport; requires exclusive control of local archive paths.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const defaults = Object.freeze({ maxObjects: 10000, maxObjectBytes: 16 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxManifestBytes: 8 * 1024 * 1024 });
function limitsFor(options) {
  const limits = { ...defaults, ...options?.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in defaults) || !Number.isSafeInteger(value) || value < 0 || value > defaults[key]) throw new Error('Invalid archive limit');
  }
  return limits;
}
function checkLimit(value, maximum) {
  if (value > maximum) throw new Error('Archive resource limit exceeded');
}
function validMetadata(metadata) {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) && Object.values(metadata).every(value => typeof value === 'string');
}
async function rejectSymlinks(target) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Archive symlink rejected');
  }
}
// Fixed-size reads avoid unbounded allocation if a file grows after stat.
async function readBounded(file, maximum) {
  await rejectSymlinks(file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Archive requires regular files');
    checkLimit(stat.size, maximum);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('Archive size changed');
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new Error('Archive size changed');
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function exportArchive(records, destination, options = {}) {
  const limits = limitsFor(options);
  await rejectSymlinks(path.dirname(path.resolve(destination)));
  // Exclusive mkdir refuses even an existing empty directory or symlink.
  await fs.mkdir(destination, { mode: 0o700 });
  try {
    const objects = [];
    const keys = new Set();
    let total = 0;
    let manifestSize = Buffer.byteLength('{"version":1,"objects":[]}');
    for await (const record of records) {
      if (!record || typeof record.key !== 'string' || !record.key.length || keys.has(record.key) ||
          !(record.bytes instanceof Uint8Array) || !validMetadata(record.customMetadata)) throw new Error('Invalid export record');
      checkLimit(objects.length + 1, limits.maxObjects);
      checkLimit(record.bytes.length, limits.maxObjectBytes);
      total += record.bytes.length;
      checkLimit(total, limits.maxTotalBytes);
      const bytes = Buffer.from(record.bytes);
      const object = { key: record.key, customMetadata: { ...record.customMetadata }, file: `${objects.length}.bin`, size: bytes.length, sha256: digest(bytes) };
      manifestSize += Buffer.byteLength(JSON.stringify(object)) + (objects.length ? 1 : 0);
      checkLimit(manifestSize, limits.maxManifestBytes);
      await fs.writeFile(path.join(destination, object.file), bytes, { mode: 0o600, flag: 'wx' });
      keys.add(object.key);
      objects.push(object);
    }
    const manifest = JSON.stringify({ version: 1, objects });
    checkLimit(Buffer.byteLength(manifest), limits.maxManifestBytes);
    await fs.writeFile(path.join(destination, 'manifest.json'), manifest, { mode: 0o600, flag: 'wx' });
    await fs.writeFile(path.join(destination, 'manifest.sha256'), digest(manifest), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function importArchive(source, sink, options = {}) {
  const limits = limitsFor(options);
  await rejectSymlinks(source);
  const raw = await readBounded(path.join(source, 'manifest.json'), limits.maxManifestBytes);
  const checksum = (await readBounded(path.join(source, 'manifest.sha256'), 64)).toString('utf8');
  if (digest(raw) !== checksum) throw new Error('Archive manifest checksum mismatch');
  const manifest = JSON.parse(raw);
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.objects)) throw new Error('Invalid archive manifest');
  checkLimit(manifest.objects.length, limits.maxObjects);
  const keys = new Set();
  let total = 0;
  manifest.objects.forEach((object, index) => {
    if (!object || typeof object.key !== 'string' || !object.key.length || keys.has(object.key) ||
        object.file !== `${index}.bin` || !Number.isSafeInteger(object.size) || object.size < 0 ||
        typeof object.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(object.sha256) ||
        !validMetadata(object.customMetadata)) throw new Error('Invalid archive entry');
    keys.add(object.key);
    checkLimit(object.size, limits.maxObjectBytes);
    total += object.size;
    checkLimit(total, limits.maxTotalBytes);
  });
  async function verifiedBytes(object) {
    const bytes = await readBounded(path.join(source, object.file), limits.maxObjectBytes);
    if (bytes.length !== object.size || digest(bytes) !== object.sha256) throw new Error('Archive checksum or size mismatch');
    return bytes;
  }
  // Full preflight before writes, then reread/recheck one object at a time.
  for (const object of manifest.objects) await verifiedBytes(object);
  let completed = 0;
  for (const object of manifest.objects) {
    try {
      const bytes = await verifiedBytes(object);
      await sink.put(object.key, bytes, { customMetadata: object.customMetadata });
      completed++;
    } catch (cause) {
      const error = new Error('Archive restore stopped; sink may contain partial writes', { cause });
      Object.assign(error, { code: 'ARCHIVE_RESTORE_FAILED', completed, failedKey: object.key });
      throw error;
    }
  }
}
