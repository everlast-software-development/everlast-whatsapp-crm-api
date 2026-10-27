-- CreateTable
CREATE TABLE "ErrorLog" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "code" TEXT,
    "message" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "details" JSONB,
    "conversationId" INTEGER,
    "campaignId" INTEGER,
    "flowRunId" INTEGER,
    "whatsappNumberId" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" INTEGER,

    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErrorLog_lastSeenAt_idx" ON "ErrorLog"("lastSeenAt");

-- CreateIndex
CREATE INDEX "ErrorLog_fingerprint_resolvedAt_idx" ON "ErrorLog"("fingerprint", "resolvedAt");

-- CreateIndex
CREATE INDEX "ErrorLog_source_lastSeenAt_idx" ON "ErrorLog"("source", "lastSeenAt");
