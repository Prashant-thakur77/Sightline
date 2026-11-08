ALTER TABLE "reservations" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "expires_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "committed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "release_reason" text;--> statement-breakpoint
CREATE INDEX "reservations_user_idx" ON "reservations" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_key_unique" UNIQUE("key");