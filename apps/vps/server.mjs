import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve, dirname, parse, join } from 'node:path';
import { openSync, closeSync, constants, lstatSync, fstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';

const address = value => typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value);
const digest = value => createHash('sha256').update(value).digest();
const authorized = (supplied, token) => timingSafeEqual(digest(supplied || ''), digest('Bearer ' + token));

export function createBackend({ dbPath, ingestToken, mailboxTokens, maxBytes = 10485760, pageSize = 100, shutdownTimeoutMs = 5000, requestTimeoutMs = 30000 }) {
  const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{40,256}$/.test(value);
  if (typeof dbPath !== 'string' || !dbPath || !token(ingestToken) ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 26214400 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      ![shutdownTimeoutMs, requestTimeoutMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 300000) ||
      !mailboxTokens || typeof mailboxTokens !== 'object' || Array.isArray(mailboxTokens) || !Object.keys(mailboxTokens).length) throw new Error('Invalid configuration');
  const seen = new Set([ingestToken]);
  for (const [mailbox, secret] of Object.entries(mailboxTokens)) {
    if (!address(mailbox) || mailbox !== mailbox.toLowerCase() || !token(secret) || seen.has(secret)) throw new Error('Invalid mailbox configuration');
    seen.add(secret);
  }
  mailboxTokens = Object.freeze({ ...mailboxTokens });
  if (dbPath !== ':memory:') {
    dbPath = resolve(dbPath);
    const unsafe = () => { throw new Error('Unsafe SQLite path'); };
    const uid = process.getuid();
    const privateFile = info => {
      if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) unsafe();
    };
    let ancestor = parse(dbPath).root;
    let privateBoundary = false;
    for (const part of dirname(dbPath).slice(ancestor.length).split('/').filter(Boolean)) {
      ancestor = join(ancestor, part);
      const info = lstatSync(ancestor);
      if (!info.isDirectory() || (info.uid !== uid && info.uid !== 0) ||
          (!privateBoundary && (info.mode & 0o022) && !(info.uid === 0 && (info.mode & 0o1000)))) unsafe();
      if (info.uid === uid && !(info.mode & 0o077)) privateBoundary = true;
    }
    const parent = lstatSync(dirname(dbPath));
    if (parent.uid !== uid || (parent.mode & 0o077)) unsafe();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { privateFile(lstatSync(dbPath + suffix)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const fd = openSync(dbPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { privateFile(fstatSync(fd)); } finally { closeSync(fd); }
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, mailbox TEXT NOT NULL,
      sender TEXT NOT NULL, recipient TEXT NOT NULL, received TEXT NOT NULL, raw BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mailbox_seq ON messages(mailbox, seq);`);
  const server = createServer({
    requestTimeout: requestTimeoutMs,
    headersTimeout: requestTimeoutMs,
    connectionsCheckingInterval: Math.min(1000, requestTimeoutMs),
  }, async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const reply = (status, value, type = 'text/plain') => {
      res.writeHead(status, { 'content-type': type });
      res.end(value);
    };
    const json = (status, value) => reply(status, JSON.stringify(value), 'application/json');
    try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/ingest') {
      if (!authorized(req.headers.authorization, ingestToken)) return reply(401, 'Unauthorized');
      const to = req.headers['x-envelope-to'], from = req.headers['x-envelope-from'];
      if (!address(to) || !Object.hasOwn(mailboxTokens, to.toLowerCase()) || !(from === '' || address(from))) return reply(400, 'Invalid envelope');
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'message/rfc822') return reply(415, 'Expected message/rfc822');
      if (Number(req.headers['content-length']) > maxBytes) return reply(413, 'Message too large');
      const chunks = [];
      let size = 0;
      // Do not use iterator return(): it destroys the socket before a 413 can be sent.
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxBytes) {
          res.setHeader('connection', 'close');
          return reply(413, 'Message too large');
        }
        chunks.push(chunk);
      }
      const id = randomUUID();
      db.prepare('INSERT INTO messages(id, mailbox, sender, recipient, received, raw) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, to.toLowerCase(), req.headers['x-envelope-from'], to, new Date().toISOString(), Buffer.concat(chunks));
      return json(201, { id });
    }
    const mailbox = Object.keys(mailboxTokens).find(address => authorized(req.headers.authorization, mailboxTokens[address]));
    if (!mailbox) return reply(401, 'Unauthorized');
    if (req.method === 'GET' && url.pathname === '/v1/messages') {
      let after = 0;
      if (url.searchParams.has('cursor')) {
        const cursor = url.searchParams.get('cursor');
        try {
          if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
          const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
          if (decoded.v !== 1 || decoded.mailbox !== mailbox || !Number.isSafeInteger(decoded.after) || decoded.after < 1) throw new Error();
          after = decoded.after;
        } catch { return reply(400, 'Invalid cursor'); }
      }
      const rows = db.prepare('SELECT seq, id, sender, recipient, received, length(raw) AS size FROM messages WHERE mailbox = ? AND seq > ? ORDER BY seq LIMIT ?').all(mailbox, after, pageSize + 1);
      const more = rows.length > pageSize;
      const page = rows.slice(0, pageSize);
      const cursor = more ? Buffer.from(JSON.stringify({ v: 1, mailbox, after: page.at(-1).seq })).toString('base64url') : null;
      return json(200, { messages: page.map(row => ({ id: row.id, size: row.size, envelope: { from: row.sender, to: row.recipient, received: row.received } })), cursor });
    }
    const match = /^\/v1\/messages\/([0-9a-f-]{36})\/raw$/.exec(url.pathname);
    if (req.method === 'GET' && match) {
      const row = db.prepare('SELECT raw FROM messages WHERE mailbox = ? AND id = ?').get(mailbox, match[1]);
      if (!row) return reply(404, 'Not found');
      res.setHeader('content-disposition', 'attachment; filename="message.eml"');
      res.setHeader('x-content-type-options', 'nosniff');
      return reply(200, row.raw, 'message/rfc822');
    }
    reply(404, 'Not found');
    } catch {
      if (!res.headersSent) reply(503, 'Service unavailable');
      else res.destroy();
    }
  });
  const close = () => { if (db.isOpen) db.close(); };
  let shutdownPromise;
  const shutdown = () => shutdownPromise ??= new Promise(resolve => {
    const timer = setTimeout(() => server.closeAllConnections(), shutdownTimeoutMs);
    server.close(() => { clearTimeout(timer); close(); resolve(); });
    server.closeIdleConnections();
  });
  return { server, close, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let backend;
  try {
    const integer = (name, fallback, min, max) => {
      const raw = process.env[name];
      if (raw === undefined) return fallback;
      if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error('Invalid configuration');
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid configuration');
      return value;
    };
    const port = integer('TMAIL_PORT', 3000, 0, 65535);
    const maxBytes = integer('TMAIL_MAX_BYTES', 10485760, 1, 26214400);
    const pageSize = integer('TMAIL_PAGE_SIZE', 100, 1, 100);
    const host = process.env.TMAIL_HOST ?? '127.0.0.1';
    if (!host.trim()) throw new Error('Invalid configuration');
    backend = createBackend({
      dbPath: process.env.TMAIL_DB_PATH,
      ingestToken: process.env.TMAIL_INGEST_TOKEN,
      mailboxTokens: JSON.parse(process.env.MAILBOX_TOKENS),
      maxBytes,
      pageSize,
    });
    backend.server.once('error', () => {
      backend.close();
      console.error('VPS startup failed');
      process.exitCode = 1;
    });
    backend.server.listen(port, host, () => {
      const { address, port, family } = backend.server.address();
      console.log(`Listening on http://${family === 'IPv6' ? `[${address}]` : address}:${port}`);
    });
    const shutdown = () => { void backend.shutdown(); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch {
    backend?.close();
    console.error('VPS startup failed');
    process.exitCode = 1;
  }
}
