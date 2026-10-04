CREATE TABLE "quick_connect_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"secret_hash" "bytea" NOT NULL,
	"code" text NOT NULL,
	"client_name" text NOT NULL,
	"client_version" text NOT NULL,
	"device_id" text NOT NULL,
	"device_name" text NOT NULL,
	"address" text NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "quick_connect_requests_secret_hash_unique" UNIQUE("secret_hash"),
	CONSTRAINT "quick_connect_requests_code_unique" UNIQUE("code"),
	CONSTRAINT "quick_connect_requests_secret_hash_check" CHECK (octet_length("quick_connect_requests"."secret_hash") = 32),
	CONSTRAINT "quick_connect_requests_code_check" CHECK ("quick_connect_requests"."code" ~ '^[0-9]{6}$')
);
--> statement-breakpoint
ALTER TABLE "quick_connect_requests" ADD CONSTRAINT "quick_connect_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quick_connect_requests_expires_idx" ON "quick_connect_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "quick_connect_requests_address_idx" ON "quick_connect_requests" USING btree ("address","expires_at");