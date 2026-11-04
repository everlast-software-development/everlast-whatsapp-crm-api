-- CreateTable
CREATE TABLE "ChatView" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "visits" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ChatView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatView_conversationId_userId_key" ON "ChatView"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "ChatView_conversationId_lastSeenAt_idx" ON "ChatView"("conversationId", "lastSeenAt");

-- AddForeignKey
ALTER TABLE "ChatView" ADD CONSTRAINT "ChatView_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatView" ADD CONSTRAINT "ChatView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
