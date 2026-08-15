DROP INDEX "assets_capture_role_frame";--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_capture_role_frame" UNIQUE NULLS NOT DISTINCT("capture_id","role","frame_index");