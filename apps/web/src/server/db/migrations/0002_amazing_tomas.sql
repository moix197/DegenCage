ALTER TABLE "siws_challenges" ADD COLUMN "client_key" text;--> statement-breakpoint
CREATE INDEX "siws_challenges_expires_at_idx" ON "siws_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "siws_challenges_client_key_issued_at_idx" ON "siws_challenges" USING btree ("client_key","issued_at");