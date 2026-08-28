CREATE TABLE "trade_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"constitution_id" uuid NOT NULL,
	"status" text NOT NULL,
	"input_mint" text NOT NULL,
	"output_mint" text NOT NULL,
	"in_amount" text NOT NULL,
	"out_amount" text NOT NULL,
	"usd_value" numeric(38, 12),
	"acquired_tier" text,
	"evaluations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quote_response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tx_message_hash" text,
	"signature" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_intents" ADD CONSTRAINT "trade_intents_constitution_id_constitutions_id_fk" FOREIGN KEY ("constitution_id") REFERENCES "public"."constitutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trade_intents_wallet_id_status_idx" ON "trade_intents" USING btree ("wallet_id","status");