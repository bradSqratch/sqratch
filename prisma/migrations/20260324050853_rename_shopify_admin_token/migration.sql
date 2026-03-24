/*
  Warnings:

  - You are about to drop the column `shopifyStorefrontAccessTokenEncrypted` on the `Brand` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Brand"
RENAME COLUMN "shopifyStorefrontAccessTokenEncrypted"
TO "shopifyAdminAccessTokenEncrypted";

