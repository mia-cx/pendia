CREATE TABLE "movies" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"kind" "item_kind" DEFAULT 'movie' NOT NULL,
	"release_date" date,
	CONSTRAINT "movies_kind_check" CHECK ("movies"."kind" = 'movie')
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
ALTER TABLE "movies" ADD CONSTRAINT "movies_item_kind_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."items"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_season_id_seasons_item_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_item_kind_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."items"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_show_id_shows_item_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_item_kind_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."items"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shows" ADD CONSTRAINT "shows_item_kind_fk" FOREIGN KEY ("item_id","kind") REFERENCES "public"."items"("id","kind") ON DELETE cascade ON UPDATE no action;