CREATE TABLE "campus"."presentation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_home_id" uuid NOT NULL,
	"project_id" integer NOT NULL,
	"round" integer NOT NULL,
	"position" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"pinned_block_id" uuid,
	"pinned_slot" integer
);
--> statement-breakpoint
CREATE TABLE "campus"."presentation_block" (
	"id" uuid PRIMARY KEY NOT NULL,
	"offering_home_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"date" date NOT NULL,
	"block" integer NOT NULL,
	"slot_count" integer DEFAULT 3 NOT NULL,
	"slot_starts" text[]
);
--> statement-breakpoint
ALTER TABLE "campus"."offering_home" ADD COLUMN "schedule_saved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campus"."presentation" ADD CONSTRAINT "presentation_offering_home_id_offering_home_id_fk" FOREIGN KEY ("offering_home_id") REFERENCES "campus"."offering_home"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."presentation" ADD CONSTRAINT "presentation_pinned_block_id_presentation_block_id_fk" FOREIGN KEY ("pinned_block_id") REFERENCES "campus"."presentation_block"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."presentation_block" ADD CONSTRAINT "presentation_block_offering_home_id_offering_home_id_fk" FOREIGN KEY ("offering_home_id") REFERENCES "campus"."offering_home"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "presentation_home_round_project_idx" ON "campus"."presentation" USING btree ("offering_home_id","round","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "presentation_pin_idx" ON "campus"."presentation" USING btree ("pinned_block_id","pinned_slot") WHERE pinned_block_id is not null;--> statement-breakpoint
CREATE INDEX "presentation_pinned_block_idx" ON "campus"."presentation" USING btree ("pinned_block_id");--> statement-breakpoint
CREATE UNIQUE INDEX "presentation_block_home_date_block_idx" ON "campus"."presentation_block" USING btree ("offering_home_id","date","block");