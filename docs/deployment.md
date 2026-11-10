# Optional Cloudflare Worker deployment guide

The primary self-hosted backend is covered by [VPS setup](vps.md); it does not require Cloudflare. This guide is only for the independent Worker/R2 alternative.

This is a local artifact, not a deployed service. Nothing in the doctor creates resources, obtains credentials, deploys code, changes DNS, or tests live delivery. Cloudflare commands below are instructions for a separately authorized operator; they have not been run as part of preparation.

## Local preparation (no Cloudflare access)

Use Node.js 22 or newer. From the repository root:

```sh
npm ci --include=dev
npm audit --include=dev
npm test
node scripts/doctor.mjs
```

The checked-in `wrangler.toml` intentionally has `bucket_name = "CHANGE-ME"`; the doctor must fail until an operator replaces it. Keep `binding = "MAIL"`, `main = "worker.mjs"`, and the compatibility date. Set the bucket name to the exact private bucket the operator intends to use. R2 names are 3–63 lowercase letters, digits or hyphens, without leading or trailing hyphens. This only edits a local file; it does not create or prove access to a bucket.

Create `.dev.vars` using a secure local editor, with file access restricted to its owner. The file is ignored by this repository. Do not put tokens in command arguments, source control, tickets, screenshots or logs. Generate independent high-entropy tokens in a password manager; each must have at least 40 ASCII letters, digits, `_` or `-`.

Choose one mode:

- Legacy shared inbox: define `API_TOKEN` only.
- Isolated mailbox API: define `MAILBOX_TOKENS` as a single-quoted JSON object mapping lowercase addresses to distinct tokens. `API_TOKEN` is optional, and must differ from every mailbox token if present.

See the placeholder-only dotenv examples and token constraints in [README](../README.md#configuration-and-secrets). Replace every example address with an operator-controlled routed address. Keep `MAX_BYTES` as a string in `[vars]`; the default is 10485760. Keep it at or below 16777216 if using the archive tooling. Retention is disabled by default; do not add Cron Triggers or enable deletion during initial setup. See [retention](retention.md) and [backup](r2-backup.md) before enabling maintenance.

### Doctor contract

Run `node scripts/doctor.mjs` from the repository root. No flags are supported, including `--live-probe` or `--env`. It reads only local `wrangler.toml`, `.dev.vars`, and entrypoint file metadata. It does not import or execute the entrypoint, invoke Wrangler, make network calls, read cloud credentials, or write files. It deliberately ignores inherited process secrets, `.env`, and environment-specific secret files. Named Wrangler environments and the `secrets` loading filter are rejected rather than silently validating the wrong target or a token that Wrangler would exclude. Use the root configuration and `.dev.vars` for this workflow.

It parses TOML, checks the Worker name/date/entrypoint, a unique `MAIL` R2 binding and bucket name, rejects API secrets in `[vars]`, validates `MAX_BYTES`, and validates required local token configuration. It also checks optional recipient/retention settings (local secrets override root vars for those settings). Token validation mirrors the Worker's shape and uniqueness rules; it cannot establish entropy or credential ownership. It is not a full Wrangler schema validator and does not verify provider accounts, remote secrets, DNS, billing, bucket existence, authorization, routing or delivery.

Stdout contains one JSON object; validation errors use only fixed codes and fixed field names, never input values, addresses, parser messages, paths supplied by the config, or secret contents. Exit status is 0 on success and 1 on failure. Missing/unreadable files fail closed. For example, the unconfigured artifact reports errors in this shape:

```json
{"ok":false,"liveProbe":false,"errors":[{"code":"INVALID_OR_PLACEHOLDER","field":"MAIL.bucket_name"},{"code":"SECRETS_UNREADABLE","field":".dev.vars"}]}
```

A successful result is exactly:

```json
{"ok":true,"liveProbe":false,"errors":[]}
```

Success establishes local preflight only, not production readiness. Keep non-secret settings in `wrangler.toml`, not `.dev.vars`, so local and deployed limits remain aligned.

## Optional local HTTP runtime

Wrangler is not installed or invoked by the doctor. The operator can install it locally following [Cloudflare's installation guide](https://developers.cloudflare.com/workers/wrangler/install-and-update/):

```sh
npm i -D wrangler@latest
npx wrangler --version
npx wrangler dev
```

Installation changes the operator's package manifest/lockfile; review and retain that exact version for reproducible deployment. Do not use `--remote`. Local HTTP startup does not create mail or establish actual Email Routing. The integration suite uses a test-only email harness with local R2, not live SMTP.

## Cloud setup (operator authorization required)

Stop here unless cloud changes have been explicitly authorized. Select the correct account and controlled domain first. Never provide cloud credentials to this doctor.

1. In the Cloudflare dashboard, create a private R2 bucket matching `MAIL.bucket_name`. Leave public bucket access disabled. Direct bucket access bypasses API authentication. Bucket naming and creation are documented in [Create new buckets](https://developers.cloudflare.com/r2/buckets/create-buckets/).
2. Install and authenticate Wrangler using the operator's approved credential workflow. Re-run the local doctor and tests. Review `wrangler.toml`, especially account/Worker identity and the bucket binding, before proceeding.
3. Prepare an owner-readable, ignored `.env.production` dotenv file in a secure editor containing only the production `API_TOKEN` and/or `MAILBOX_TOKENS` required by the chosen mode. Local `.dev.vars` is not automatically a production secret upload. Preserve the same format/uniqueness constraints; avoid reusing development credentials.
4. After explicit approval to publish the Worker and secrets, use the documented atomic code-plus-secret upload:

   ```sh
   npx wrangler deploy --secrets-file .env.production
   ```

   This is a live deployment, not a preflight. Record the resulting version and endpoint privately. Cloudflare documents `--secrets-file` in [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/). `wrangler secret put` also deploys immediately; do not treat it as an offline preparation command. Securely retain production secrets according to operator policy, never in this artifact.
5. Before exposing HTTP access, enforce HTTPS, network restrictions and rate limiting. Review Cloudflare's published endpoint/route settings and avoid leaving unintended public access paths. The Worker has no built-in rate limiter or abuse controls.
6. Only after separate DNS approval, follow [Route emails](https://developers.cloudflare.com/email-service/get-started/route-emails/): **Compute > Email Service > Email Routing > Onboard Domain**, choose the controlled Cloudflare DNS domain, and review proposed MX/SPF/DKIM changes before confirming. Existing mail services may be disrupted; do not replace their records without a migration plan.
7. For that domain, open **Routing Rules > Create routing rule**. Enter the intended local part and domain, select **Send to a Worker**, select the deployed TMail Worker, and save. Do not choose the forwarding action; this Worker stores mail and does not forward it. Align routed recipients, `MAILBOX_TOKENS`, and optional `ACTIVE_MAILBOXES`.

No new Worker template, outbound binding, `mimetext` package, or `nodejs_compat` flag is required for this existing receive-only implementation.

## Operator acceptance after deployment

These are live checks and are intentionally outside the doctor. Send a harmless uniquely identified message from an independent account to an explicitly configured recipient. Using a secure client that does not log bearer tokens, call `GET /v1/messages` with the corresponding mailbox token and then `GET /v1/messages/<id>/raw`; confirm the expected raw bytes and envelope. Legacy-only deployments use `GET /messages` and `GET /messages/<id>` instead. Confirm missing/wrong credentials are rejected and mailbox credentials cannot read another mailbox. Confirm private bucket settings, limits and error monitoring. Do not put tokens in URLs, shell history, process arguments, or browser code.

A successful deployment response or empty inbox listing does not prove SMTP delivery. Record inbound, rejection and retry observations separately, and verify backups before any destructive retention policy. If validation fails, disable the affected routing rule and investigate; do not delete mail or change DNS as an automatic rollback.

Provider instructions above were checked against the linked Cloudflare documentation while preparing this guide. Dashboard labels and CLI behavior may change; review those references before an actual deployment.
