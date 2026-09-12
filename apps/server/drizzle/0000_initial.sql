CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
-- Define the validator before the table check that calls it.
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
CREATE TYPE "public"."job_state" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('scan', 'probe', 'provider-fetch', 'store', 'plugin');--> statement-breakpoint
CREATE TYPE "public"."play_method" AS ENUM('direct-play', 'remux', 'transcode');--> statement-breakpoint
CREATE TYPE "public"."playback_state" AS ENUM('queued', 'starting', 'playing', 'stopped');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "api_keys_token_hash_check" CHECK (octet_length("api_keys"."token_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "groups_name_unique" UNIQUE("name"),
	CONSTRAINT "groups_permissions_check" CHECK ("groups"."permissions" <@ ARRAY['view','play','manage-libraries','manage-metadata','manage-subtitles','manage-users','manage-plugins','manage-transcoding','manage-server']::text[])
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_token_hash_check" CHECK (octet_length("invites"."token_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "library_access" (
	"id" uuid PRIMARY KEY NOT NULL,
	"library_id" uuid NOT NULL,
	"user_id" uuid,
	"group_id" uuid,
	"allowed" boolean NOT NULL,
	CONSTRAINT "library_access_principal_check" CHECK (num_nonnulls("library_access"."user_id", "library_access"."group_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"client_name" text NOT NULL,
	"device_id" text NOT NULL,
	"device_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_token_hash_check" CHECK (octet_length("sessions"."token_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "user_groups_membership_unique" UNIQUE("user_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "user_permission_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"allowed" boolean NOT NULL,
	CONSTRAINT "user_permission_overrides_unique" UNIQUE("user_id","permission"),
	CONSTRAINT "user_permission_overrides_permission_check" CHECK ("user_permission_overrides"."permission" = ANY(ARRAY['view','play','manage-libraries','manage-metadata','manage-subtitles','manage-users','manage-plugins','manage-transcoding','manage-server']::text[]))
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"bitrate_cap_bps" bigint,
	"content_rating_ceiling" text,
	CONSTRAINT "user_settings_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "user_settings_bitrate_check" CHECK ("user_settings"."bitrate_cap_bps" > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"password_hash" text,
	"oidc_issuer" text,
	"oidc_subject" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_oidc_unique" UNIQUE("oidc_issuer","oidc_subject"),
	CONSTRAINT "users_oidc_pair_check" CHECK (("users"."oidc_issuer" is null) = ("users"."oidc_subject" is null)),
	CONSTRAINT "users_identity_check" CHECK ("users"."password_hash" is not null or ("users"."oidc_issuer" is not null and "users"."oidc_subject" is not null))
);
--> statement-breakpoint
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
	"item_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"path" text NOT NULL,
	"order" integer NOT NULL,
	"bytes" bigint NOT NULL,
	"modified_at" timestamp with time zone NOT NULL,
	"container" text,
	"duration_seconds" double precision,
	"chapters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "files_version_order_unique" UNIQUE("version_id","order"),
	CONSTRAINT "files_library_path_unique" UNIQUE("library_id","path"),
	CONSTRAINT "files_id_item_unique" UNIQUE("id","item_id"),
	CONSTRAINT "files_id_version_unique" UNIQUE("id","version_id"),
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
	"version_id" uuid NOT NULL,
	"file_id" uuid,
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
	"item_kind" "item_kind" NOT NULL,
	"library_id" uuid NOT NULL,
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
	CONSTRAINT "versions_id_library_unique" UNIQUE("id","library_id"),
	CONSTRAINT "versions_item_kind_check" CHECK ("versions"."item_kind" in ('movie', 'episode')),
	CONSTRAINT "versions_bytes_check" CHECK ("versions"."bytes" >= 0),
	CONSTRAINT "versions_duration_check" CHECK ("versions"."duration_seconds" >= 0 and "versions"."duration_seconds" < 'Infinity'::float8),
	CONSTRAINT "versions_alignment_check" CHECK (not "versions"."timeline_aligned" or "versions"."segment_timeline_id" is not null),
	CONSTRAINT "versions_storage_check" CHECK (("versions"."origin" = 'imported' and "versions"."source_file_id" is null and "versions"."stored_folder" is null and "versions"."rung" is null and "versions"."complete" is null) or ("versions"."origin" = 'stored' and "versions"."format" = 'video' and "versions"."source_file_id" is not null and "versions"."stored_folder" is not null and "versions"."rung" is not null and "versions"."complete" is not null and "versions"."segment_timeline_id" is not null and "versions"."timeline_aligned"))
);
--> statement-breakpoint
CREATE TABLE "favourites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favourites_user_item_unique" UNIQUE("user_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "progress" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"version_id" uuid,
	"format" "format" NOT NULL,
	"position_seconds" double precision DEFAULT 0 NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"played_at" timestamp with time zone,
	"play_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "progress_user_item_unique" UNIQUE("user_id","item_id"),
	CONSTRAINT "progress_position_check" CHECK ("progress"."position_seconds" >= 0 and "progress"."position_seconds" < 'Infinity'::float8),
	CONSTRAINT "progress_play_count_check" CHECK ("progress"."play_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"value" numeric(3, 1) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ratings_user_item_unique" UNIQUE("user_id","item_id"),
	CONSTRAINT "ratings_value_check" CHECK ("ratings"."value" >= 0 and "ratings"."value" <= 10)
);
--> statement-breakpoint
CREATE TABLE "movies" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"kind" "item_kind" DEFAULT 'movie' NOT NULL,
	"release_date" date,
	CONSTRAINT "movies_kind_check" CHECK ("movies"."kind" = 'movie')
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" "job_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"concurrency_key" text,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"error" text,
	CONSTRAINT "jobs_attempts_check" CHECK ("jobs"."attempts" >= 0 and "jobs"."max_attempts" > 0 and "jobs"."attempts" <= "jobs"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "plugin_lockfile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"source" text NOT NULL,
	"integrity" text NOT NULL,
	CONSTRAINT "plugin_lockfile_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "session_registry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"play_method" "play_method" NOT NULL,
	"state" "playback_state" NOT NULL,
	"transcoder_node_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "transcoder_capabilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"tested_at" timestamp with time zone NOT NULL,
	"backends" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"kind" "item_kind" DEFAULT 'episode' NOT NULL,
	"season_id" uuid NOT NULL,
	"episode_number" integer NOT NULL,
	"episode_end_number" integer,
	"air_date" date,
	CONSTRAINT "episodes_season_number_unique" UNIQUE("season_id","episode_number"),
	CONSTRAINT "episodes_kind_check" CHECK ("episodes"."kind" = 'episode'),
	CONSTRAINT "episodes_number_check" CHECK ("episodes"."episode_number" >= 0),
	CONSTRAINT "episodes_end_number_check" CHECK ("episodes"."episode_end_number" >= "episodes"."episode_number")
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"kind" "item_kind" DEFAULT 'season' NOT NULL,
	"show_id" uuid NOT NULL,
	"season_number" integer NOT NULL,
	"air_date" date,
	CONSTRAINT "seasons_show_number_unique" UNIQUE("show_id","season_number"),
	CONSTRAINT "seasons_kind_check" CHECK ("seasons"."kind" = 'season'),
	CONSTRAINT "seasons_number_check" CHECK ("seasons"."season_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shows" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"kind" "item_kind" DEFAULT 'show' NOT NULL,
	"first_air_date" date,
	"last_air_date" date,
	"status" text,
	CONSTRAINT "shows_kind_check" CHECK ("shows"."kind" = 'show')
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_access" ADD CONSTRAINT "library_access_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_access" ADD CONSTRAINT "library_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_access" ADD CONSTRAINT "library_access_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork" ADD CONSTRAINT "artwork_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork" ADD CONSTRAINT "artwork_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credits" ADD CONSTRAINT "credits_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credits" ADD CONSTRAINT "credits_contributor_id_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_version_item_fk" FOREIGN KEY ("version_id","item_id") REFERENCES "public"."versions"("id","item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_version_library_fk" FOREIGN KEY ("version_id","library_id") REFERENCES "public"."versions"("id","library_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_ancestors" ADD CONSTRAINT "item_ancestors_ancestor_id_items_id_fk" FOREIGN KEY ("ancestor_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_ancestors" ADD CONSTRAINT "item_ancestors_descendant_id_items_id_fk" FOREIGN KEY ("descendant_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_parent_fk" FOREIGN KEY ("parent_id","library_id") REFERENCES "public"."items"("id","library_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_ids" ADD CONSTRAINT "provider_ids_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_ids" ADD CONSTRAINT "provider_ids_contributor_id_contributors_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_timelines" ADD CONSTRAINT "segment_timelines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streams" ADD CONSTRAINT "streams_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streams" ADD CONSTRAINT "streams_file_version_fk" FOREIGN KEY ("file_id","version_id") REFERENCES "public"."files"("id","version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_item_kind_fk" FOREIGN KEY ("item_id","item_kind") REFERENCES "public"."items"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_item_library_fk" FOREIGN KEY ("item_id","library_id") REFERENCES "public"."items"("id","library_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_source_file_fk" FOREIGN KEY ("source_file_id","item_id") REFERENCES "public"."files"("id","item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_timeline_fk" FOREIGN KEY ("segment_timeline_id","item_id") REFERENCES "public"."segment_timelines"("id","item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favourites" ADD CONSTRAINT "favourites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favourites" ADD CONSTRAINT "favourites_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress" ADD CONSTRAINT "progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress" ADD CONSTRAINT "progress_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress" ADD CONSTRAINT "progress_version_fk" FOREIGN KEY ("version_id","item_id","format") REFERENCES "public"."versions"("id","item_id","format") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movies" ADD CONSTRAINT "movies_item_kind_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."items"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_registry" ADD CONSTRAINT "session_registry_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_registry" ADD CONSTRAINT "session_registry_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_registry" ADD CONSTRAINT "session_registry_node_fk" FOREIGN KEY ("transcoder_node_id") REFERENCES "public"."transcoder_capabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_registry" ADD CONSTRAINT "session_registry_version_fk" FOREIGN KEY ("version_id","item_id") REFERENCES "public"."versions"("id","item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_season_id_seasons_item_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_item_kind_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."items"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_show_id_shows_item_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_item_kind_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."items"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shows" ADD CONSTRAINT "shows_item_kind_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."items"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_access_user_unique" ON "library_access" USING btree ("user_id","library_id") WHERE "library_access"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "library_access_group_unique" ON "library_access" USING btree ("group_id","library_id") WHERE "library_access"."group_id" is not null;--> statement-breakpoint
CREATE INDEX "library_access_library_idx" ON "library_access" USING btree ("library_id");--> statement-breakpoint
CREATE INDEX "sessions_user_seen_idx" ON "sessions" USING btree ("user_id","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_groups_group_idx" ON "user_groups" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email")) WHERE "users"."email" is not null;--> statement-breakpoint
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
CREATE UNIQUE INDEX "streams_file_index_unique" ON "streams" USING btree ("file_id","index") WHERE "streams"."file_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "streams_version_index_unique" ON "streams" USING btree ("version_id","index") WHERE "streams"."file_id" is null;--> statement-breakpoint
CREATE INDEX "versions_item_idx" ON "versions" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "versions_source_file_idx" ON "versions" USING btree ("source_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_source_file_rung_unique" ON "versions" USING btree ("source_file_id","rung") WHERE "versions"."origin" = 'stored';--> statement-breakpoint
CREATE INDEX "favourites_recent_idx" ON "favourites" USING btree ("user_id","created_at" DESC NULLS LAST,"item_id");--> statement-breakpoint
CREATE INDEX "progress_recent_idx" ON "progress" USING btree ("user_id","played_at" DESC NULLS LAST,"item_id");--> statement-breakpoint
CREATE INDEX "progress_continue_idx" ON "progress" USING btree ("user_id","played_at" DESC NULLS LAST,"item_id") WHERE not "progress"."completed" and "progress"."position_seconds" > 0;--> statement-breakpoint
CREATE INDEX "progress_item_idx" ON "progress" USING btree ("item_id","user_id");--> statement-breakpoint
CREATE INDEX "jobs_queued_idx" ON "jobs" USING btree ("priority" DESC NULLS LAST,"run_after","id") WHERE "jobs"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_running_idx" ON "jobs" USING btree ("concurrency_key") WHERE "jobs"."state" = 'running';--> statement-breakpoint
CREATE INDEX "session_registry_node_state_idx" ON "session_registry" USING btree ("transcoder_node_id","state","created_at","id");--> statement-breakpoint
CREATE INDEX "session_registry_seen_idx" ON "session_registry" USING btree ("last_seen_at");--> statement-breakpoint
-- Stored Versions own Streams. These triggers restrict only Files.
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
FOR EACH ROW EXECUTE FUNCTION require_fileless_stored_version();--> statement-breakpoint
-- Keep the Item, Format and position when its Version disappears.
ALTER TABLE "progress" DROP CONSTRAINT "progress_version_fk";--> statement-breakpoint
ALTER TABLE "progress" ADD CONSTRAINT "progress_version_fk" FOREIGN KEY ("version_id","item_id","format") REFERENCES "public"."versions"("id","item_id","format") ON DELETE set null ("version_id") ON UPDATE no action;--> statement-breakpoint
-- Episode ranges include both endpoints and must not overlap within a season.
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_season_range_exclude"
EXCLUDE USING gist ("season_id" WITH =, int4range("episode_number", coalesce("episode_end_number", "episode_number"), '[]') WITH &&);--> statement-breakpoint
-- Stored encodes use the timeline of the Version that owns their source File.
CREATE FUNCTION require_stored_source_timeline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM files AS source_file
    JOIN versions AS source_version ON source_version.id = source_file.version_id
    WHERE source_file.id = NEW.source_file_id AND source_file.item_id = NEW.item_id
      AND source_version.segment_timeline_id IS DISTINCT FROM NEW.segment_timeline_id
  ) THEN
    RAISE EXCEPTION 'Stored Version timeline must match its source Version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER versions_stored_source_timeline BEFORE INSERT OR UPDATE ON versions
FOR EACH ROW WHEN (NEW.origin = 'stored') EXECUTE FUNCTION require_stored_source_timeline();
