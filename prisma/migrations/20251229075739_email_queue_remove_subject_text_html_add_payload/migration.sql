/*
  Warnings:

  - You are about to drop the column `html` on the `EmailQueue` table. All the data in the column will be lost.
  - You are about to drop the column `subject` on the `EmailQueue` table. All the data in the column will be lost.
  - You are about to drop the column `text` on the `EmailQueue` table. All the data in the column will be lost.
  - Changed the type of `template` on the `EmailQueue` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "EmailTemplate" AS ENUM ('WELCOME');

-- AlterTable
ALTER TABLE "EmailQueue" DROP COLUMN "html",
DROP COLUMN "subject",
DROP COLUMN "text",
DROP COLUMN "template",
ADD COLUMN     "template" "EmailTemplate" NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "EmailQueue_userId_template_key" ON "EmailQueue"("userId", "template");
