# #45 Artwork store backends: path and S3

## Summary

Add the two remaining artwork store backends next to the colocated one from #28: a configured directory and S3-compatible object storage. The operator picks the backend once, at setup, through environment variables. Store, read and delete go through one backend interface, so the artwork route and the provider-fetch job work the same on all three. A colocated store on a read-only media share falls back to the configured path. Moving existing artwork between backends is unsupported in the MVP and documented as such.

## Acceptance criteria

- [ ] Artwork round-trips through the path backend and through S3 against a local S3-compatible server in tests.
- [ ] A fresh install on each backend serves artwork.
- [ ] The read-only fallback is exercised in a test.

## TODOs

- [x] Read the artwork store choice from the environment and validate it when a role starts.
  - Validation: unit tests for defaults, each backend and each invalid combination; server typecheck.
- [x] Store, read and remove artwork through a backend interface, with the configured path as the first new backend.
  - Validation: disposable Postgres tests round-trip a poster through the path backend; the existing colocated tests stay green.
- [ ] Add the S3 backend on Bun's built-in S3 client and start a local S3-compatible server in CI.
  - Validation: a round-trip test against versitygw, skipped locally without `TEST_S3_URL` and required in CI.
- [ ] Fall back to the configured path when the colocated write hits a read-only share.
  - Validation: a test makes the Item folder unwritable and proves the poster lands in the configured path and reads back.
- [ ] Remove artwork from every backend when its Item, its selection or its Library goes away.
  - Validation: tests prove scan deletes, `removeSelectedArtwork` and library deletion remove path and S3 originals.
- [ ] Prove a fresh install serves artwork on each backend and document the settings.
  - Validation: an artwork route test per backend on a freshly migrated database; README and topology spec updated.

## Notes

- The backend is chosen by environment variables, read once per process. This matches `PENDIA_SCRATCH_DIR` and PR #77's `TMDB_API_KEY`, needs no new API or UI, and makes the choice an install-time decision, which fits "moving between backends is unsupported". `PENDIA_ARTWORK_STORE` is `colocated` (default), `path` or `s3`. `PENDIA_ARTWORK_PATH` is the directory for `path` and the read-only fallback for `colocated`.
- S3 settings use the variables Bun's S3 client already reads: `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, with the `AWS_` equivalents. No new dependency.
- Keys outside the colocated backend are flat: `<artwork-id>.<generation>`. Each replacement writes a fresh generation, as colocated does, so a reader never sees a half-written original.
- A selected row is reused across backends: replacing a poster keeps its artwork id and removes the previous original from whichever backend held it. This replaces #28's fresh-id rule for non-colocated rows; the id is only the URL, and the ETag follows the bytes.
- Rows whose backend is not configured in this process read as missing. Colocated rows always resolve, because their root is the Library root.
- Read-only means `EROFS` or `EACCES` from the colocated write. Without `PENDIA_ARTWORK_PATH` the error stands.
- MinIO no longer publishes images on Docker Hub or Quay, so the S3 tests run against `versity/versitygw` (101 MB, posix backend), started with `docker run --rm`.
