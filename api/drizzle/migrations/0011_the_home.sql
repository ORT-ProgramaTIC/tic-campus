ALTER TABLE "campus"."offering_home" ADD COLUMN "sections" text[];--> statement-breakpoint
ALTER TABLE "campus"."offering_home" ADD COLUMN "links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "campus"."offering_home" ADD COLUMN "unit_order" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "campus"."offering_home" ADD COLUMN "hidden_units" uuid[] DEFAULT '{}' NOT NULL;