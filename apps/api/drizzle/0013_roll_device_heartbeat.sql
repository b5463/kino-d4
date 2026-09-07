ALTER TABLE "roll_devices" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "roll_devices" ADD COLUMN "queue_pending" integer;--> statement-breakpoint
ALTER TABLE "roll_devices" ADD COLUMN "queue_uploading" integer;--> statement-breakpoint
ALTER TABLE "roll_devices" ADD COLUMN "queue_failed" integer;--> statement-breakpoint
ALTER TABLE "roll_devices" ADD COLUMN "server_state" text;--> statement-breakpoint
ALTER TABLE "roll_devices" ADD COLUMN "firmware_version" text;