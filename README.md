# TMail Workshop

A receive-only mailbox toolkit with a primary **VPS HTTP/SQLite backend** and bearer-token-protected read API. Start with [VPS setup](docs/vps.md): no Cloudflare account or R2 is required. A trusted SMTP/provider adapter is still required to deliver messages to HTTP ingest; this is not an SMTP server.

Cloudflare Email Workers and R2 are **optional, independent alternatives**. The [relay](docs/relay.md) can submit trusted envelope/raw messages to VPS ingest; the standalone [R2 backup connector](docs/r2-backup.md) archives R2 objects, **not the VPS SQLite database**. No cloud deployment, delivery verification, TLS, DNS changes or automatic SQLite backups are included.

## VPS quick start

Use Node.js 26 (the locally verified runtime) and follow [the environment and private-directory requirements](docs/vps.md). Run `node --env-file=/path/to/private/vps.env apps/vps/server.mjs`. No npm runtime dependency is needed for this backend. Keep the listener on loopback behind your own HTTPS/access controls.

Alternatively, `docker compose --env-file /path/to/private/compose.env up --build -d` uses `compose.yaml`, a non-root Node process and a named SQLite volume. Put distinct `TMAIL_INGEST_TOKEN` and JSON `MAILBOX_TOKENS` in that private env file. The host port binds only to loopback. Container build and runtime verification must pass CI; Docker was unavailable during local preparation. Compose does not install an MTA, deploy to a cloud or configure TLS. Stop the service before a separately verified SQLite backup, including WAL as appropriate. Do not remove its volume unless you intend data loss.

The configuration and compatibility API sections below describe the **optional Cloudflare Worker**, not VPS environment variables or routes.

## Local use

Install dependencies with Node.js 26, then run the full suite:

```sh
npm ci --include=dev
npm audit --include=dev
npm test
```

Unit tests invoke the Worker with in-memory R2 doubles. Integration tests run it in Miniflare's local workerd runtime with local R2; a test-only HTTP harness invokes the email handler, not actual Email Routing. Run those tests alone with `npm run test:integration`. For local runtime experimentation, install Wrangler separately, replace the `MAIL` bucket placeholder in `wrangler.toml` with a suitable bucket name, supply local secrets in an untracked `.dev.vars` file, and run `wrangler dev`. The HTTP API needs messages in its R2 binding; starting the HTTP server does not establish real email delivery. Do not commit `.dev.vars` or use real secrets in examples.

For actual operation, separately configure a private R2 bucket and Cloudflare Email Routing for the desired addresses and Worker. Follow Cloudflare's current setup instructions; these files do not create or verify those resources. Restrict bucket access: direct R2 access bypasses the API. Use HTTPS, network access controls, and rate limiting before exposing an endpoint.

## Configuration and secrets (optional Cloudflare Worker)

Set secrets through Wrangler's secret management or another secure mechanism, not `wrangler.toml`, source control, URLs, or logs. For local development only, `.dev.vars` can contain, for example:

```dotenv
API_TOKEN="<admin-token>"
MAILBOX_TOKENS='{"box@example.test":"<mailbox-token>"}'
```

Replace placeholders with distinct high-entropy values. Each token must be at least 40 characters using only ASCII letters, digits, `_`, and `-`; for example, generate each separately with `openssl rand -hex 32`. Length validation does not guarantee entropy. Keep tokens out of shell history, process lists, and browser code; rotate compromised tokens.

- `MAIL`: R2 bucket binding, configured in `wrangler.toml`.
- `MAILBOX_TOKENS`: secret JSON object mapping lowercase email addresses to unique mailbox tokens. It must be nonempty, contain valid address-shaped keys, and have no token equal to `API_TOKEN`. When present, invalid configuration makes HTTP requests return 503 and inbound processing throw before storage.
- `API_TOKEN`: optional administrator secret in mailbox mode; if configured, it must meet the same token format. With no mailbox token configuration, it is required for the legacy API. An invalid admin token returns 503 on the admin authentication path. If mailbox mode is enabled without an admin token, unmatched credentials return 401.
- `MAX_BYTES`: maximum inbound raw size, default `10485760`; an integer from 1 through `26214400`. The checked-in config explicitly sets the default.
- `ACTIVE_MAILBOXES`: optional JSON array of lowercase envelope addresses. Matching ignores case. An empty array rejects all recipients; malformed configuration fails closed. When omitted, all routed recipients are accepted. Keep this list aligned with `MAILBOX_TOKENS` if mailbox owners need access.

With valid `MAILBOX_TOKENS` present, inbound mail is stored under a prefix derived from the SHA-256 hash of the lowercase envelope recipient, including recipients absent from the token map. Mailbox credentials can read only their corresponding prefix; the admin token can read a specified mailbox. This isolation applies to the Worker API, not to someone with direct bucket access. Changing the token map does not move or delete messages. Hashing addresses is not encryption.

If `MAILBOX_TOKENS` is absent, the Worker uses legacy single-token mode: incoming messages go under `messages/` and `API_TOKEN` reads that shared prefix. Switching modes does not migrate existing objects. In mailbox mode the admin token's `/messages` routes still read the legacy shared prefix, not all mailboxes.

## HTTP integration contract

All supported routes are GET-only and require `Authorization: Bearer <token>`. Authentication precedes route matching: unmatched credentials normally return 401, malformed or missing required secret configuration can return 503, and unsupported routes, methods, invalid IDs, or missing objects return 404 after authentication. All responses under `/v1` have `Cache-Control: no-store`, including errors. Avoid rendering untrusted mail or HTML without a sandbox.

### Versioned mailbox API

The v1 routes require a configured mailbox token. They do not support administrator or legacy-only credentials: an authenticated admin gets 404. A mailbox token accesses only its own prefix; there is no v1 admin-wide or cross-mailbox endpoint.

- `GET /v1/messages[?cursor=...]` lists up to 100 objects and returns, for example:

  ```json
  { "messages": [{ "id": "12345678-1234-4234-8234-123456789abc", "size": 123, "envelope": { "from": "sender@example.test", "to": "box@example.test", "received": "2026-01-01T00:00:00.000Z" } }], "cursor": null }
  ```

  `size` is the raw byte count. The envelope contains R2 custom metadata, not parsed MIME headers; absent metadata fields are `null`. `received` is the storage timestamp. The cursor is opaque; URL-encode a non-null cursor for the next page.
- `GET /v1/messages/<id>/raw` returns the exact stored bytes as a `message/rfc822` attachment with `X-Content-Type-Options: nosniff`. IDs must be lowercase UUIDv4 strings. An absent message returns 404.

### Unversioned compatibility API

A mailbox token can also call `GET /messages[?cursor=...]` and `GET /messages/<id>` for its own prefix. The list uses flat custom metadata fields (`from`, `to`, `received`) alongside `id` and `size`; raw responses are `application/octet-stream` attachments. These routes are separate from v1 and do not provide its explicit envelope shape.

Seatpool integration is unsupported. Authenticated requests to the removed `/seatpool/<mailbox>` route return 404.

### Administrator and legacy token

- `GET /admin/messages?mailbox=<encoded-address>[&cursor=...]`: in mailbox mode, list up to 100 messages for the specified address, with flat custom metadata, `id`, `size`, and a top-level `cursor`, as in the unversioned mailbox list.
- `GET /admin/messages/<id>?mailbox=<encoded-address>`: in mailbox mode, retrieve raw bytes for the specified mailbox and UUIDv4 ID. The mailbox query is required and matched case-insensitively by lowercasing for its storage prefix. These routes require the admin token, not a mailbox token.
- `GET /messages[?cursor=...]` and `GET /messages/<id>` with the admin token access the legacy shared prefix, whether mailbox mode is enabled or not. There is no admin-wide listing across mailbox prefixes.

List ordering is R2 object listing order, not a guaranteed inbox or chronological ordering. Cursor links and metadata do not constitute a durable delivery queue; clients should handle retries and duplicate observations. No API deletes messages or marks them read.

## Inbound behavior and limitations

Incoming raw bytes are buffered, checked against the reported `rawSize`, and stored as one R2 object with envelope sender, recipient, and receipt time in custom metadata. An oversized message is rejected using `setReject` before reading; invalid configuration, size mismatch, or storage failures are logged generically and thrown. R2 metadata limits and provider failures can prevent storage. Monitor errors, but logs are not a durable failure queue.

Optional [scheduled retention](docs/retention.md) is available but disabled by default. It requires an operator-configured Cron Trigger and explicit deletion opt-in; dry runs still write a checkpoint. There is no HTTP deletion API. The [offline archive transport](docs/backup.md) and standalone [R2 backup connector](docs/r2-backup.md) provide operator-run backup and restore, not automatic backups or verified cloud recovery. Stop application and retention writes before backing up; verify backups independently before enabling deletion.

For messages to fit the backup tooling, keep `MAX_BYTES` at or below 16 MiB (`16777216` bytes). The Worker accepts configurations up to 25 MiB, but both archive tooling and the R2 connector have a hard per-object ceiling of 16 MiB. Larger stored messages cause backup to fail closed; lowering the inbound limit does not shrink existing objects. Other archive limits still apply.

There is no outbound mail, MIME parsing, UI, audit trail, abuse controls, or delivery guarantee. Provider delivery, rejection, retry behavior, and runtime integration must be verified for the operator's own setup; tests do not prove them.

## Provider references

- [Email Workers runtime API](https://developers.cloudflare.com/email-routing/email-workers/runtime-api/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Wrangler secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
