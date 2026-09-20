CREATE TABLE "campus"."official_grade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" integer NOT NULL,
	"offering_term_id" uuid NOT NULL,
	"value" numeric(4, 2) NOT NULL,
	"observation" text,
	"suggestion" text,
	"recorded_by" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campus"."official_grade" ADD CONSTRAINT "official_grade_student_id_user_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."official_grade" ADD CONSTRAINT "official_grade_offering_term_id_offering_term_id_fk" FOREIGN KEY ("offering_term_id") REFERENCES "campus"."offering_term"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus"."official_grade" ADD CONSTRAINT "official_grade_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "official_grade_term_student_idx" ON "campus"."official_grade" USING btree ("offering_term_id","student_id");