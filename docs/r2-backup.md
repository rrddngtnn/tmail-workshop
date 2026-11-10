# Standalone R2 archive connector

`scripts/r2-backup.mjs` connects the existing [offline archive transport](backup.md)
to S3-compatible R2. It is not imported by the Worker. No provisioning, deployment,
DNS changes, bucket creation, deletion, or cloud validation is performed by tests.
All connector tests inject a fake fetch transport, with fabricated credentials;
they exercise the real S3 signer and XML parser, not a live cloud account.

## Configuration and commands

Supply these environment variables through your secret manager or private shell
environment (do not paste credentials into commands, docs, tickets, or source):

- `R2_ENDPOINT`: HTTPS origin, normally `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
  No userinfo, query, fragment, or non-root path is allowed.
- `R2_BUCKET`: bucket name.
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: S3 API credentials.

The region is explicitly `auto`. No default credential chain or credential files
are read. Use a bucket-scoped read-only token for backup. Grant write access only
when deliberately restoring to the intended bucket. The environment and endpoint
are trusted operator inputs; this is not an endpoint allowlist or SSRF sandbox.

From the project root, **only when you intend remote operations**:

```sh
node scripts/r2-backup.mjs backup /private/path/new-archive
node scripts/r2-backup.mjs restore /private/path/archive --allow-restore
# Deliberately replace existing keys:
node scripts/r2-backup.mjs restore /private/path/archive --allow-restore --overwrite
```

Backup exclusively creates a new local directory and only sends remote GETs
(ListObjectsV2 and GetObject). It never writes remote objects. Existing local
destinations are refused. Restore is disabled without the explicit flag; each
PUT sends signed `If-None-Match: *` unless `--overwrite` is explicitly present.
There is no HEAD-then-PUT race. A service that does not support conditional PUT
must fail the request; do not remove the condition to work around it. This relies
on the target correctly enforcing S3 conditional writes; live R2 behavior has not
been validated here. No automatic retries or multipart uploads are performed.

CLI errors are intentionally generic and do not print SDK errors, configuration,
keys, metadata, signed URLs, credentials, or stacks. A successful operation emits
only an aggregate completion message. Signed URLs exist only in memory in the
transport (60-second expiry); never enable URL logging in proxies or injected
fetch wrappers. After an error, reconcile the target before retrying a restore.

## Library API

```js
import { createR2Client, backupR2, restoreR2 } from './scripts/r2-backup.mjs';
const client = createR2Client(process.env);
await backupR2(client, '/private/path/new-archive', {
  prefix: 'messages/', pageSize: 50, maxPages: 20,
});
await restoreR2(client, '/private/path/archive', {
  allowRestore: true, overwrite: false,
});
```

These examples are remote operations, not an offline demo. An omitted prefix
backs up the whole bucket, including legacy `messages/` and scoped `mailboxes/`
keys. Empty prefix does not filter unrelated objects. A prefix filters backup
only, not restore. Restore uses the archive's exact keys.

The optional `createR2Client(env, { fetchImpl })` seam allows completely offline
protocol tests. Only clients created by this factory receive transport bounds,
timeouts, redirect refusal and error sanitization. An arbitrary caller-supplied
client is trusted and may violate these guarantees.

## Bounds and failure semantics

Backup options are nonnegative safe integers, lowered from these hard ceilings:

| Option | Default / ceiling |
| --- | --- |
| `pageSize` | 100 (minimum 1) |
| `maxPages` | 100 (minimum 1) |
| `maxObjects` | 10,000 |
| `maxObjectBytes` | 16 MiB |
| `maxTotalBytes` | 256 MiB |

Keep the Worker's `MAX_BYTES` at or below 16 MiB (`16777216` bytes) if all inbound messages must fit this backup path.
The Worker permits up to 25 MiB, but the archive and connector hard ceilings cannot
be raised above 16 MiB per object. Larger existing objects cause backup to fail
closed; lowering `MAX_BYTES` does not resize them. Other archive limits still apply.

`prefix` must be a string; unknown options fail before I/O. The offline archive
also enforces an 8 MiB manifest ceiling. Restore accepts the offline module's
`limits` object; restore permission and overwrite require literal boolean `true`.

Each listing response is capped at 1 MiB before XML parsing. Each object response
is capped at 16 MiB at the transport; lowered caller limits are additionally
checked against listed sizes before GET and actual bytes before archiving.
A dishonest server can therefore cause one bounded 16 MiB read despite a smaller
caller limit. Limits count actual objects and actual bytes; listing scope, count,
size, repeated continuation tokens and listing/download size mismatches fail
closed. There are at most `maxPages` listing requests. The pinned client's
iterator can auto-fetch empty or short truncated pages inside one `next()`;
this connector refuses such pages instead of silently exceeding the page budget.
No continuation checkpoint or partial archive is published on failure.

Requests have a 30-second abort signal covering fetch and body reads, redirects
are refused, and error bodies are cancelled without parsing. The stream reader
checks every delivered chunk, cancels on failure and never calls unbounded
`arrayBuffer()`/`text()` on a remote response. Bounds cover retained application
buffers, **not** TLS, HTTP, decompression, parser overhead, transport-delivered
chunks, or caller/injected transport allocations. Buffers can be copied several
times for signing/Response/archive handling; peak RSS is not 16 MiB. There is no
whole-operation timeout; many sequential requests can take much longer.

The archive retains raw bytes, exact keys and custom metadata exposed as
`x-amz-meta-*` response headers (including TMail's `from`, `to`, `received`),
without MIME parsing. S3/HTTP lowercases header names; original custom-metadata
key casing and values unavailable through S3 cannot be recovered. Arbitrary
Unicode metadata or values outside the HTTP header representation may be rejected
or normalized by the runtime/service; no invented encoding is applied. This is
not a guarantee to preserve every Workers-only metadata value. System metadata
(content-type, cache headers), tags, ACLs, versions and uploaded timestamps are
not backed up. Restored objects receive new upload times, affecting retention.

Restore inherits checksum/schema/full-payload preflight and sequential writes
from `backup.mjs`. A failed write stops with `ARCHIVE_RESTORE_FAILED` and a
`completed` count at library level. Previous writes are **not rolled back**; an
ambiguous failed PUT may have reached the server. No read-back durability or
post-restore cloud verification is claimed. Archives are unencrypted and their
checksums are not authentication. Exclusive local path control is required.

A multi-page backup is not a snapshot: stop application/retention writes first.
Size checks detect some changes, not same-sized replacements or changes between
pages. There is no version pinning, cross-object transaction, remote lock, or
resume protocol. Partial failure removes the newly created archive on caught
errors; crashes can leave incomplete directories as described in backup.md.

## Dependency and verification

Pinned `@bradenmacdonald/s3-lite-client@1.0.1` has zero dependencies. It was chosen
over the much larger official SDK for this bounded List/Get/Put connector. The
lockfile records its integrity. The factory retains its SigV4 signing and S3 XML
parser but replaces the default unbounded, redirect-following transport. Its
bucket-root presigning name check is narrowly overridden for ListObjectsV2.

References inspected:

- https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/
- https://developers.cloudflare.com/r2/api/s3/api/
- https://github.com/bradenmacdonald/s3-lite-client (README and installed 1.0.1 source)

Run `node --test test/r2-backup.test.js` or the full `npm test`. Audit both scopes:
`npm audit --omit=dev` and `npm audit --include=dev`. Production-only auditing does
not cover the existing Miniflare test tooling. The current locked dependency tree
reports zero vulnerabilities with `npm audit --include=dev` at local verification.
The historical implementation-time audit reported **3 high-severity package findings**
(`miniflare`, `sharp`, `undici`); its production-only audit reported zero. Those
historical findings are not the current audit result: the locked development
tooling and overrides have since changed. Audit results depend on registry advisory
data and should be checked again; zero findings are not a proof of package safety.
The historical package threat-intelligence lookup was incomplete (metadata lookup timeout).
