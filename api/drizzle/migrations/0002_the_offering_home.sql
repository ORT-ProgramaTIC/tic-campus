CREATE TABLE "campus"."offering_home" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_id" integer NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campus"."offering_home" ADD CONSTRAINT "offering_home_offering_id_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."offering"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."offering_home" ADD CONSTRAINT "offering_home_activated_by_user_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offering_home_offering_idx" ON "campus"."offering_home" USING btree ("offering_id");