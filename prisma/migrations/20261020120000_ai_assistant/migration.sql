-- pgvector for the knowledge base search.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "KnowledgeStatus" AS ENUM ('DRAFT', 'APPROVED', 'ARCHIVED');

CREATE TABLE "KnowledgeArticle" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "sections" JSONB NOT NULL DEFAULT '{}',
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" INTEGER,
    "approvedAt" TIMESTAMP(3),
    "createdById" INTEGER,
    "updatedById" INTEGER,
    "embeddedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KnowledgeArticle_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KnowledgeArticle_status_idx" ON "KnowledgeArticle"("status");

CREATE TABLE "KnowledgeChunk" (
    "id" SERIAL NOT NULL,
    "articleId" INTEGER NOT NULL,
    "section" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KnowledgeChunk_articleId_idx" ON "KnowledgeChunk"("articleId");
CREATE INDEX "KnowledgeChunk_embedding_idx" ON "KnowledgeChunk" USING hnsw ("embedding" vector_cosine_ops);
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KnowledgeArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AiReply" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "whatsappNumberId" INTEGER NOT NULL,
    "inboundMessageId" INTEGER,
    "replyMessageId" INTEGER,
    "model" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "chunkIds" INTEGER[],
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiReply_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiReply_conversationId_createdAt_idx" ON "AiReply"("conversationId", "createdAt");
CREATE INDEX "AiReply_createdAt_idx" ON "AiReply"("createdAt");
