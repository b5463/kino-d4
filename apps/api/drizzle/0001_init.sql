CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"capture_id" text NOT NULL,
	"role" text NOT NULL,
	"frame_index" integer,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"bytes" bigint,
	"sha256" text,
	"object_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"roll_id" text,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" text PRIMARY KEY NOT NULL,
	"capture_uuid" text NOT NULL,
	"roll_id" text NOT NULL,
	"device_id" text NOT NULL,
	"mode" text NOT NULL,
	"look" text,
	"captured_at" timestamp with time zone NOT NULL,
	"frame_count" integer NOT NULL,
	"resolution" text NOT NULL,
	"timing" jsonb,
	"status" text DEFAULT 'created' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"serial" text NOT NULL,
	"product" text NOT NULL,
	"hardware_revision" text NOT NULL,
	"name" text,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_serial_unique" UNIQUE("serial")
);
--> statement-breakpoint
CREATE TABLE "firmware_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"release" text NOT NULL,
	"channel" text DEFAULT 'stable' NOT NULL,
	"compatible_hardware" jsonb NOT NULL,
	"protocol_min" integer NOT NULL,
	"protocol_max" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"notes" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"capture_id" text NOT NULL,
	"job" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"id" text PRIMARY KEY NOT NULL,
	"capture_id" text NOT NULL,
	"guest_id" text NOT NULL,
	"kind" text DEFAULT 'heart' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rolls" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'live' NOT NULL,
	"privacy" text DEFAULT 'unlisted' NOT NULL,
	"pin_hash" text,
	"downloads_enabled" boolean DEFAULT true NOT NULL,
	"reactions_enabled" boolean DEFAULT true NOT NULL,
	"host_token_hash" text NOT NULL,
	"created_by_device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "rolls_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "upload_parts" (
	"upload_id" text NOT NULL,
	"part_no" integer NOT NULL,
	"bytes" integer NOT NULL,
	"etag" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"s3_upload_id" text,
	"bytes_expected" bigint NOT NULL,
	"sha256_expected" text NOT NULL,
	"parts_received" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_sessions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_roll_id_rolls_id_fk" FOREIGN KEY ("roll_id") REFERENCES "public"."rolls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_roll_id_rolls_id_fk" FOREIGN KEY ("roll_id") REFERENCES "public"."rolls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_events" ADD CONSTRAINT "processing_events_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rolls" ADD CONSTRAINT "rolls_created_by_device_id_devices_id_fk" FOREIGN KEY ("created_by_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_parts" ADD CONSTRAINT "upload_parts_upload_id_upload_sessions_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."upload_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_capture_role_frame" ON "assets" USING btree ("capture_id","role","frame_index");--> statement-breakpoint
CREATE UNIQUE INDEX "captures_roll_uuid" ON "captures" USING btree ("roll_id","capture_uuid");--> statement-breakpoint
CREATE INDEX "captures_roll_created" ON "captures" USING btree ("roll_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "firmware_release_channel" ON "firmware_releases" USING btree ("release","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "reactions_unique" ON "reactions" USING btree ("capture_id","guest_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_parts_pk" ON "upload_parts" USING btree ("upload_id","part_no");