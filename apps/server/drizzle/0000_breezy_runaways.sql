CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
-- Check every timeline boundary without discarding fractional seconds.
CREATE FUNCTION valid_segment_boundaries(boundaries double precision[])
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(
    cardinality(boundaries) >= 2 AND array_ndims(boundaries) = 1
    AND array_lower(boundaries, 1) = 1 AND boundaries[1] = 0
    AND NOT EXISTS (
      SELECT 1 FROM unnest(boundaries) WITH ORDINALITY AS entry(value, position)
      WHERE value IS NULL OR value < 0 OR value >= 'Infinity'::float8
        OR (position > 1 AND value <= boundaries[position - 1])
    ), false
  );
$$;--> statement-breakpoint
CREATE TYPE "public"."artwork_backend" AS ENUM('colocated', 'configured-path', 's3');--> statement-breakpoint
CREATE TYPE "public"."format" AS ENUM('video', 'audio', 'ebook', 'image');--> statement-breakpoint
CREATE TYPE "public"."item_kind" AS ENUM('movie', 'show', 'season', 'episode');--> statement-breakpoint
CREATE TYPE "public"."medium" AS ENUM('movies', 'shows');--> statement-breakpoint
CREATE TYPE "public"."stream_kind" AS ENUM('video', 'audio', 'subtitle');--> statement-breakpoint
CREATE TYPE "public"."version_origin" AS ENUM('imported', 'stored');--> statement-breakpoint
CREATE TABLE "artwork" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid,
	"version_id" uuid,
	"type" text NOT NULL,
	"source_url" text,
	"backend" "artwork_backend" NOT NULL,
	"storage_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"selected" boolean DEFAULT false NOT NULL,
	CONSTRAINT "artwork_owner_check" CHECK (num_nonnulls("artwork"."item_id", "artwork"."version_id") = 1),
	CONSTRAINT "artwork_width_check" CHECK ("artwork"."width" > 0),
	CONSTRAINT "artwork_height_check" CHECK ("artwork"."height" > 0)
);
--> statement-breakpoint
CREATE TABLE "contributors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"overview" text
);
--> statement-breakpoint
CREATE TABLE "credits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"contributor_id" uuid NOT NULL,
	"role" text NOT NULL,
	"character" text,
	"order" integer NOT NULL,
	CONSTRAINT "credits_order_check" CHECK ("credits"."order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"path" text NOT NULL,
	"order" integer NOT NULL,
	"bytes" bigint NOT NULL,
	"modified_at" timestamp with time zone NOT NULL,
	"container" text,
	"duration_seconds" double precision,
	"chapters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "files_version_order_unique" UNIQUE("version_id","order"),
	CONSTRAINT "files_version_path_unique" UNIQUE("version_id","path"),
	CONSTRAINT "files_bytes_check" CHECK ("files"."bytes" >= 0),
	CONSTRAINT "files_order_check" CHECK ("files"."order" >= 0),
	CONSTRAINT "files_duration_check" CHECK ("files"."duration_seconds" >= 0 and "files"."duration_seconds" < 'Infinity'::float8)
);
--> statement-breakpoint
CREATE TABLE "item_ancestors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ancestor_id" uuid NOT NULL,
	"descendant_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	CONSTRAINT "item_ancestors_pair_unique" UNIQUE("ancestor_id","descendant_id"),
	CONSTRAINT "item_ancestors_depth_check" CHECK ("item_ancestors"."depth" >= 0 and ("item_ancestors"."depth" = 0) = ("item_ancestors"."ancestor_id" = "item_ancestors"."descendant_id"))
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"library_id" uuid NOT NULL,
	"kind" "item_kind" NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"year" integer,
	"overview" text,
	"content_rating" text,
	"genres" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"canonical_folder" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_id_library_unique" UNIQUE("id","library_id"),
	CONSTRAINT "items_id_kind_unique" UNIQUE("id","kind"),
	CONSTRAINT "items_not_self_parent" CHECK ("items"."parent_id" <> "items"."id")
);
--> statement-breakpoint
CREATE TABLE "libraries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"medium" "medium" NOT NULL,
	"root_path" text NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_ids" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"value" text NOT NULL,
	"item_id" uuid,
	"contributor_id" uuid,
	CONSTRAINT "provider_ids_owner_check" CHECK (num_nonnulls("provider_ids"."item_id", "provider_ids"."contributor_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "segment_timelines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"cut_key" text NOT NULL,
	"boundaries_seconds" double precision[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_timelines_cut_unique" UNIQUE("item_id","cut_key"),
	CONSTRAINT "segment_timelines_id_item_unique" UNIQUE("id","item_id"),
	CONSTRAINT "segment_timelines_boundaries_check" CHECK (valid_segment_boundaries("segment_timelines"."boundaries_seconds"))
);
--> statement-breakpoint
CREATE TABLE "streams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"file_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"kind" "stream_kind" NOT NULL,
	"codec" text NOT NULL,
	"profile" text,
	"level" integer,
	"language" text,
	"title" text,
	"bitrate" bigint,
	"disposition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"width" integer,
	"height" integer,
	"frame_rate_numerator" integer,
	"frame_rate_denominator" integer,
	"hdr" text,
	"dv_profile" integer,
	"channels" integer,
	"channel_layout" text,
	"sample_rate" integer,
	CONSTRAINT "streams_file_index_unique" UNIQUE("file_id","index"),
	CONSTRAINT "streams_index_check" CHECK ("streams"."index" >= 0),
	CONSTRAINT "streams_bitrate_check" CHECK ("streams"."bitrate" >= 0),
	CONSTRAINT "streams_level_check" CHECK ("streams"."level" >= 0),
	CONSTRAINT "streams_width_check" CHECK ("streams"."width" > 0),
	CONSTRAINT "streams_height_check" CHECK ("streams"."height" > 0),
	CONSTRAINT "streams_frame_rate_check" CHECK (("streams"."frame_rate_numerator" is null and "streams"."frame_rate_denominator" is null) or ("streams"."frame_rate_numerator" is not null and "streams"."frame_rate_denominator" is not null and "streams"."frame_rate_numerator" > 0 and "streams"."frame_rate_denominator" > 0)),
	CONSTRAINT "streams_dv_profile_check" CHECK ("streams"."dv_profile" >= 0),
	CONSTRAINT "streams_channels_check" CHECK ("streams"."channels" > 0),
	CONSTRAINT "streams_sample_rate_check" CHECK ("streams"."sample_rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"label" text NOT NULL,
	"format" "format" NOT NULL,
	"bytes" bigint NOT NULL,
	"duration_seconds" double precision,
	"segment_timeline_id" uuid,
	"timeline_aligned" boolean DEFAULT false NOT NULL,
	"origin" "version_origin" DEFAULT 'imported' NOT NULL,
	"source_file_id" uuid,
	"stored_folder" text,
	"rung" text,
	"complete" boolean,
	CONSTRAINT "versions_id_item_format_unique" UNIQUE("id","item_id","format"),
	CONSTRAINT "versions_id_item_unique" UNIQUE("id","item_id"),
	CONSTRAINT "versions_bytes_check" CHECK ("versions"."bytes" >= 0),
	CONSTRAINT "versions_duration_check" CHECK ("versions"."duration_seconds" >= 0 and "versions"."duration_seconds" < 'Infinity'::float8),
	CONSTRAINT "versions_alignment_check" CHECK (not "versions"."timeline_aligned" or "versions"."segment_timeline_id" is not null),
	CONSTRAINT "versions_storage_check" CHECK (("versions"."origin" = 'imported' and "versions"."source_file_id" is null and "versions"."stored_folder" is null and "versions"."rung" is null and "versions"."complete" is null) or ("versions"."origin" = 'stored' and "versions"."format" = 'video' and "versions"."source_file_id" is not null and "versions"."stored_folder" is not null and "versions"."rung" is not null and "versions"."complete" is not null and "versions"."segment_timeline_id" is not null and "versions"."timeline_aligned"))
);
--> statement-breakpoint
ALTER TABLE "artwork" ADD CONSTRAINT "artwork_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork" ADD CONSTRAINT "artwork_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credits" ADD CONSTRAINT "credits_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credits" ADD CONSTRAINT "credits_contributor_id_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_ancestors" ADD CONSTRAINT "item_ancestors_ancestor_id_items_id_fk" FOREIGN KEY ("ancestor_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_ancestors" ADD CONSTRAINT "item_ancestors_descendant_id_items_id_fk" FOREIGN KEY ("descendant_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_parent_fk" FOREIGN KEY ("parent_id","library_id") REFERENCES "public"."items"("id","library_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_ids" ADD CONSTRAINT "provider_ids_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_ids" ADD CONSTRAINT "provider_ids_contributor_id_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_timelines" ADD CONSTRAINT "segment_timelines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streams" ADD CONSTRAINT "streams_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_source_file_id_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_timeline_fk" FOREIGN KEY ("segment_timeline_id","item_id") REFERENCES "public"."segment_timelines"("id","item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artwork_item_selected_unique" ON "artwork" USING btree ("item_id","type") WHERE "artwork"."selected" and "artwork"."item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "artwork_version_selected_unique" ON "artwork" USING btree ("version_id","type") WHERE "artwork"."selected" and "artwork"."version_id" is not null;--> statement-breakpoint
CREATE INDEX "artwork_item_type_idx" ON "artwork" USING btree ("item_id","type");--> statement-breakpoint
CREATE INDEX "artwork_version_type_idx" ON "artwork" USING btree ("version_id","type");--> statement-breakpoint
CREATE INDEX "credits_item_idx" ON "credits" USING btree ("item_id","role","order","id");--> statement-breakpoint
CREATE INDEX "credits_contributor_idx" ON "credits" USING btree ("contributor_id","role","item_id");--> statement-breakpoint
CREATE INDEX "files_library_path_idx" ON "files" USING btree ("library_id","path");--> statement-breakpoint
CREATE INDEX "item_ancestors_descendant_idx" ON "item_ancestors" USING btree ("descendant_id","depth","ancestor_id");--> statement-breakpoint
CREATE INDEX "items_added_idx" ON "items" USING btree ("added_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "items_library_added_idx" ON "items" USING btree ("library_id","added_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "items_kind_added_idx" ON "items" USING btree ("kind","added_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "items_parent_added_idx" ON "items" USING btree ("parent_id","added_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "items_folder_idx" ON "items" USING btree ("library_id","canonical_folder");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_ids_item_unique" ON "provider_ids" USING btree ("item_id","provider") WHERE "provider_ids"."item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_ids_contributor_unique" ON "provider_ids" USING btree ("contributor_id","provider") WHERE "provider_ids"."contributor_id" is not null;--> statement-breakpoint
CREATE INDEX "provider_ids_lookup_idx" ON "provider_ids" USING btree ("provider","value");--> statement-breakpoint
CREATE INDEX "versions_item_idx" ON "versions" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "versions_source_file_idx" ON "versions" USING btree ("source_file_id");--> statement-breakpoint
-- Lock the Version so a concurrent origin change cannot admit a File.
CREATE FUNCTION require_imported_file_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM versions WHERE id = NEW.version_id AND origin = 'imported' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Files require an imported Version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER files_imported_version BEFORE INSERT OR UPDATE OF version_id ON files
FOR EACH ROW EXECUTE FUNCTION require_imported_file_version();--> statement-breakpoint
CREATE FUNCTION require_fileless_stored_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin = 'stored' AND EXISTS (SELECT 1 FROM files WHERE version_id = NEW.id) THEN
    RAISE EXCEPTION 'Stored Versions have no Files' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER versions_no_stored_files BEFORE UPDATE OF origin ON versions
FOR EACH ROW EXECUTE FUNCTION require_fileless_stored_version();
