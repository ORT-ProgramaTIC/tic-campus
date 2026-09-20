CREATE TABLE "campus"."login_flow" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"verifier" text NOT NULL,
	"next" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campus"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"claims" jsonb NOT NULL,
	"refresh_token" text,
	"claims_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"retry_after" timestamp with time zone,
	"csrf" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campus"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;