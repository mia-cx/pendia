CREATE TYPE "public"."scan_failure_reason" AS ENUM('unreadable', 'no-video');--> statement-breakpoint
CREATE TABLE "scan_failures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"root_id" uuid NOT NULL,
	"path" text NOT NULL,
	"bytes" bigint NOT NULL,
	"modified_ns" bigint NOT NULL,
	"reason" "scan_failure_reason" NOT NULL,
	"detail" text NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scan_failures_root_path_unique" UNIQUE("root_id","path"),
	CONSTRAINT "scan_failures_bytes_check" CHECK ("scan_failures"."bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "scan_failures" ADD CONSTRAINT "scan_failures_root_id_library_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."library_roots"("id") ON DELETE cascade ON UPDATE no action;