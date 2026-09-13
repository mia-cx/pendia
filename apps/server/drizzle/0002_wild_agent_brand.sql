CREATE TABLE "probe_cache" (
	"id" uuid PRIMARY KEY NOT NULL,
	"library_id" uuid NOT NULL,
	"path" text NOT NULL,
	"bytes" bigint NOT NULL,
	"modified_ns" bigint NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "probe_cache_library_path_unique" UNIQUE("library_id","path"),
	CONSTRAINT "probe_cache_bytes_check" CHECK ("probe_cache"."bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "probe_cache" ADD CONSTRAINT "probe_cache_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;