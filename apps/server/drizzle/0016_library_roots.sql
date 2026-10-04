CREATE TABLE "library_roots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"library_id" uuid NOT NULL,
	"path" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "library_roots_path_unique" UNIQUE("path"),
	CONSTRAINT "library_roots_id_library_unique" UNIQUE("id","library_id")
);
--> statement-breakpoint
ALTER TABLE "library_roots" ADD CONSTRAINT "library_roots_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_roots_library_idx" ON "library_roots" USING btree ("library_id","position");--> statement-breakpoint
DO $$
DECLARE shared text;
BEGIN
	SELECT "root_path" INTO shared FROM "libraries" GROUP BY "root_path" HAVING count(*) > 1 LIMIT 1;
	IF shared IS NOT NULL THEN
		RAISE EXCEPTION 'Several libraries use the root %. Delete all but one of them, then upgrade again.', shared;
	END IF;
END $$;--> statement-breakpoint
INSERT INTO "library_roots" ("id", "library_id", "path", "position") SELECT gen_random_uuid(), "id", "root_path", 0 FROM "libraries";--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_library_path_unique";--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "root_id" uuid;--> statement-breakpoint
UPDATE "files" SET "root_id" = "library_roots"."id" FROM "library_roots" WHERE "library_roots"."library_id" = "files"."library_id";--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "root_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_root_library_fk" FOREIGN KEY ("root_id","library_id") REFERENCES "public"."library_roots"("id","library_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_root_path_unique" UNIQUE("root_id","path");--> statement-breakpoint
ALTER TABLE "probe_cache" DROP CONSTRAINT "probe_cache_library_path_unique";--> statement-breakpoint
ALTER TABLE "probe_cache" DROP CONSTRAINT "probe_cache_library_id_libraries_id_fk";--> statement-breakpoint
ALTER TABLE "probe_cache" ADD COLUMN "root_id" uuid;--> statement-breakpoint
UPDATE "probe_cache" SET "root_id" = "library_roots"."id" FROM "library_roots" WHERE "library_roots"."library_id" = "probe_cache"."library_id";--> statement-breakpoint
ALTER TABLE "probe_cache" ALTER COLUMN "root_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "probe_cache" DROP COLUMN "library_id";--> statement-breakpoint
ALTER TABLE "probe_cache" ADD CONSTRAINT "probe_cache_root_id_library_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."library_roots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_cache" ADD CONSTRAINT "probe_cache_root_path_unique" UNIQUE("root_id","path");--> statement-breakpoint
UPDATE "jobs" SET "payload" = jsonb_set("payload", '{changes}', (SELECT jsonb_agg("change" || jsonb_build_object('rootId', "library_roots"."id")) FROM jsonb_array_elements("jobs"."payload"->'changes') AS "change")) FROM "library_roots" WHERE "jobs"."type" = 'scan' AND "jobs"."state" IN ('queued', 'running') AND jsonb_typeof("jobs"."payload"->'changes') = 'array' AND jsonb_array_length("jobs"."payload"->'changes') > 0 AND "library_roots"."library_id" = ("jobs"."payload"->>'libraryId')::uuid;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "roots_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "libraries" DROP COLUMN "root_path";
