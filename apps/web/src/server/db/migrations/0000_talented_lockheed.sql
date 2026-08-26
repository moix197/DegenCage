CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"scope" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
