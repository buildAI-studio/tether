# Vendor integrity check for the bundled ELK.js

## Intent

`server/src/static/vendor/elk.bundled.js` (6770 lines) is vendored, served
to the browser as-is, and has no integrity check today. Prior art
(`haydenschmitty/floorplan`, which uses the same vendor-ELK-for-zero-runtime-dependency
approach) pins its vendored files with a checksum file and a test. Tether
should do the same: catch any unintended change to the vendored payload
(corruption, a careless edit, a version bump nobody deliberately reviewed).

## Goals

- A committed checksum file for every file in `server/src/static/vendor/`.
- A test that recomputes each file's SHA-256 and fails if it doesn't match
  the committed value.
- A real upgrade to the vendored `elkjs` requires deliberately regenerating
  the checksum file — that friction is the point.

## Non-goals

- Verifying the vendored file against the actual upstream `elkjs` npm
  release. No network access in tests, and "unchanged since we vendored
  it" is a different, smaller claim than "matches upstream bit-for-bit."
- Any other vendored asset — there are none today beyond `elk.bundled.js`
  and `elkjs-LICENSE.md`.
- Automating checksum regeneration into the build. Regenerating is a
  deliberate, manual act when someone intentionally updates a vendor file.

## Approach

One sensible way, no alternatives considered: a classic `shasum -a 256`-format
checksum file, `server/src/static/vendor/CHECKSUMS.txt`:

```
b1032b7cfd2a57c54c6f0e8369d7665e19a579954f7cd20a6dae28f1912ea0d7  elk.bundled.js
637e81f4a1b6b4079535c499fca05e238cf7605c1ff5b76d60d7da7ce96700c9  elkjs-LICENSE.md
```

Plus `server/test/vendor-integrity.test.js`: parse `CHECKSUMS.txt`, and for
each `<hex-digest>  <filename>` line, compute `sha256` of
`server/src/static/vendor/<filename>` and assert it equals the digest.
Also assert every file actually present in that directory (except
`CHECKSUMS.txt` itself) has a line in the checksum file, so a new vendored
file added without a checksum entry fails loudly rather than silently
passing unchecked.

## What's left to the builder

- Exact Node APIs used (`node:crypto`'s `createHash("sha256")`,
  `node:fs/promises` or sync reads) — no constraint, match the project's
  existing test style (synchronous, `node:test`).
