// Standalone S3 transport; never imported by the Worker.
import { pathToFileURL } from 'node:url';
import { S3Client } from '@bradenmacdonald/s3-lite-client';
import { exportArchive, importArchive } from './backup.mjs';

export async function restoreR2(client, source, options = {}) {
  if (options.allowRestore !== true) throw new Error('Restore requires explicit allowRestore: true');
  await importArchive(source, { put: async (key, bytes, { customMetadata }) => {
    const headers = new Headers(Object.entries(customMetadata).map(([name, value]) => [`x-amz-meta-${name}`, value]));
    if (options.overwrite !== true) headers.set('if-none-match', '*');
    await client.makeRequest({ method: 'PUT', objectName: key, payload: bytes, headers });
  } }, { limits: options.limits });
}

const ceiling = { maxPages: 100, pageSize: 100, maxObjectBytes: 16 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxObjects: 10000 };
async function bounded(response, maximum) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Remote read limit exceeded');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export function createR2Client(env = process.env, { fetchImpl = fetch } = {}) {
  try {
    for (const name of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
      if (typeof env[name] !== 'string' || !env[name].length || /[\r\n]/.test(env[name])) throw new Error();
    }
    const url = new URL(env.R2_ENDPOINT);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET)) throw new Error();
  } catch { throw new Error('Invalid R2 configuration'); }
  class BucketClient extends S3Client {
    // Listing signs the bucket root, not an object; upstream presigning rejects it.
    checkNames(name, options) { return name === '' ? this.getBucketName(options) : super.checkNames(name, options); }
  }
  const client = new BucketClient({ endPoint: env.R2_ENDPOINT, bucket: env.R2_BUCKET, region: 'auto', accessKey: env.R2_ACCESS_KEY_ID, secretKey: env.R2_SECRET_ACCESS_KEY });
  // The library's default transport buffers XML/errors without limits and follows
  // redirects. Replace only transport, retaining its signing and S3 XML parser.
  client.makeRequest = async ({ method, payload, ...options }) => {
    // Upstream presignV4 splits the unescaped path on '?', silently truncating
    // these keys into a different object and treating their suffix as a query.
    // Reject before signing or fetching; pre-encoding would double-encode keys.
    if (options.objectName.includes('?')) throw new Error('Unsupported R2 object key');
    const url = await client.getPresignedUrl(method, options.objectName, { parameters: options.query, extraHeaders: Object.fromEntries(options.headers ?? []), expirySeconds: 60 });
    try {
      const response = await fetchImpl(url, { method, headers: options.headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (response.status !== (options.statusCode ?? 200)) {
        await response.body?.cancel();
        throw new Error();
      }
      const bytes = await bounded(response, options.objectName === '' ? 1024 * 1024 : ceiling.maxObjectBytes);
      return new Response(bytes, { status: response.status, headers: response.headers });
    } catch { throw new Error('Remote request failed or read limit exceeded'); }
  };
  return client;
}

export async function backupR2(client, destination, options = {}) {
  const settings = { ...ceiling, prefix: '', ...options };
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'prefix') {
      if (typeof value !== 'string') throw new Error('Invalid backup option');
    } else if (!(key in ceiling) || !Number.isSafeInteger(value) || value < (['pageSize', 'maxPages'].includes(key) ? 1 : 0) || value > ceiling[key]) {
      throw new Error('Invalid backup limit');
    }
  }
  async function* records() {
    let continuationToken;
    let count = 0;
    let total = 0;
    const tokens = new Set();
    for (let page = 0; page < settings.maxPages; page++) {
      // Upstream auto-pagination can fetch additional empty/short pages inside
      // a single next(). Bound actual requests, not only yielded results.
      const pageClient = Object.create(client);
      let requests = 0;
      pageClient.makeRequest = async args => {
        if (++requests > 1) throw new Error('Remote short truncated page rejected');
        return client.makeRequest(args);
      };
      const iterator = pageClient.listObjectsGrouped({ prefix: settings.prefix, delimiter: '', pageSize: settings.pageSize, maxResults: settings.pageSize, continuationToken });
      let entries = 0;
      while (true) {
        let next;
        try { next = await iterator.next(); }
        catch { throw new Error('Remote listing failed'); }
        if (next.done) { continuationToken = next.value; break; }
        const object = next.value;
        if (++entries > settings.pageSize || ++count > settings.maxObjects || object.type !== 'Object' || typeof object.key !== 'string' || !object.key.startsWith(settings.prefix) ||
            !Number.isSafeInteger(object.size) || object.size < 0 || object.size > settings.maxObjectBytes || total + object.size > settings.maxTotalBytes) throw new Error('Remote object limit or scope invalid');
        const response = await client.getObject(object.key);
        const customMetadata = Object.fromEntries([...response.headers].filter(([key]) => key.startsWith('x-amz-meta-')).map(([key, value]) => [key.slice(11), value]));
        const bytes = await bounded(response, Math.min(settings.maxObjectBytes, settings.maxTotalBytes - total));
        if (bytes.length !== object.size) throw new Error('Remote size changed');
        total += bytes.length;
        yield { key: object.key, bytes, customMetadata };
      }
      if (!continuationToken) return;
      if (typeof continuationToken !== 'string' || tokens.has(continuationToken)) throw new Error('Remote cursor repeated');
      tokens.add(continuationToken);
    }
    throw new Error('Remote page limit exceeded');
  }
  await exportArchive(records(), destination, { limits: Object.fromEntries(Object.entries(settings).filter(([key]) => ['maxObjectBytes', 'maxTotalBytes', 'maxObjects'].includes(key))) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, archive, ...flags] = process.argv.slice(2);
    if (!['backup', 'restore'].includes(command) || !archive || archive.startsWith('--') || flags.some(flag => !['--allow-restore', '--overwrite'].includes(flag)) ||
        (command === 'backup' && flags.length)) throw new Error('Usage: backup ARCHIVE | restore ARCHIVE --allow-restore [--overwrite]');
    if (command === 'restore' && !flags.includes('--allow-restore')) throw new Error('Restore requires --allow-restore');
    const client = createR2Client();
    if (command === 'backup') await backupR2(client, archive);
    else await restoreR2(client, archive, { allowRestore: true, overwrite: flags.includes('--overwrite') });
    process.stdout.write('Archive operation complete\n');
  } catch {
    process.stderr.write('Archive operation failed. Usage: backup ARCHIVE | restore ARCHIVE --allow-restore [--overwrite]. Check configuration, limits and archive; restore may be partial.\n');
    process.exitCode = 1;
  }
}
