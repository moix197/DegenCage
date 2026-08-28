ALTER TABLE "trades" ADD COLUMN "trade_intent_id" uuid;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_trade_intent_id_trade_intents_id_fk" FOREIGN KEY ("trade_intent_id") REFERENCES "public"."trade_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trades_trade_intent_id_idx" ON "trades" USING btree ("trade_intent_id");