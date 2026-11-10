# Source and dependency provenance

This initial publication imports an owner-supplied TMail Workshop source snapshot under the existing root MIT license. The input had no Git history; this repository starts a new history rather than attributing an invented upstream revision. No vendored source, external assets or named upstream source ports were found in the retained application modules. This is an inspection record, not an independent authorship attestation.

Third-party libraries are referenced through npm and pinned by version, registry URL and integrity in `package-lock.json`; their licenses remain their own. `@bradenmacdonald/s3-lite-client` supplies S3 signing/XML parsing and `smol-toml` supplies TOML parsing. Miniflare/workerd and its transitive dependencies are development/test tooling; they are not copied into the VPS image. The Docker image contains only the VPS module and root license on the Node base image. The base image retains its own bundled notices. No npm package or container registry publication is configured.

`source-snapshot.sha256.json` records the imported source files before publication-only documentation/tooling changes. It contains no operational file paths or private configuration. Dependency integrity is recorded separately in the npm lockfile.
