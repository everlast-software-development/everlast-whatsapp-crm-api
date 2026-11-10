-- Who sent a message when no person did: "WEBSITE" for the online store's automatic messages.
ALTER TABLE "Message" ADD COLUMN "origin" VARCHAR(20);
UPDATE "Message" SET "origin" = 'WEBSITE' WHERE "id" IN (SELECT "messageId" FROM "StoreMessage" WHERE "messageId" IS NOT NULL);
