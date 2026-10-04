ALTER TABLE "jobs" ADD COLUMN "claim_token" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_expires_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_lease_idx" ON "jobs" USING btree ("lease_expires_at") WHERE "jobs"."state" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_scan_library_idx" ON "jobs" USING btree (("payload"->>'libraryId')) WHERE "jobs"."type" = 'scan';--> statement-breakpoint
CREATE INDEX "jobs_scan_run_idx" ON "jobs" USING btree (("payload"->>'runId')) WHERE "jobs"."type" = 'scan';