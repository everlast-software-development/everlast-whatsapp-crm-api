-- Usernames were capped at 20 characters, which rejected email addresses.
ALTER TABLE "User" ALTER COLUMN "username" SET DATA TYPE VARCHAR(100);
