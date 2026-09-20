CREATE TABLE "campus"."article" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" integer NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"published_version_id" uuid,
	"draft_version_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campus"."article_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campus"."program_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" integer NOT NULL,
	"title" text NOT NULL,
	"contents" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campus"."article" ADD CONSTRAINT "article_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."article" ADD CONSTRAINT "article_published_version_id_article_version_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "campus"."article_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."article" ADD CONSTRAINT "article_draft_version_id_article_version_id_fk" FOREIGN KEY ("draft_version_id") REFERENCES "campus"."article_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."article_version" ADD CONSTRAINT "article_version_article_id_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "campus"."article"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."article_version" ADD CONSTRAINT "article_version_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."program_unit" ADD CONSTRAINT "program_unit_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "article_subject_slug_idx" ON "campus"."article" USING btree ("subject_id","slug");--> statement-breakpoint
CREATE INDEX "article_version_article_created_idx" ON "campus"."article_version" USING btree ("article_id","created_at");--> statement-breakpoint
CREATE INDEX "program_unit_subject_position_idx" ON "campus"."program_unit" USING btree ("subject_id","position");