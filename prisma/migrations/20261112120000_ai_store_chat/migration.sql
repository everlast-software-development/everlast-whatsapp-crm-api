-- The store's AI answering WhatsApp chats (utils/aiAssistant.js).
-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "aiActiveAt" TIMESTAMP(3),
ADD COLUMN     "aiHandedOffAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AiReply" ADD COLUMN     "externalConversationId" INTEGER;

