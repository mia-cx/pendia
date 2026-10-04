# #45 Artwork store backends: path and S3

## Summary

Add the two remaining artwork store backends next to the colocated one from #28: a configured directory and S3-compatible object storage. The operator picks the backend once, at setup, through environment variables. Store, read and delete go through one backend interface, so the artwork route and the provider-fetch job work the same on all three. A colocated store on a read-only media share falls back to the configured path. Moving existing artwork between backends is unsupported in the MVP and documented as such.

## Acceptance criteria

- [x] Artwork round-trips through the path backend and through S3 against a local S3-compatible server in tests.
- [x] A fresh install on each backend serves artwork.
- [x] The read-only fallback is exercised in a test.

## TODOs

- [x] Read the artwork store choice from the environment and validate it when a role starts.
  - Validation: unit tests for defaults, each backend and each invalid combination; server typecheck.
- [x] Store, read and remove artwork through a backend interface, with the configured path as the first new backend.
  - Validation: disposable Postgres tests round-trip a poster through the path backend; the existing colocated tests stay green.
- [x] Add the S3 backend on Bun's built-in S3 client and start a local S3-compatible server in CI.
  - Validation: a round-trip test against versitygw, skipped locally without `TEST_S3_URL` and required in CI.
- [x] Fall back to the configured path when the colocated write hits a read-only share.
  - Validation: a test makes the Item folder unwritable and proves the poster lands in the configured path and reads back.
- [x] Remove artwork from every backend when its Item, its selection or its Library goes away.
  - Validation: tests prove scan deletes, `removeSelectedArtwork` and library deletion remove path and S3 originals.
- [x] Prove a fresh install serves artwork on each backend and document the settings.
  - Validation: an artwork route test per backend on a freshly migrated database; README and topology spec updated.

## Notes

- The backend is chosen by environment variables, read once per process. This matches `PENDIA_SCRATCH_DIR` and PR #77's `TMDB_API_KEY`, needs no new API or UI, and makes the choice an install-time decision, which fits "moving between backends is unsupported". `PENDIA_ARTWORK_STORE` is `colocated` (default), `path` or `s3`. `PENDIA_ARTWORK_PATH` is the directory for `path` and the read-only fallback for `colocated`.
- S3 settings use the variables Bun's S3 client already reads: `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, with the `AWS_` equivalents. No new dependency.
- Keys outside the colocated backend are flat: `<artwork-id>.<generation>`. Each replacement writes a fresh generation, as colocated does, so a reader never sees a half-written original.
- A selected row is reused across backends: replacing a poster keeps its artwork id and removes the previous original from whichever backend held it. This replaces #28's fresh-id rule for non-colocated rows; the id is only the URL, and the ETag follows the bytes.
- Rows whose backend is not configured in this process read as missing. Colocated rows always resolve, because their root is the Library root.
- Read-only means `EROFS` or `EACCES` from the colocated write. Without `PENDIA_ARTWORK_PATH` the error stands.
- MinIO no longer publishes images on Docker Hub or Quay, so the S3 tests run against `versity/versitygw` (101 MB, posix backend), started with `docker run --rm`.
- versitygw serves each directory under its data root as a bucket, so CI makes the bucket with `mkdir` before the server starts. Bun signs custom endpoints for region `auto`, which versitygw rejects, so the test client sets `us-east-1`. Operators on such servers set `S3_REGION`.
- `TEST_S3_URL` carries the endpoint, credentials and bucket in one URL, like `DATABASE_URL`.
- The read-only fallback shipped in the backend-interface commit; its TODO commit adds the test. The test skips as root, which ignores directory permissions.
- Library deletion removes path and S3 originals. Colocated originals stay, because deleting a Library never touches the media folder.
- Scan deletes go through `deleteItemSubtree` and `removeArtworkFiles`, which the removal tests call directly.
- Gate on 2026-10-04 from the repo root: `bun install --frozen-lockfile` no changes; `bun run lint` clean; `bun run check` 6 of 6 tasks; `bun run build` 4 of 4 tasks; `bun test` with `DATABASE_URL` and `TEST_S3_URL` 1002 pass, 0 fail; `bun test` without them 554 pass, 456 skip, 0 fail.
