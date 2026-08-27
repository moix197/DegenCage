-- position_lots is fully rebuildable from trades by backfillLotMatching() (reconcile-wallet.ts),
-- so wiping it here is the clean path — it is either empty already (this migration's own
-- prior state, in this project, had no rows yet) or, on a DB that already reconciled and
-- lot-matched under the old (opened_at-only-ordered) shape, stale relative to the new
-- slot/transaction_index columns being added below. Discarding and re-deriving is simpler and
-- safer than trying to backfill slot/transaction_index onto existing rows in place.
DELETE FROM "position_lots";--> statement-breakpoint
-- Every trade's lot-matching outcome depended on that now-discarded position_lots state, so it
-- is reset alongside it — wallets.lots_built_through_slot stays NULL for every row (it is a
-- brand-new column as of this migration), so reconcileWallet()'s own backfill mechanism
-- reconstructs both position_lots and these two columns correctly on the next run.
UPDATE "trades" SET "is_round_trip_close" = false, "realized_loss_usd" = NULL;--> statement-breakpoint
DROP INDEX "position_lots_wallet_id_mint_opened_at_idx";--> statement-breakpoint
ALTER TABLE "position_lots" ADD COLUMN "slot" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "position_lots" ADD COLUMN "transaction_index" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "lots_built_through_slot" bigint;--> statement-breakpoint
CREATE INDEX "position_lots_wallet_id_mint_slot_tx_idx" ON "position_lots" USING btree ("wallet_id","mint","slot","transaction_index");
