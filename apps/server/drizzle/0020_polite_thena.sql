ALTER TABLE "jobs" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE INDEX "jobs_dedupe_idx" ON "jobs" USING btree ("dedupe_key","state");--> statement-breakpoint
-- Unsettled scan jobs predate the key; rebuild it so they still coalesce. A
-- whole-Library scan is `path='.'` with no runId and no changes key.
UPDATE "jobs"
SET "dedupe_key" =
  'scan:' || (payload->>'libraryId') || ':' ||
  (CASE WHEN payload->>'path' = '.' AND payload->>'runId' IS NULL AND payload->'changes' IS NULL
        THEN 'library' ELSE 'folder' END) || ':' ||
  (payload->>'path')
WHERE "type" = 'scan' AND "state" IN ('queued', 'running');