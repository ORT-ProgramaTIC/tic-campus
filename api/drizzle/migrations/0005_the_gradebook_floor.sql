CREATE TABLE "campus"."offering_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_home_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campus"."offering_scale" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_home_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campus"."offering_scale_level" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_scale_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" numeric(4, 2) NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campus"."offering_term" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_home_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campus"."result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" integer NOT NULL,
	"offering_article_id" uuid NOT NULL,
	"value" numeric(4, 2) NOT NULL,
	"scale_level_id" uuid,
	"feedback" text,
	"recorded_by" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campus"."offering_article" ADD COLUMN "offering_group_id" uuid;--> statement-breakpoint
ALTER TABLE "campus"."offering_article" ADD COLUMN "offering_term_id" uuid;--> statement-breakpoint
ALTER TABLE "campus"."offering_article" ADD COLUMN "value_type" text;--> statement-breakpoint
ALTER TABLE "campus"."offering_article" ADD COLUMN "offering_scale_id" uuid;--> statement-breakpoint
ALTER TABLE "campus"."offering_article" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campus"."offering_article" ADD COLUMN "results_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campus"."offering_group" ADD CONSTRAINT "offering_group_offering_home_id_offering_home_id_fk" FOREIGN KEY ("offering_home_id") REFERENCES "campus"."offering_home"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."offering_scale" ADD CONSTRAINT "offering_scale_offering_home_id_offering_home_id_fk" FOREIGN KEY ("offering_home_id") REFERENCES "campus"."offering_home"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."offering_scale_level" ADD CONSTRAINT "offering_scale_level_offering_scale_id_offering_scale_id_fk" FOREIGN KEY ("offering_scale_id") REFERENCES "campus"."offering_scale"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."offering_term" ADD CONSTRAINT "offering_term_offering_home_id_offering_home_id_fk" FOREIGN KEY ("offering_home_id") REFERENCES "campus"."offering_home"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."result" ADD CONSTRAINT "result_student_id_user_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."result" ADD CONSTRAINT "result_offering_article_id_offering_article_id_fk" FOREIGN KEY ("offering_article_id") REFERENCES "campus"."offering_article"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."result" ADD CONSTRAINT "result_scale_level_id_offering_scale_level_id_fk" FOREIGN KEY ("scale_level_id") REFERENCES "campus"."offering_scale_level"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."result" ADD CONSTRAINT "result_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offering_group_home_name_idx" ON "campus"."offering_group" USING btree ("offering_home_id","name");--> statement-breakpoint
CREATE INDEX "offering_group_home_position_idx" ON "campus"."offering_group" USING btree ("offering_home_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "offering_scale_home_name_idx" ON "campus"."offering_scale" USING btree ("offering_home_id","name");--> statement-breakpoint
CREATE INDEX "offering_scale_home_position_idx" ON "campus"."offering_scale" USING btree ("offering_home_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "offering_scale_level_scale_name_idx" ON "campus"."offering_scale_level" USING btree ("offering_scale_id","name");--> statement-breakpoint
CREATE INDEX "offering_scale_level_scale_position_idx" ON "campus"."offering_scale_level" USING btree ("offering_scale_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "offering_term_home_name_idx" ON "campus"."offering_term" USING btree ("offering_home_id","name");--> statement-breakpoint
CREATE INDEX "offering_term_home_position_idx" ON "campus"."offering_term" USING btree ("offering_home_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "result_article_student_idx" ON "campus"."result" USING btree ("offering_article_id","student_id");--> statement-breakpoint
ALTER TABLE "campus"."offering_article" ADD CONSTRAINT "offering_article_offering_group_id_offering_group_id_fk" FOREIGN KEY ("offering_group_id") REFERENCES "campus"."offering_group"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."offering_article" ADD CONSTRAINT "offering_article_offering_term_id_offering_term_id_fk" FOREIGN KEY ("offering_term_id") REFERENCES "campus"."offering_term"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."offering_article" ADD CONSTRAINT "offering_article_offering_scale_id_offering_scale_id_fk" FOREIGN KEY ("offering_scale_id") REFERENCES "campus"."offering_scale"("id") ON DELETE no action ON UPDATE no action;