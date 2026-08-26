CREATE TYPE "public"."constitution_status" AS ENUM('draft', 'committing', 'active');--> statement-breakpoint
CREATE TABLE "constitutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"status" "constitution_status" DEFAULT 'draft' NOT NULL,
	"document" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	"commitment_started_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "constitutions" ADD CONSTRAINT "constitutions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "constitutions" ADD CONSTRAINT "constitutions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "constitutions_user_id_idx" ON "constitutions" USING btree ("user_id");