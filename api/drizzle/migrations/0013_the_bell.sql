CREATE TABLE "campus"."notification_read" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"target" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campus"."offering_article" ADD COLUMN "notify" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campus"."notification_read" ADD CONSTRAINT "notification_read_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_read_user_kind_target_idx" ON "campus"."notification_read" USING btree ("user_id","kind","target");