ALTER TABLE "ratings" ALTER COLUMN "value" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "liked" boolean;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_opinion_check" CHECK ("ratings"."value" is not null or "ratings"."liked" is not null);