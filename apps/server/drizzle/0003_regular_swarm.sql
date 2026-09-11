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
ALTER TABLE "favourites" ADD CONSTRAINT "favourites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favourites" ADD CONSTRAINT "favourites_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress" ADD CONSTRAINT "progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress" ADD CONSTRAINT "progress_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Keep the Item, Format and position when its Version disappears.
ALTER TABLE "progress" ADD CONSTRAINT "progress_version_fk" FOREIGN KEY ("version_id","item_id","format") REFERENCES "public"."versions"("id","item_id","format") ON DELETE set null ("version_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "favourites_recent_idx" ON "favourites" USING btree ("user_id","created_at" DESC NULLS LAST,"item_id");--> statement-breakpoint
CREATE INDEX "progress_recent_idx" ON "progress" USING btree ("user_id","played_at" DESC NULLS LAST,"item_id");--> statement-breakpoint
CREATE INDEX "progress_continue_idx" ON "progress" USING btree ("user_id","played_at" DESC NULLS LAST,"item_id") WHERE not "progress"."completed" and "progress"."position_seconds" > 0;--> statement-breakpoint
CREATE INDEX "progress_item_idx" ON "progress" USING btree ("item_id","user_id");
