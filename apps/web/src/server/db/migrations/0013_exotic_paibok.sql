CREATE TABLE "constitution_pending_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"constitution_id" uuid NOT NULL,
	"limit_id" text NOT NULL,
	"field" text NOT NULL,
	"old_value" text NOT NULL,
	"new_value" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "constitution_pending_changes" ADD CONSTRAINT "constitution_pending_changes_constitution_id_constitutions_id_fk" FOREIGN KEY ("constitution_id") REFERENCES "public"."constitutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "constitution_pending_changes_effective_at_idx" ON "constitution_pending_changes" USING btree ("effective_at","applied_at");--> statement-breakpoint
CREATE INDEX "constitution_pending_changes_constitution_id_idx" ON "constitution_pending_changes" USING btree ("constitution_id","applied_at");