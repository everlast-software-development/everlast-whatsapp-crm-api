-- Sign-out everywhere on password change/reset.
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- Opt-outs that survive deleting the contact.
CREATE TABLE "OptOutSuppression" (
    "phone" TEXT NOT NULL,
    "global" BOOLEAN NOT NULL DEFAULT false,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptOutSuppression_pkey" PRIMARY KEY ("phone")
);
