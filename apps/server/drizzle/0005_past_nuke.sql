CREATE TYPE "public"."metadata_state" AS ENUM('pending', 'matched', 'unmatched');--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "metadata_state" "metadata_state" DEFAULT 'pending' NOT NULL;