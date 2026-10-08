ALTER TABLE "jobs" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE INDEX "jobs_dedupe_idx" ON "jobs" USING btree ("dedupe_key","state");