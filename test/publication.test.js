import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const text = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
test('release docs lead with independent VPS and optional R2', async () => {
  const readme = await text('README.md');
  assert.match(readme.split('## Local use')[0], /VPS.*SQLite/s);
  assert.match(readme, /R2.*optional/i);
  assert.match(await text('Dockerfile'), /USER node/);
  assert.match(await text('compose.yaml'), /127\.0\.0\.1:3000:3000/);
});
test('hygiene gate rejects private paths and credentials without disclosing contents', () => {
  const code = "import { violations } from './scripts/hygiene.mjs'; console.log(JSON.stringify([violations('.env', 'x'), violations('data/mail.sqlite', ''), violations('test/safe.js', 'const key = '+JSON.stringify('ghp_'+'x'.repeat(36))), violations('README.md', 'Use example.test')]));";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.ok(rows[0].length && rows[1].length && rows[2].length);
  assert.deepEqual(rows[3], []);
});
