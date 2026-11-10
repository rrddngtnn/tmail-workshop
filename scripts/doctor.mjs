// Local-only preflight: never invokes Wrangler, imports the Worker, or uses the network.
import { readFileSync, statSync } from 'node:fs';
import { parse } from 'smol-toml';
import { parseEnv } from 'node:util';

const errors = [];
const fail = (code, field) => errors.push({ code, field });
let config;
try { config = parse(readFileSync('wrangler.toml', 'utf8')); }
catch { fail('CONFIG_UNREADABLE_OR_INVALID', 'wrangler.toml'); }
if (config) {
  if (config.vars !== undefined && (!config.vars || typeof config.vars !== 'object' || Array.isArray(config.vars))) fail('INVALID', 'vars');
  if (config.secrets !== undefined) fail('UNSUPPORTED_SECRET_FILTER', 'secrets');
  if (typeof config.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(config.name)) fail('INVALID', 'name');
  try {
    if (typeof config.main !== 'string' || !statSync(config.main).isFile()) throw new Error();
  } catch { fail('ENTRYPOINT_MISSING', 'main'); }
  if (typeof config.compatibility_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date) || !Number.isFinite(Date.parse(config.compatibility_date)) || new Date(config.compatibility_date).toISOString().slice(0, 10) !== config.compatibility_date) fail('INVALID', 'compatibility_date');
  if (config.env !== undefined) fail('UNSUPPORTED_ENVIRONMENTS', 'env');
  const buckets = Array.isArray(config.r2_buckets) ? config.r2_buckets.filter(b => b.binding === 'MAIL') : [];
  if (buckets.length !== 1) fail('REQUIRED_UNIQUE_BINDING', 'MAIL');
  else if (typeof buckets[0].bucket_name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(buckets[0].bucket_name) || /^(?:change-me|placeholder|your-bucket(?:-name)?)$/.test(buckets[0].bucket_name)) fail('INVALID_OR_PLACEHOLDER', 'MAIL.bucket_name');
  for (const key of ['API_TOKEN', 'MAILBOX_TOKENS']) {
    if (Object.hasOwn(config.vars ?? {}, key)) fail('SECRET_IN_CONFIG', key);
  }
  const size = config.vars?.MAX_BYTES ?? '10485760';
  if (typeof size !== 'string' || !/^[1-9][0-9]*$/.test(size) || !Number.isSafeInteger(Number(size)) || Number(size) > 26214400) fail('INVALID', 'MAX_BYTES');
}
let secrets;
try { secrets = parseEnv(readFileSync('.dev.vars', 'utf8')); }
catch { fail('SECRETS_UNREADABLE', '.dev.vars'); }
if (secrets) {
  const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{40,}$/.test(value);
  if (secrets.API_TOKEN !== undefined && !validToken(secrets.API_TOKEN)) fail('INVALID_SECRET', 'API_TOKEN');
  if (secrets.MAILBOX_TOKENS === undefined) {
    if (secrets.API_TOKEN === undefined) fail('REQUIRED_SECRET', 'API_TOKEN');
  } else {
    try {
      const boxes = JSON.parse(secrets.MAILBOX_TOKENS);
      if (!boxes || typeof boxes !== 'object' || Array.isArray(boxes) || !Object.keys(boxes).length) throw new Error();
      const seen = new Set();
      for (const [address, value] of Object.entries(boxes)) {
        if (!/^[^@\s]+@[^@\s]+$/.test(address) || address !== address.toLowerCase() || !validToken(value) || seen.has(value) || value === secrets.API_TOKEN) throw new Error();
        seen.add(value);
      }
    } catch { fail('INVALID_SECRET', 'MAILBOX_TOKENS'); }
  }
}
const local = { ...config?.vars, ...secrets };
if (local.ACTIVE_MAILBOXES !== undefined) {
  try {
    const active = JSON.parse(local.ACTIVE_MAILBOXES);
    if (typeof local.ACTIVE_MAILBOXES !== 'string' || !Array.isArray(active) || active.some(a => typeof a !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(a) || a !== a.toLowerCase()) || new Set(active).size !== active.length) throw new Error();
  } catch { fail('INVALID', 'ACTIVE_MAILBOXES'); }
}
if (local.RETENTION_DAYS !== undefined) {
  for (const [key, value, max] of [['RETENTION_DAYS', local.RETENTION_DAYS, 3650], ['RETENTION_MAX_DELETES', local.RETENTION_MAX_DELETES ?? '100', 1000]]) {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) fail('INVALID', key);
  }
  if (local.RETENTION_DELETE_ENABLED !== undefined && !['true', 'false'].includes(local.RETENTION_DELETE_ENABLED)) fail('INVALID', 'RETENTION_DELETE_ENABLED');
}
if (process.argv.length > 2) errors.splice(0, errors.length, { code: 'UNSUPPORTED_ARGUMENTS', field: 'arguments' });
process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, liveProbe: false, errors })}\n`);
process.exitCode = errors.length ? 1 : 0;
