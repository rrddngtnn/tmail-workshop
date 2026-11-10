# Offline archive transport

`scripts/backup.mjs` exports `exportArchive(records, destination, options?)`
and `importArchive(source, sink, options?)`. These are local library functions,
not a CLI or remote R2 backup client. No credentials or network are used.

Records are iterable or async iterable objects:
`{ key: string, bytes: Uint8Array, customMetadata: Record<string, string> }`.
Import calls `await sink.put(key, bytes, { customMetadata })` in manifest order.
Raw bytes, keys, and all string custom metadata round trip without MIME parsing.

## Archive integrity and paths

The directory contains numbered payloads (`0.bin`, etc.), `manifest.json` with
version 1, sizes and payload SHA-256 hashes, and `manifest.sha256`: exactly 64
lowercase hex characters hashing the exact manifest bytes. The sidecar protects
keys, metadata, sizes, order and payload hashes against accidental corruption.
Changing JSON whitespace requires a new checksum. Old archives without the
sidecar fail closed; do not fabricate a checksum for an untrusted manifest.
Checksums are **not authentication**: an attacker who can replace both manifest
and sidecar can recompute them. Keep archives in trusted private storage; no
signature, MAC, encryption, or externally trusted digest is provided.

Import rejects symlinks in the source path, its ancestors, manifest, checksum,
and referenced payloads. Only regular files are accepted; payload names must
match their numbered positions. Leaf opens use `O_NOFOLLOW`; ancestors are
checked with `lstat`. Export checks destination parents and exclusively creates
a new directory, refusing every existing destination (including an empty directory
or symlink). Files use mode 0600 and the directory 0700, subject to stricter umask.

These checks require **exclusive control of archive paths and their parents**.
They are not a sandbox against a hostile process concurrently swapping ancestor
directories. Export consumes bytes, not source filesystem paths. Input providers
must independently reject links if they read files. Payload hard links are not
rejected. Extra, unreferenced files are ignored.

## Bounded resources

Both functions accept `{ limits: { ... } }` with these hard ceilings/defaults:

| Option | Ceiling |
| --- | --- |
| `maxObjects` | 10,000 |
| `maxObjectBytes` | 16 MiB |
| `maxTotalBytes` | 256 MiB |
| `maxManifestBytes` | 8 MiB |

Limits can only be lowered to nonnegative safe integers; unknown limits fail.
Export consumes one record at a time, retaining manifest metadata but not the
whole archive payload. Import bounds manifest size before allocation and checks
all declared counts/sizes before payload reads. Each regular file is statted and
read into a fixed-size buffer with an extra-byte growth check. Import first
verifies every payload without sink writes, then rereads and rechecks each object
before its put; this trades double disk I/O for bounded payload memory.

These limits bound tooling buffers, not memory already allocated by a caller or
retained by the sink. Use a lazy async iterator rather than constructing an entire
archive in an input array. Large individual input metadata must already exist in
caller memory and JSON serialization can require temporary allocations before
its serialized-size rejection.

## Failure semantics

- Preflight failure (manifest, schema, limits, link, missing file, size or hash)
  rejects before **any** sink put.
- Once restore begins, puts are sequential. Sink failure or a changed payload
  stops immediately with `code === 'ARCHIVE_RESTORE_FAILED'`, `completed`
  (number of resolved puts), `failedKey`, and the original `cause`.
- There is **no rollback**. A rejected put may itself have persisted data;
  `completed` is not an exact count of durable writes. Successful puts are not
  proof of sink fsync/durability. Use an isolated empty sink or caller-managed
  transaction, reconcile partial writes, and do not retry blindly. Existing sink
  keys are governed by the sink's put semantics; filesystem destination refusal
  does not imply remote key overwrite protection.
- Export removes its newly created incomplete directory on caught failure,
  including iterator failure; existing destinations are never cleaned up. A
  cleanup failure rejects too. Export is not atomically published: interrupted
  processes/crashes may leave an incomplete directory. The checksum is written
  last, and incomplete archives fail import. Wait for export to resolve before
  consuming/copying the directory.

This transport does not provide a live-database consistency protocol, ownership
or xattr preservation, crash durability/fsync, cross-process locking, or remote
storage operations. Stop writes or obtain a consistent application-level source
before exporting live mail.

Run tests with `npm test` (or `node --test test/backup.test.js` for this module).
