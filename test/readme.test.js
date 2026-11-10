import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readProjectFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('local and CI verification explicitly includes development dependency audits', async () => {
  const readme = await readProjectFile('README.md');
  const ci = await readProjectFile('.github/workflows/ci.yml');
  for (const content of [readme, ci]) {
    assert.ok(content.includes('npm ci --include=dev'));
    assert.ok(content.includes('npm audit --include=dev'));
  }
});

test('local secret variants are ignored while example templates are allowed', async () => {
  const rules = (await readProjectFile('.gitignore')).split(/\r?\n/);
  for (const rule of ['.dev.vars', '.dev.vars.*', '.env', '.env.*', '!.dev.vars.example', '!.dev.vars.*.example', '!.env.example', '!.env.*.example']) {
    assert.ok(rules.includes(rule), `missing ignore rule: ${rule}`);
  }
});

test('README describes available maintenance and the inbound/backup size mismatch', async () => {
  const readme = await readProjectFile('README.md');
  assert.ok(readme.includes('[scheduled retention](docs/retention.md)'));
  assert.ok(readme.includes('[offline archive transport](docs/backup.md)'));
  assert.ok(readme.includes('[R2 backup connector](docs/r2-backup.md)'));
  assert.match(readme, /MAX_BYTES[^\n]*16 MiB/);
  assert.match(readme, /25 MiB/);
  assert.ok(!readme.includes('There is no built-in retention, deletion, backup'));
});

test('R2 backup docs distinguish current zero findings from historical findings', async () => {
  const docs = await readProjectFile('docs/r2-backup.md');
  assert.match(docs, /current locked dependency tree\s+reports zero/i);
  assert.match(docs, /historical[^\n]*3 high-severity/i);
  assert.match(docs, /MAX_BYTES[^\n]*16 MiB/);
});

test('README documents a complete inline bearer authorization header', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('`Authorization: Bearer <token>`'));
});
