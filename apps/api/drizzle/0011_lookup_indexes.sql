CREATE UNIQUE INDEX "devices_token_hash_unique" ON "devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "processing_events_capture_job_at" ON "processing_events" USING btree ("capture_id","job","at" desc);--> statement-breakpoint
CREATE INDEX "roll_devices_device" ON "roll_devices" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "rolls_created_by_device" ON "rolls" USING btree ("created_by_device_id") WHERE "rolls"."created_by_device_id" is not null;