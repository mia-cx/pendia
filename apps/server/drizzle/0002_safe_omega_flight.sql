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
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_access_user_unique" ON "library_access" USING btree ("user_id","library_id") WHERE "library_access"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "library_access_group_unique" ON "library_access" USING btree ("group_id","library_id") WHERE "library_access"."group_id" is not null;--> statement-breakpoint
CREATE INDEX "library_access_library_idx" ON "library_access" USING btree ("library_id");--> statement-breakpoint
CREATE INDEX "sessions_user_seen_idx" ON "sessions" USING btree ("user_id","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_groups_group_idx" ON "user_groups" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email")) WHERE "users"."email" is not null;
