-- Messages the online store sends first, and the website templates they're sent with (see schema.prisma).
-- CreateEnum
CREATE TYPE "StoreMessageStatus" AS ENUM ('CAPTURED', 'SENDING', 'SENT', 'FAILED', 'UNCONFIRMED');

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "websiteConfig" JSONB,
ADD COLUMN     "websiteEvent" VARCHAR(40);

-- CreateTable
CREATE TABLE "StoreMessage" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER,
    "kind" VARCHAR(40) NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "language" VARCHAR(5) NOT NULL,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "phone" VARCHAR(20) NOT NULL,
    "text" TEXT NOT NULL,
    "templateText" TEXT,
    "variables" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "StoreMessageStatus" NOT NULL,
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "templateId" INTEGER,
    "messageId" INTEGER,
    "conversationId" INTEGER,
    "whatsappMessageId" TEXT,
    "delivery" VARCHAR(20),
    "deliveryError" TEXT,
    "costAed" DECIMAL(10,4),
    "reportedAt" TIMESTAMP(3),
    "reportError" TEXT,
    "reportTries" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreMessage_storeId_key" ON "StoreMessage"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreMessage_messageId_key" ON "StoreMessage"("messageId");

-- CreateIndex
CREATE INDEX "StoreMessage_receivedAt_idx" ON "StoreMessage"("receivedAt");

-- CreateIndex
CREATE INDEX "StoreMessage_kind_language_idx" ON "StoreMessage"("kind", "language");

-- CreateIndex
CREATE INDEX "StoreMessage_delivery_reportedAt_idx" ON "StoreMessage"("delivery", "reportedAt");

-- AddForeignKey
ALTER TABLE "StoreMessage" ADD CONSTRAINT "StoreMessage_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

