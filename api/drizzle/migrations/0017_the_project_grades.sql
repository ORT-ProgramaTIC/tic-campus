CREATE TABLE "campus"."project_grade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_home_id" uuid NOT NULL,
	"student_id" integer NOT NULL,
	"value" text NOT NULL,
	"visible" boolean DEFAULT false NOT NULL,
	"recorded_by" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campus"."project_grade" ADD CONSTRAINT "project_grade_offering_home_id_offering_home_id_fk" FOREIGN KEY ("offering_home_id") REFERENCES "campus"."offering_home"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."project_grade" ADD CONSTRAINT "project_grade_student_id_user_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."project_grade" ADD CONSTRAINT "project_grade_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_grade_home_student_idx" ON "campus"."project_grade" USING btree ("offering_home_id","student_id","recorded_at" DESC NULLS LAST);