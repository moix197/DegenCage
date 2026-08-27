DROP INDEX "constitution_pending_changes_effective_at_idx";--> statement-breakpoint
DROP INDEX "constitution_pending_changes_constitution_id_idx";--> statement-breakpoint
ALTER TABLE "constitution_pending_changes" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "constitution_pending_changes_effective_at_idx" ON "constitution_pending_changes" USING btree ("effective_at","applied_at","voided_at");--> statement-breakpoint
CREATE INDEX "constitution_pending_changes_constitution_id_idx" ON "constitution_pending_changes" USING btree ("constitution_id","applied_at","voided_at");