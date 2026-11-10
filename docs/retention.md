# Optional scheduled retention

Retention is disabled unless `RETENTION_DAYS` is set. This repository does not enable a Cron Trigger or deploy any configuration automatically. No Cloudflare or DNS changes are needed for local tests.

## Configuration

All bindings below are strings, not numbers or booleans.

| Binding | Default | Accepted values |
| --- | --- | --- |
| `RETENTION_DAYS` | omitted: disabled | Canonical positive integer, 1–3650 |
| `RETENTION_MAX_DELETES` | `"100"` | Canonical positive integer, 1–1000 |
| `RETENTION_DELETE_ENABLED` | omitted: dry run | Exactly `"false"` or `"true"` |

Whitespace, signs, leading zeros, fractions and out-of-range values are rejected before any storage access. When retention is disabled the other retention bindings are ignored. Start with `RETENTION_DAYS = "30"` and `RETENTION_DELETE_ENABLED = "false"`. Review aggregate `retention` log entries before explicitly opting in with `"true"`. Deletion is irreversible: keep an independently verified backup first. Omit `RETENTION_DAYS` to stop all retention work.

If an operator later chooses to deploy, they must configure their own Cloudflare Cron Trigger. For example, a `[triggers]` section with `crons = ["0 * * * *"]` invokes the scheduled handler hourly. The checked-in Wrangler configuration is intentionally unchanged; these instructions are not a deployment action.

## Safety and scope

Age is based exclusively on the R2 object's trusted `uploaded` Date, compared strictly against the actual handler execution time minus the configured number of 24-hour days. Exactly-at-cutoff objects are retained. Missing or invalid upload dates are skipped. MIME Date headers and `customMetadata.received` do not affect deletion; scheduled event timestamps are not used. Restoring or overwriting an object resets its storage age.

Only direct objects under `messages/` and `mailboxes/<64 lowercase hex characters>/messages/` are eligible. Nested children, mailbox settings, backup keys and retention checkpoints are not eligible. Both legacy and scoped layouts are scanned regardless of current mailbox-token configuration, including historical mailboxes removed from that configuration. The scoped traversal lists `mailboxes/` but filters each key before deletion; it does not delete that whole prefix.

Each invocation makes one list request, with a limit equal to `RETENTION_MAX_DELETES`, and examines at most that many objects. Thus that value bounds both inspected objects and delete calls, not just successful deletions. Only explicit opt-in enables message deletion. Dry runs still write a checkpoint and emit counts; they do not modify message objects. Logs contain aggregate counts, not message keys, cursor values, senders or bodies.

## Continuation and limitations

The private R2 object `retention/state-v1.json` stores a root, opaque cursor and dry-run mode. A truncated page continues on the next invocation; a completed root switches between `messages/` and `mailboxes/`. Switching dry-run mode restarts at the legacy root. A corrupt checkpoint or malformed pagination response fails closed. A rejected delete stops the run before advancing its checkpoint. Partial successful deletions are not rolled back; retries may revisit a page. Checkpoint write failures also fail the run, potentially after successful deletions.

This is bounded best-effort traversal, **not a full-sweep or deletion-deadline guarantee**. A large root can delay the other root. Concurrent writes, overlapping invocations, cursor invalidation, storage errors and changing retention settings can cause revisits or delayed coverage. There is no distributed lock or transactional snapshot. The delete bound is per invocation, not a global cap across overlapping jobs. Mail objects are expected to be immutable random-ID objects written by this Worker: an external overwrite between list and delete is not protected by a conditional delete. Do not run concurrent maintenance that reuses message keys.

If an opaque cursor becomes invalid, disable retention, inspect the failure and checkpoint, then deliberately remove only `retention/state-v1.json` to restart traversal before re-enabling. Do not interpret one successful run as evidence that the bucket has been fully scanned.

## Local verification

Run `npm test`. `test/retention.test.js` covers disabled behavior, strict validation, explicit deletion opt-in, trusted upload ages, bounded deletes, checkpoint continuation, prefix filtering and failure behavior. A Miniflare/workerd test exercises real local R2 upload dates and cursor persistence through a test-only in-memory entrypoint. Expired-object deletion uses storage doubles because local R2 does not expose a supported upload-date backdating API. Tests do not contact cloud services and no test endpoint is added to the production Worker.
