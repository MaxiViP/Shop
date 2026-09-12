-- Give existing codes an identity without invalidating them. Resend rotates it.
ALTER TABLE "Otp" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX "Otp_id_key" ON "Otp"("id");
