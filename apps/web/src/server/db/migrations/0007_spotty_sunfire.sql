ALTER TABLE "trades" DROP CONSTRAINT "trades_signature_unique";--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "baseline_completed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "trades_wallet_id_signature_idx" ON "trades" USING btree ("wallet_id","signature");