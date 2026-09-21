CREATE TABLE "campus"."revision_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_article_id" uuid NOT NULL,
	"student_id" integer NOT NULL,
	"requested_by" integer NOT NULL,
	"reason" text NOT NULL,
	"bonus_tasks" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answer" text,
	"answered_at" timestamp with time zone,
	"answered_by" integer
);
--> statement-breakpoint
ALTER TABLE "campus"."revision_request" ADD CONSTRAINT "revision_request_offering_article_id_offering_article_id_fk" FOREIGN KEY ("offering_article_id") REFERENCES "campus"."offering_article"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."revision_request" ADD CONSTRAINT "revision_request_student_id_user_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."revision_request" ADD CONSTRAINT "revision_request_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."revision_request" ADD CONSTRAINT "revision_request_answered_by_user_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "revision_request_open_idx" ON "campus"."revision_request" USING btree ("offering_article_id","student_id") WHERE answered_at is null;--> statement-breakpoint
CREATE INDEX "revision_request_student_idx" ON "campus"."revision_request" USING btree ("student_id");