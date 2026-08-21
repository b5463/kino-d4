ALTER TABLE "assets" ADD COLUMN "producer" jsonb;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "produced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "provenance" jsonb;