CREATE TYPE "public"."reconciliation_state" AS ENUM('never', 'in_progress', 'current', 'failed');--> statement-breakpoint
CREATE TABLE "token_prices" (
	"mint" text NOT NULL,
	"minute_bucket_utc" timestamp with time zone NOT NULL,
	"usd_price" numeric(38, 12) NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_prices_mint_minute_bucket_utc_pk" PRIMARY KEY("mint","minute_bucket_utc")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"transaction_index" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sold_mint" text,
	"bought_mint" text,
	"sold_amount_base_units" text,
	"bought_amount_base_units" text,
	"usd_value" numeric(38, 12),
	"price_source" text,
	"is_baseline" boolean DEFAULT false NOT NULL,
	"excluded_reason" text,
	CONSTRAINT "trades_signature_unique" UNIQUE("signature")
);
--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "reconciled_through_slot" bigint;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "reconciliation_state" "reconciliation_state" DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trades_wallet_id_occurred_at_idx" ON "trades" USING btree ("wallet_id","occurred_at");