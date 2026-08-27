DROP INDEX "position_lots_wallet_id_mint_opened_at_idx";--> statement-breakpoint
ALTER TABLE "position_lots" ADD COLUMN "slot" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "position_lots" ADD COLUMN "transaction_index" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "lots_built_through_slot" bigint;--> statement-breakpoint
CREATE INDEX "position_lots_wallet_id_mint_slot_tx_idx" ON "position_lots" USING btree ("wallet_id","mint","slot","transaction_index");