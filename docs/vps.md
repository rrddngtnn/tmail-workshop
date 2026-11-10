# Local VPS backend

`apps/vps/server.mjs` is a standalone HTTP/SQLite alternative to the Cloudflare Worker. It implements the versioned mailbox read API used by `examples/tmail-client.mjs` and an authenticated HTTP ingest endpoint. It is not an SMTP server, an installed VPS service, or a verified email-delivery integration.

## Start locally

Use Node.js 26 with `node:sqlite` and `DatabaseSync` support. Verification here used Node.js 26.7.0; older Node releases have not been verified for this backend. No external runtime package is required.

Create a private writable data directory and a protected environment file outside source control, owned by the service user. Supply the following variables using your secret manager or Node's `--env-file` option. Do not put real secrets in command arguments, logs, URLs, or shell history.

| Variable | Meaning |
| --- | --- |
| `TMAIL_DB_PATH` | Required SQLite file path. Parent must already exist, be owned by the process user, and deny all group/other permissions (normally 0700). Use a durable path, not `:memory:`. |
| `TMAIL_INGEST_TOKEN` | Required ingest-only bearer secret. |
| `MAILBOX_TOKENS` | Required JSON object mapping lowercase envelope recipient addresses to distinct mailbox read secrets. Must be nonempty. |
| `TMAIL_HOST` | Bind address, default `127.0.0.1`. Do not change to a public interface without separate transport/access controls. |
| `TMAIL_PORT` | Decimal integer 0–65535, default 3000. Zero selects an ephemeral port for tests. |
| `TMAIL_MAX_BYTES` | Maximum raw message bytes, default 10485760; range 1–26214400. |
| `TMAIL_PAGE_SIZE` | List page size, default 100; range 1–100. |

Each token must contain 40–256 ASCII letters, digits, underscores or hyphens. All mailbox tokens and the ingest token must differ. Generate separate high-entropy values, for example with `openssl rand -hex 32`; format validation cannot establish randomness. Mailbox credentials authorize only that mailbox, not ingest or administration.

From the project root, with your protected environment file already populated:

```sh
node --env-file=/path/to/private/vps.env apps/vps/server.mjs
```

A successful startup prints the actual listening URL. Missing/malformed required configuration, invalid numeric settings, or startup failures exit nonzero with a generic `VPS startup failed` message. SIGINT/SIGTERM stop accepting connections and allow up to five seconds for current HTTP work; remaining connections are destroyed before SQLite closes. Incomplete uploads are not committed. Shutdown is idempotent. This is an event-loop deadline, not a guarantee against blocked synchronous disk I/O or an unresponsive process. This command does not install a service or configure automatic process restarts.

Incomplete request headers and bodies have a 30-second total receive deadline, checked once per second while the event loop is responsive; a trickling upload does not reset it. Node responds with 408 and closes the connection. This is not a response-download deadline or a concurrency/memory budget. The library `createBackend` accepts `requestTimeoutMs` (default 30000) and `shutdownTimeoutMs` (default 5000), each an integer from 1 to 300000; these are not environment settings.

On Linux, the backend creates the database with mode 0600 before SQLite opens it; WAL/shared-memory files inherit its private mode. Existing database, WAL, SHM, or rollback-journal files must be regular, single-link files owned by the process user with mode 0600. Unsafe paths are rejected, not silently chmodded. Directory symlinks and file symlinks are rejected. Ancestors must belong to root or the process user and must not be group/other-writable before reaching a user-owned private directory (root-owned sticky directories are allowed). These checks assume ordinary Unix permissions and a trusted service UID/root: ACLs, mount replacement, and concurrent changes by that same UID/root are not a sandbox boundary. Use a dedicated service identity and private directory; inspect and repair permissions offline before starting an older database.

## Trusted ingest boundary

`POST /ingest` requires:

- `Authorization: Bearer <ingest-secret>`
- `Content-Type: message/rfc822`
- `X-Envelope-To`: one configured recipient, matched case-insensitively
- `X-Envelope-From`: the SMTP envelope sender address, or an explicitly present empty header for a null sender
- Request body: the raw message bytes, without text conversion

Only a trusted SMTP/provider adapter should hold the ingest credential. That adapter must derive envelope fields from trusted delivery context, not `To`, `Delivered-To`, or other attacker-controlled MIME headers. There is no adapter or MTA configuration included here. The address check is a restricted address-shaped syntax check, not full SMTP/RFC address support or domain validation.

The server buffers the body up to its configured byte ceiling and inserts raw bytes and envelope metadata together. Successful insertion returns `201` with `{ "id": "<uuid>" }`. Wrong credentials return 401; invalid envelope 400; wrong media type 415; oversized body 413; storage failures a generic 503. All responses carry `Cache-Control: no-store`.

A 201 means the SQLite insert succeeded, not that upstream delivery has been acknowledged correctly. WAL and FULL synchronous mode are enabled, but host/disk durability is not independently established. A timeout or lost response after commit can lead to duplicate messages on retry: no idempotency key or delivery deduplication exists. Configure adapter retries and upstream acknowledgments separately and verify them before live use.

## Read API and restart behavior

Use the mailbox token as an authorization bearer:

- `GET /v1/messages[?cursor=...]` returns `{ messages, cursor }`; each message has `id`, `size`, and `envelope: { from, to, received }`.
- `GET /v1/messages/<id>/raw` returns exact stored bytes as a `message/rfc822` attachment with `X-Content-Type-Options: nosniff`.

Envelope casing is preserved in metadata; mailbox ownership uses the lowercase recipient. The receipt timestamp is generated at insertion. Listing is ordered by a persistent SQLite sequence; URL-encode a non-null cursor and continue until null. Cursors are mailbox-bound, base64url-encoded state, not encrypted or signed capabilities. They survive database reopen and process restart with the same database and mailbox configuration. At the end of a scan, new polling starts without a cursor and may observe old messages again; clients need stable-ID deduplication. No deletion, read flags, admin API, or unversioned compatibility routes are provided.

## Operational limits and verification

Keep the listener on loopback behind separately configured HTTPS/access controls if remote access is needed. No TLS, rate limiting, concurrent-ingest memory budget, quotas, retention, audit trail, MIME sanitization, malware checking, UI, or outbound mail is included. Raw MIME is untrusted; do not render it unsandboxed. Anyone with direct database/filesystem access bypasses mailbox API isolation; data is not encrypted at rest by this application. Protect the database, WAL, and shared-memory sidecar directory with filesystem permissions.

The R2 backup/archive tools do not back up this SQLite database. Use a separately tested SQLite-aware backup procedure or stop the process before a consistent database backup; copying only a live main database file can miss WAL data. There is no migration from R2 or tested disaster recovery procedure.

```sh
node --test --test-concurrency=1 test/vps-backend.test.js
node --test --test-concurrency=1 test/*.test.js
```

The VPS tests use real local HTTP and SQLite, disposable directories, and synthetic credentials. They exercise authentication separation, recipient isolation, byte limits including chunked transfer, exact binary MIME, sanitized storage errors, pagination across database reopen, invalid startup configuration, and a standalone loopback child process that ingests bytes, receives SIGTERM, restarts against the same file, and reads the original bytes. These are local checks only: they do not establish live SMTP/provider behavior, internet reachability, TLS, cloud deployment, DNS/MX routing, sustained load safety, or host-crash durability. No live deployment or DNS changes are part of this implementation.
