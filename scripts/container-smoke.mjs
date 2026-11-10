import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const id = 'tmail-smoke-' + randomBytes(8).toString('hex');
const dir = mkdtempSync(join(tmpdir(), 'tmail-container-'));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const token = () => randomBytes(32).toString('hex');
  const file = join(dir, 'env');
  writeFileSync(file, `TMAIL_INGEST_TOKEN=${token()}\nMAILBOX_TOKENS=${JSON.stringify({ 'box@example.test': token(), 'other@example.test': token() })}\n`, { mode: 0o600 });
  docker('build', '-t', id, '.');
  docker('volume', 'create', id);
  docker('run', '-d', '--name', id, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--env-file', file, '--mount', `type=volume,source=${id},target=/data`, id);
  const probe = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    assert.notEqual(process.getuid(), 0);
    const origin = 'http://127.0.0.1:3000';
    for (let i = 0; ; i++) {
      try { await fetch(origin); break; } catch { if (i === 40) throw Error('Startup timeout'); await new Promise(r => setTimeout(r, 100)); }
    }
    const [readToken, otherToken] = Object.values(JSON.parse(process.env.MAILBOX_TOKENS));
    const ingestToken = process.env.TMAIL_INGEST_TOKEN;
    for (const t of ['', 'wrong', ingestToken]) assert.equal((await fetch(origin + '/v1/messages', { headers: { authorization: 'Bearer ' + t } })).status, 401);
    assert.equal((await fetch(origin + '/ingest', { method: 'POST' })).status, 401);
    const raw = Buffer.from([0, 255, 13, 10]);
    const saved = await fetch(origin + '/ingest', { method: 'POST', headers: { authorization: 'Bearer ' + ingestToken, 'content-type': 'message/rfc822', 'x-envelope-to': 'box@example.test', 'x-envelope-from': '' }, body: raw });
    assert.equal(saved.status, 201);
    const { id } = await saved.json();
    const get = t => fetch(origin + '/v1/messages/' + id + '/raw', { headers: { authorization: 'Bearer ' + t } });
    assert.equal((await get(otherToken)).status, 404);
    assert.deepEqual(Buffer.from(await (await get(readToken)).arrayBuffer()), raw);
  `;
  // Compare the packaged notice byte-for-byte, without embedding a generated copy.
  const notice = docker('exec', id, 'node', '-e', "process.stdout.write(require('fs').readFileSync('/app/LICENSE'))");
  const { readFileSync } = await import('node:fs');
  if (notice !== readFileSync('LICENSE', 'utf8')) throw Error('Packaged license mismatch');
  docker('exec', id, 'node', '--input-type=module', '-e', probe);
  console.log('Container smoke passed: non-root, offline, authorization, exact bytes, packaged license');
} finally {
  try { docker('rm', '-f', id); } catch {}
  try { docker('volume', 'rm', id); } catch {}
  try { docker('image', 'rm', id); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
