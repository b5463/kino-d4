CREATE TABLE "roll_devices" (
	"roll_id" text NOT NULL,
	"device_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roll_devices_roll_id_device_id_pk" PRIMARY KEY("roll_id","device_id")
);
--> statement-breakpoint
ALTER TABLE "roll_devices" ADD CONSTRAINT "roll_devices_roll_id_rolls_id_fk" FOREIGN KEY ("roll_id") REFERENCES "public"."rolls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roll_devices" ADD CONSTRAINT "roll_devices_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;