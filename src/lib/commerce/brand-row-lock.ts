/**
 * src/lib/commerce/brand-row-lock.ts
 *
 * PHASE 20 (settings sync / one-active-Commerce7-store round) — the ONE
 * intentional, centralized PostgreSQL row-locking primitive for `Brand`,
 * mirroring `./connection-row-lock.ts`'s proven `CommerceConnection` lock.
 *
 * ===========================================================================
 * WHY A BRAND-LEVEL LOCK IS NEEDED AT ALL
 * ===========================================================================
 * The one-active-Commerce7-connection-per-Brand invariant (see
 * `./providers/commerce7-connection-lifecycle.ts` and
 * `./link-connection.ts`) must reject a SECOND Commerce7 tenant from
 * occupying a Brand's active slot while a first one already does. The
 * classic unsafe implementation is "check for a conflicting connection, then
 * create/activate mine" — a check-then-act race. `lockCommerceConnectionForTransaction`
 * cannot close this race: it locks ONE EXISTING `CommerceConnection` row, but
 * the very case this invariant must prevent is two DIFFERENT, not-yet-active
 * tenants (X, Y) racing to become a Brand's FIRST active Commerce7
 * connection — neither has an existing active row to lock, and a brand-new
 * tenant's row may not exist yet at all (link creates it). The only row that
 * reliably exists before, during, and after every one of these actions
 * (link/disconnect/reconnect) is the `Brand` row itself, so it is the
 * natural, always-present serialization point.
 *
 * ===========================================================================
 * WHY `updatedAt`, AND THE AUDIT THAT MAKES IT SAFE
 * ===========================================================================
 * Exactly as `./connection-row-lock.ts` documents for `CommerceConnection`:
 * `tx.brand.update({ where: { id }, data: {} })` compiles to a SELECT-only
 * no-op (empirically proven that round), while `data: { updatedAt: new
 * Date() }` compiles to a genuine SQL `UPDATE`, which Postgres holds as a
 * row-level lock for the remainder of the transaction.
 *
 * A full grep audit of every `Brand.updatedAt` consumer in `src/` (this
 * round) found exactly ONE: `src/app/api/admin/brands/route.ts` uses it as
 * an `orderBy` SORT KEY ONLY for the internal admin brand list — it is never
 * selected/returned as a value, never displayed, never compared, and never
 * gates any decision anywhere. This is materially different from — and far
 * lower risk than — the prior `CommerceConnection.updatedAt` precedent
 * (Phase 19), where the SAME field was used as a self-referential
 * "did-config-change" fingerprint and a normal write would falsely
 * self-invalidate. Here, the only observable effect of this lock's
 * intentional touch is that a Brand may reorder slightly higher in an
 * internal admin-only list after a Commerce7 link/disconnect/reconnect —
 * never an incorrect value, never a security or authorization effect (that
 * gate is `Brand.isActive`, an entirely different field this lock never
 * touches), and never a public-facing consequence.
 *
 * `Brand.isActive`, `.bio`, `.websiteUrl`, `.logoUrl`, `.coverImageUrl`,
 * `.name`, and `.slug` were all considered and rejected as lock-touch
 * targets: `isActive` gates brand-wide access in `src/lib/brand-context.ts`
 * (far too load-bearing to risk); the rest are user-authored profile content
 * a concurrent legitimate edit could be clobbered by if this lock ever
 * wrote a stale re-read of them back. `updatedAt` is the only field that is
 * both genuinely inert and requires no read-before-write.
 *
 * ===========================================================================
 * WHY NOT RAW SQL / A SCHEMA CHANGE
 * ===========================================================================
 * Same constraints as `./connection-row-lock.ts`: no `$queryRaw`/
 * `$executeRaw`/`Prisma.sql` anywhere in `src/` (enforced by
 * `tests/commerce-click-attribution.test.ts`), so `SELECT ... FOR UPDATE` /
 * `pg_advisory_xact_lock` are unavailable without raw SQL. A dedicated
 * lease/lock column on `Brand` would require a schema migration, which this
 * round's brief explicitly forbids absent a truly unavoidable blocker — and
 * this intentional `updatedAt` write makes one unnecessary.
 *
 * ===========================================================================
 * USAGE CONTRACT
 * ===========================================================================
 * MUST be called with an already-open transaction client. MUST be the FIRST
 * write inside that transaction (see the "Brand -> CommerceConnection" lock
 * order documented in `./providers/commerce7-connection-lifecycle.ts` and
 * `./link-connection.ts` — never the reverse, to avoid deadlock). MUST NEVER
 * be held across provider HTTP — every caller locks, does its short
 * critical-section work, and commits, all before any Commerce7 network call.
 */

import type { Prisma } from "@prisma/client";

export type BrandLockClient = {
  brand: {
    update(args: {
      where: { id: string };
      data: { updatedAt: Date };
    }): Promise<{ id: string; updatedAt: Date }>;
  };
};

/**
 * Acquires a real PostgreSQL row-level lock on the exact `Brand` row, held
 * until the enclosing transaction commits or rolls back. See this file's
 * header for the full justification. Returns the new `updatedAt` value only
 * for observability/testing — callers must not treat it as meaningful
 * business data.
 */
export async function lockBrandForTransaction(
  tx: BrandLockClient | Prisma.TransactionClient,
  brandId: string,
): Promise<{ id: string; updatedAt: Date }> {
  return (tx as BrandLockClient).brand.update({
    where: { id: brandId },
    data: { updatedAt: new Date() },
  });
}
