ALTER TABLE "versions" ADD COLUMN "keyframes_seconds" double precision[];--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "lazy_index_pending" boolean DEFAULT true NOT NULL;