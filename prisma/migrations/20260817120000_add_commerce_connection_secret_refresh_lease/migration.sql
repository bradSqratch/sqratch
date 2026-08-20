-- Phase 14: invert Shopify credential authority to CommerceConnectionSecret.
--
-- ADDITIVE ONLY. This migration adds exactly two nullable columns and drops,
-- deletes, renames, and rewrites nothing. It does not touch Brand, clicks,
-- orders, line items, order events, products, rewards, points, QR codes,
-- campaigns, or attribution history. No id is recreated. No token plaintext
-- is read, written, or logged anywhere in this file.
--
-- WHY FIRST-CLASS COLUMNS AND NOT FIELDS INSIDE encryptedPayload
-- --------------------------------------------------------------
-- The refresh lease is a compare-and-swap: exactly one caller may win the
-- right to rotate a credential, and a superseded caller must be unable to
-- overwrite the winner's rotated token. That requires an atomic
--     UPDATE ... WHERE "refreshLockId" = $held
-- predicate evaluated by Postgres itself.
--
-- `encryptedPayload` cannot carry that state: src/lib/crypto.ts encrypts with
-- AES-256-GCM using a fresh random IV per call, so the same plaintext produces
-- a different ciphertext every time. There is no value to compare against in a
-- WHERE clause, and emulating it as decrypt -> compare -> re-encrypt is a
-- read-modify-write race — the precise failure the lease exists to prevent.
--
-- These two columns are the canonical replacement for the legacy
-- Brand.shopifyTokenRefreshLockId / Brand.shopifyTokenRefreshLockedUntil pair.
-- They are provider-NEUTRAL: any provider needing serialized credential
-- rotation uses them; a provider that does not simply leaves them NULL.
--
-- NULL semantics (identical to the legacy Brand columns they replace):
--   refreshLockId      NULL -> no lease is held.
--   refreshLockedUntil NULL or in the past -> the lease is free to acquire,
--                      which is what makes a crashed holder's lease
--                      self-healing rather than a permanent deadlock.
--
-- Backfill: none required, and none is performed. NULL is already the correct
-- "no lease held" starting state for every existing row, so this migration is
-- safe to apply while the application is running and safe to re-run.

ALTER TABLE "CommerceConnectionSecret"
  ADD COLUMN IF NOT EXISTS "refreshLockId" TEXT,
  ADD COLUMN IF NOT EXISTS "refreshLockedUntil" TIMESTAMP(3);
