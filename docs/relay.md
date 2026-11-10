# Email Worker → VPS relay

`apps/relay/worker.mjs` is a separate, storage-free Cloudflare Email Worker.
It does not import the root R2 Worker, use R2, or require another repository.
Use it instead of the root Worker when inbound mail should live on the [VPS backend](vps.md).

## Contract and configuration

Copy `apps/relay/wrangler.example.toml` to a local Wrangler configuration in the
same directory and replace the example hostname. Keep real secrets out of that file.
Deployment and Email Routing/DNS changes are operator actions; local tests do neither.

| Binding | Meaning |
| --- | --- |
| `RELAY_INGEST_URL` | Exact HTTPS endpoint ending in `/ingest`; no credentials, query, fragment, whitespace or backslashes. |
| `RELAY_INGEST_TOKEN` | Wrangler secret matching VPS `TMAIL_INGEST_TOKEN`: 40–256 URL-safe alphanumeric, underscore or hyphen characters. |
| `MAX_BYTES` | Optional positive decimal string, default `10485760`, maximum `26214400`. Set no higher than VPS `TMAIL_MAX_BYTES`. |

Use a dedicated randomly generated ingress credential, distinct from every mailbox
read token and any admin token. The VPS enforces that separation. This credential
can ingest into any configured VPS mailbox, but cannot read mail. This is ingress
scope, not per-recipient authorization. Only install it in the relay and VPS;
never pass it to mailbox clients. The VPS mailbox map remains the recipient allowlist.

Terminate valid public TLS at your VPS reverse proxy and forward `/ingest` to the
loopback backend without changing the method, body, Authorization or envelope headers.
Keep the backend bound to loopback. Do not use a redirect to reach HTTPS or `/ingest`:
the relay uses workerd-compatible `redirect: 'manual'`, never follows the response's
`Location`, and rejects every status except `201`. Credentials cannot follow a redirect.
The configured `2025-04-01` compatibility date does not support `redirect: 'error'`.
Configure the proxy body limit to accommodate the configured raw-message limit.
Select this Worker as the appropriate Cloudflare Email Routing destination;
`workers_dev` and preview URLs are disabled and there is no public HTTP handler.
No deployment, DNS changes, or credentials are needed to run local tests.

The relay makes exactly one `POST /ingest` with:

- `Authorization: Bearer <RELAY_INGEST_TOKEN>`
- `Content-Type: message/rfc822`
- `X-Envelope-From`: the Email event sender, including an empty bounce sender
- `X-Envelope-To`: the Email event recipient, retaining case
- Body: byte-exact raw MIME, including non-UTF8 octets

MIME `To`, `Delivered-To`, and other message headers do not determine routing.
The relay validates envelope syntax before sending; the VPS validates configured
recipient membership and stores its own received timestamp. The bounded reader
checks both declared size and actual chunks, cancels on overflow, and requires
an exact declared/actual size match before contacting the VPS. It buffers a bounded
message before sending (chunk copies plus a contiguous buffer), not arbitrary input.

## Success and failure semantics

Only the VPS contract's `201 Created` counts as success. Every other status,
including other 2xx statuses and redirects, or a transport failure throws
`Relay delivery failed`. Invalid configuration throws `Relay configuration invalid`;
invalid envelopes, raw streams, sizes and overflow throw `Relay message invalid`.
Errors do not include the endpoint, secret, envelope, raw content, upstream response
body or original exception. Upstream response bodies are cancelled rather than parsed.

There is no R2 fallback, queue, local retry, idempotency key, or durable outbox.
Throwing surfaces the handler failure; **this does not guarantee Cloudflare retries
or eventual delivery**. Verify platform behavior separately and arrange external
monitoring/recovery. A connection failure after the VPS committed can leave an
uncertain outcome; a later resend may create a duplicate. Do not treat this as
exactly-once delivery or silently acknowledge failed ingress.

## Local verification

From the repository root:

```sh
node --test test/relay.test.js
npm test
```

The workerd integration tests load the production relay through a test-only HTTP
entrypoint at compatibility date `2025-04-01`. Miniflare's HTTP fetch mock disables
external network access and checks exact POST bytes and trusted headers, strict
`201` success, sanitized failures, and no requests to redirect destinations.
The HTTP entrypoint exists only under `test/`, not in the deployed Worker.

The separate VPS integration test runs the actual VPS server and SQLite database on
loopback, injects a transport that maps the already-validated HTTPS destination to
that local listener, then reads the stored envelope and byte-exact raw message back
through the authenticated VPS API. This tests no public TLS, DNS or Cloudflare
Email Routing. `createRelay({ fetch })` is a code-level test seam: production exports
`createRelay()` with the platform fetch. There is no insecure-URL environment flag,
and even the injected transport cannot bypass HTTPS configuration validation.
