CREATE TABLE "campus"."redo_covers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"redo_id" uuid NOT NULL,
	"covered_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campus"."offering_home" ADD COLUMN "redo_policy" text DEFAULT 'max' NOT NULL;--> statement-breakpoint
ALTER TABLE "campus"."redo_covers" ADD CONSTRAINT "redo_covers_redo_id_offering_article_id_fk" FOREIGN KEY ("redo_id") REFERENCES "campus"."offering_article"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."redo_covers" ADD CONSTRAINT "redo_covers_covered_id_offering_article_id_fk" FOREIGN KEY ("covered_id") REFERENCES "campus"."offering_article"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "redo_covers_redo_covered_idx" ON "campus"."redo_covers" USING btree ("redo_id","covered_id");--> statement-breakpoint
CREATE INDEX "redo_covers_covered_idx" ON "campus"."redo_covers" USING btree ("covered_id");