CREATE TABLE "store_agent_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"trigger_ref" text NOT NULL,
	"round" integer NOT NULL,
	"status" text NOT NULL,
	"option_id" text,
	"resolution" text,
	"percent" integer,
	"amount_cents" integer,
	"title" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"staff_note" text,
	"source" text,
	"model" text,
	"auto" boolean DEFAULT false NOT NULL,
	"staff_why" text,
	"check_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy" jsonb,
	"result" text,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "store_policies" (
	"scope_id" text PRIMARY KEY NOT NULL,
	"agent_on" boolean DEFAULT true NOT NULL,
	"auto_send" boolean DEFAULT true NOT NULL,
	"auto_replace_max_cents" integer DEFAULT 6000 NOT NULL,
	"ask_staff_above_cents" integer DEFAULT 10000 NOT NULL,
	"partial_refunds" text DEFAULT 'up_to_20' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "store_agent_proposals" ADD CONSTRAINT "store_agent_proposals_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_agent_proposals_trigger_idx" ON "store_agent_proposals" USING btree ("case_id","trigger_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "store_agent_proposals_round_idx" ON "store_agent_proposals" USING btree ("case_id","round") WHERE "store_agent_proposals"."round" > 0 and "store_agent_proposals"."status" <> 'failed';