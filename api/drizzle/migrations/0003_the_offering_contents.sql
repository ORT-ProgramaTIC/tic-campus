CREATE TABLE "campus"."offering_article" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_home_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"program_unit_id" uuid,
	"position" integer NOT NULL,
	"published_at" timestamp with time zone,
	"restricted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campus"."offering_home" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campus"."offering_article" ADD CONSTRAINT "offering_article_offering_home_id_offering_home_id_fk" FOREIGN KEY ("offering_home_id") REFERENCES "campus"."offering_home"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."offering_article" ADD CONSTRAINT "offering_article_article_id_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "campus"."article"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."offering_article" ADD CONSTRAINT "offering_article_program_unit_id_program_unit_id_fk" FOREIGN KEY ("program_unit_id") REFERENCES "campus"."program_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offering_article_home_article_idx" ON "campus"."offering_article" USING btree ("offering_home_id","article_id");--> statement-breakpoint
CREATE INDEX "offering_article_home_position_idx" ON "campus"."offering_article" USING btree ("offering_home_id","position");