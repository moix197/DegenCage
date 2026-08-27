CREATE TABLE "admin_login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_key" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"succeeded" boolean NOT NULL
);
--> statement-breakpoint
CREATE INDEX "admin_login_attempts_client_key_attempted_at_idx" ON "admin_login_attempts" USING btree ("client_key","attempted_at");