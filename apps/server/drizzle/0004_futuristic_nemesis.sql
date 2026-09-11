CREATE TYPE "public"."job_state" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('scan', 'probe', 'provider-fetch', 'store', 'plugin');--> statement-breakpoint
CREATE TYPE "public"."play_method" AS ENUM('direct-play', 'remux', 'transcode');--> statement-breakpoint
CREATE TYPE "public"."playback_state" AS ENUM('queued', 'starting', 'playing', 'stopped');--> statement-breakpoint
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
ALTER TABLE "session_registry" ADD CONSTRAINT "session_registry_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_registry" ADD CONSTRAINT "session_registry_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_registry" ADD CONSTRAINT "session_registry_node_fk" FOREIGN KEY ("transcoder_node_id") REFERENCES "public"."transcoder_capabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_registry" ADD CONSTRAINT "session_registry_version_fk" FOREIGN KEY ("version_id","item_id") REFERENCES "public"."versions"("id","item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_queued_idx" ON "jobs" USING btree ("priority" DESC NULLS LAST,"run_after","id") WHERE "jobs"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_running_idx" ON "jobs" USING btree ("concurrency_key") WHERE "jobs"."state" = 'running';--> statement-breakpoint
CREATE INDEX "session_registry_node_state_idx" ON "session_registry" USING btree ("transcoder_node_id","state","created_at","id");--> statement-breakpoint
CREATE INDEX "session_registry_seen_idx" ON "session_registry" USING btree ("last_seen_at");
