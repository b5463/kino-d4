CREATE TABLE "recap_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"roll_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "recap_jobs" ADD CONSTRAINT "recap_jobs_roll_id_rolls_id_fk" FOREIGN KEY ("roll_id") REFERENCES "public"."rolls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recap_jobs_roll_live" ON "recap_jobs" USING btree ("roll_id") WHERE "recap_jobs"."status" in ('queued', 'running');