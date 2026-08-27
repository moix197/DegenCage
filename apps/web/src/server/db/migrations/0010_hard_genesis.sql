CREATE TABLE "position_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"mint" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opened_after_activation" boolean NOT NULL,
	"remaining_base_units" text NOT NULL,
	"cost_basis_usd" numeric(38, 12)
);
--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "is_round_trip_close" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "realized_loss_usd" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "position_lots" ADD CONSTRAINT "position_lots_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "position_lots_wallet_id_mint_opened_at_idx" ON "position_lots" USING btree ("wallet_id","mint","opened_at");