import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

test('workerd uses real R2 uploaded dates and persists cursors without deleting fresh mail', async t => {
  const mf = new Miniflare({ modules: [
    { type: 'ESModule', path: 'entry.mjs', contents: `import worker from './worker.mjs'; export default { async fetch(request, env) { return Response.json(await worker.scheduled({ scheduledTime: 9999999999999 }, env)); } };` },
    { type: 'ESModule', path: 'worker.mjs', contents: readFileSync(new URL('../worker.mjs', import.meta.url), 'utf8') },
  ], modulesRoot: fileURLToPath(new URL('../', import.meta.url)), compatibilityDate: '2025-04-01', r2Buckets: ['MAIL'], bindings: { RETENTION_DAYS: '1', RETENTION_DELETE_ENABLED: 'true', RETENTION_MAX_DELETES: '1' } });
  t.after(() => mf.dispose());
  const mail = await mf.getR2Bucket('MAIL');
  await mail.put('messages/first', 'one', { customMetadata: { received: '1900-01-01' } });
  await mail.put('messages/second', 'two');
  const first = await (await mf.dispatchFetch('http://local.test/')).json();
  assert.equal(first.deleted, 0);
  assert.equal(first.candidates, 0);
  const checkpoint = await (await mail.get('retention/state-v1.json')).json();
  assert.equal(checkpoint.root, 'messages/');
  assert.equal(typeof checkpoint.cursor, 'string');
  await mf.dispatchFetch('http://local.test/');
  assert.equal((await (await mail.get('retention/state-v1.json')).json()).root, 'mailboxes/');
  assert.equal(await (await mail.get('messages/first')).text(), 'one');
  assert.equal(await (await mail.get('messages/second')).text(), 'two');
});

const event = {};
const uuid = '00000000-0000-4000-8000-000000000001';
const stateKey = 'retention/state-v1.json';
const oldObject = (key, extra = {}) => ({ key, uploaded: new Date('2000-01-01'), ...extra });
function bucket(objects = []) {
  const calls = { lists: [], deletes: [], puts: [] };
  return { calls,
    async get(key) { assert.equal(key, stateKey); return null; },
    async list(options) { calls.lists.push(options); return { objects, truncated: false }; },
    async delete(key) { calls.deletes.push(key); },
    async put(key, value) { calls.puts.push([key, JSON.parse(value)]); return {}; },
  };
}
test('default dry run counts only expired messages using trusted uploaded timestamps', async () => {
  const mail = bucket([
    oldObject('messages/' + uuid, { customMetadata: { received: '2999-01-01' } }),
    oldObject('messages/new', { uploaded: new Date(), customMetadata: { received: '1900-01-01' } }),
    oldObject('backups/' + uuid),
    oldObject('messages/missing', { uploaded: undefined }),
    oldObject('messages/invalid', { uploaded: new Date('invalid') }),
  ]);
  const result = await worker.scheduled(event, { RETENTION_DAYS: '30', MAIL: mail });
  assert.equal(result.dryRun, true);
  assert.equal(result.candidates, 1);
  assert.equal(result.deleted, 0);
  assert.deepEqual(mail.calls.deletes, []);
  assert.deepEqual(mail.calls.lists, [{ prefix: 'messages/', limit: 100 }]);
});

test('explicit opt-in deletes at most the configured number of expired objects', async () => {
  const mail = bucket([oldObject('messages/' + uuid), oldObject('messages/second'), oldObject('messages/third')]);
  const result = await worker.scheduled(event, { RETENTION_DAYS: '1', RETENTION_DELETE_ENABLED: 'true', RETENTION_MAX_DELETES: '2', MAIL: mail });
  assert.deepEqual(mail.calls.deletes, ['messages/' + uuid, 'messages/second']);
  assert.equal(result.deleted, 2);
  assert.equal(mail.calls.lists[0].limit, 2);
});

test('persists bounded pagination and alternates legacy and scoped roots across runs', async () => {
  const mail = bucket();
  let state = null;
  mail.get = async () => state && ({ json: async () => state });
  mail.put = async (key, value) => { assert.equal(key, stateKey); state = JSON.parse(value); return {}; };
  const scoped = `mailboxes/${'a'.repeat(64)}/messages/${uuid}`;
  mail.list = async options => {
    mail.calls.lists.push(options);
    if (options.prefix === 'messages/') return { objects: [], truncated: false };
    if (!options.cursor) return { objects: [oldObject(scoped)], truncated: true, cursor: 'opaque-next' };
    return { objects: [oldObject('mailboxes/not-a-hash/messages/x'), oldObject(`mailboxes/${'a'.repeat(64)}/settings`)], truncated: false };
  };
  const env = { RETENTION_DAYS: '30', RETENTION_DELETE_ENABLED: 'true', RETENTION_MAX_DELETES: '2', MAIL: mail };
  await worker.scheduled(event, env);
  await worker.scheduled(event, env);
  await worker.scheduled(event, env);
  assert.deepEqual(mail.calls.lists, [{ prefix: 'messages/', limit: 2 }, { prefix: 'mailboxes/', limit: 2 }, { prefix: 'mailboxes/', limit: 2, cursor: 'opaque-next' }]);
  assert.deepEqual(mail.calls.deletes, [scoped]);
  assert.deepEqual(state, { root: 'messages/', cursor: null, dryRun: false });
});

test('corrupt checkpoints and malformed truncated pages fail closed', async () => {
  for (const state of [{ root: '', cursor: null, dryRun: false }, { root: 'messages/', cursor: 42, dryRun: false }]) {
    const mail = bucket([oldObject('messages/' + uuid)]);
    mail.get = async () => ({ json: async () => state });
    await assert.rejects(worker.scheduled(event, { RETENTION_DAYS: '1', RETENTION_DELETE_ENABLED: 'true', MAIL: mail }), /Invalid retention state/);
    assert.deepEqual(mail.calls.deletes, []);
    assert.deepEqual(mail.calls.lists, []);
  }
  const mail = bucket();
  mail.list = async () => ({ objects: [oldObject('messages/' + uuid)], truncated: true });
  await assert.rejects(worker.scheduled(event, { RETENTION_DAYS: '1', RETENTION_DELETE_ENABLED: 'true', MAIL: mail }), /Invalid retention page/);
  assert.deepEqual(mail.calls.deletes, []);
});

test('deletion failures do not advance the checkpoint; dry-run changes restart at legacy root', async () => {
  const mail = bucket([oldObject('messages/' + uuid)]);
  mail.delete = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(worker.scheduled(event, { RETENTION_DAYS: '1', RETENTION_DELETE_ENABLED: 'true', MAIL: mail }), /storage unavailable/);
  assert.deepEqual(mail.calls.puts, []);
  const dry = bucket();
  dry.get = async () => ({ json: async () => ({ root: 'mailboxes/', cursor: 'previous', dryRun: true }) });
  await worker.scheduled(event, { RETENTION_DAYS: '1', RETENTION_DELETE_ENABLED: 'true', MAIL: dry });
  assert.deepEqual(dry.calls.lists, [{ prefix: 'messages/', limit: 100 }]);
});

test('scheduled runs log only aggregate counts for operator dry-run review', async () => {
  const mail = bucket([oldObject('messages/private-id', { customMetadata: { from: 'private-sender' } })]);
  const logs = [], original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let result;
  try { result = await worker.scheduled(event, { RETENTION_DAYS: '1', MAIL: mail }); }
  finally { console.log = original; }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /retention/);
  assert.match(logs[0], /"candidates":1/);
  assert.doesNotMatch(logs[0], /private/);
});

test('invalid retention configuration fails before storage access', async () => {
  for (const [name, values] of Object.entries({
    RETENTION_DAYS: ['', '0', '-1', '1.5', ' 1', '01', '3651', 'Infinity', 1],
    RETENTION_MAX_DELETES: ['', '0', '1001', 1, null],
    RETENTION_DELETE_ENABLED: ['', 'TRUE', '1', true],
  })) {
    for (const value of values) {
      await assert.rejects(worker.scheduled(event, { RETENTION_DAYS: '30', [name]: value }), new RegExp('Invalid ' + name));
    }
  }
});
test('retention is disabled without RETENTION_DAYS and never touches storage', async () => {
  assert.equal(typeof worker.scheduled, 'function');
  assert.deepEqual(await worker.scheduled(event, {}), { enabled: false });
});
