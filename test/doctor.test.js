import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('scripts/doctor.mjs');
const config = `name = "tmail-workshop"
main = "worker.mjs"
compatibility_date = "2025-04-01"
[vars]
MAX_BYTES = "10485760"
[[r2_buckets]]
binding = "MAIL"
bucket_name = "private-mail"
`;
const token = 'a'.repeat(64);
function run(t, { toml = config, secrets = `API_TOKEN="${token}"`, args = [] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'tmail-doctor-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  if (toml !== null) writeFileSync(join(cwd, 'wrangler.toml'), toml);
  if (secrets !== null) writeFileSync(join(cwd, '.dev.vars'), secrets);
  writeFileSync(join(cwd, 'worker.mjs'), 'export default {};');
  const before = readdirSync(cwd).map(name => [name, readFileSync(join(cwd, name), 'utf8')]);
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, API_TOKEN: token, MAILBOX_TOKENS: '' },
  });
  assert.equal(result.stderr, '');
  assert.deepEqual(readdirSync(cwd).map(name => [name, readFileSync(join(cwd, name), 'utf8')]), before);
  assert.ok(!result.stdout.includes(token), 'must not disclose secrets');
  return { status: result.status, report: JSON.parse(result.stdout) };
}

test('rejects missing, malformed or unsafe Wrangler configuration with redacted JSON', t => {
  for (const toml of [null, 'INVALID= [', config.replace('private-mail', 'CHANGE-ME'), config.replace('binding = "MAIL"', 'binding = "OTHER"'), config.replace('private-mail', 'Bad_Bucket'), config.replace('worker.mjs', 'missing.mjs'), config.replace('2025-04-01', 'not-a-date'), config.replace('"10485760"', '"0"'), config + '\n[env.production]\nname="other"', config.replace('[vars]', `[vars]\nAPI_TOKEN="${token}"`)]) {
    const { status, report } = run(t, { toml });
    assert.equal(status, 1);
    assert.equal(report.ok, false);
    assert.equal(report.liveProbe, false);
    assert.ok(report.errors.length > 0);
    for (const error of report.errors) assert.deepEqual(Object.keys(error).sort(), ['code', 'field']);
  }
});

test('validates required local secrets, ignoring inherited environment and redacting parser errors', t => {
  for (const secrets of [null, '', 'API_TOKEN=""', 'API_TOKEN="short"', 'MAILBOX_TOKENS=not-json', 'MAILBOX_TOKENS={}', `MAILBOX_TOKENS='{"Box@example.test":"${token}"}'`, `MAILBOX_TOKENS='{"box@example.test":"${token}","two@example.test":"${token}"}'`, `API_TOKEN=${token}\nMAILBOX_TOKENS='{"box@example.test":"${token}"}'`]) {
    const { status, report } = run(t, { secrets });
    assert.equal(status, 1);
    assert.ok(report.errors.length > 0);
  }
});

test('accepts mailbox-only secrets and dotenv comments without printing addresses', t => {
  const { status, report } = run(t, { secrets: `# local only\nMAILBOX_TOKENS='{"box@example.test":"${token}"}' # mailbox mode\n` });
  assert.equal(status, 0);
  assert.equal(report.ok, true);
  assert.ok(!JSON.stringify(report).includes('box@example.test'));
});

test('rejects all arguments including live-probe and environment selection without echoing them', t => {
  for (const args of [['--live-probe'], ['--env', 'production'], [token]]) {
    const { status, report } = run(t, { args });
    assert.equal(status, 1);
    assert.deepEqual(report.errors, [{ code: 'UNSUPPORTED_ARGUMENTS', field: 'arguments' }]);
  }
});

test('validates optional recipient and retention configuration before deployment', t => {
  for (const vars of ['ACTIVE_MAILBOXES = "not-json"', `ACTIVE_MAILBOXES = '["Upper@example.test"]'`, 'RETENTION_DAYS = "0"', 'RETENTION_DAYS = "30"\nRETENTION_MAX_DELETES = "1001"', 'RETENTION_DAYS = "30"\nRETENTION_DELETE_ENABLED = true']) {
    const { status } = run(t, { toml: config.replace('[vars]', `[vars]\n${vars}`) });
    assert.equal(status, 1);
  }
});

test('structurally invalid TOML tables fail closed without stack traces', t => {
  for (const toml of ['name="tmail"\nr2_buckets=[1, "secret-input"]', config.replace('[vars]\nMAX_BYTES = "10485760"', 'vars = "invalid"'), config + '\n[secrets]\nrequired=["UNSUPPORTED_SECRET"]']) {
    const { status, report } = run(t, { toml });
    assert.equal(status, 1);
    assert.ok(report.errors.length > 0);
  }
});

test('offline doctor accepts local legacy setup without modifying files', t => {
  const { status, report } = run(t);
  assert.equal(status, 0);
  assert.deepEqual(report, { ok: true, liveProbe: false, errors: [] });
});
