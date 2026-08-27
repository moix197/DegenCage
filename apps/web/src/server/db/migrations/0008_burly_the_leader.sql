ALTER TABLE "trades" ADD COLUMN "acquired_tier" text;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "is_acquisition" boolean DEFAULT false NOT NULL;