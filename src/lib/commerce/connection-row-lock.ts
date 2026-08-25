/**
 * src/lib/commerce/connection-row-lock.ts
 *
 * PHASE 19 REPAIR (P1-1/P1-2, real-lock round) — the ONE intentional,
 * centralized PostgreSQL row-locking primitive for `CommerceConnection`.
 *
 * ===========================================================================
 * WHY THIS EXISTS: THE PRIOR "LOCK" DID NOT LOCK ANYTHING
 * ===========================================================================
 * An earlier round used `tx.commerceConnection.update({ where: { id },
 * data: {} })` as a lock primitive, reasoning that Prisma would compile any
 * `update()` call to a real SQL `UPDATE`, which Postgres would then hold a
 * row-level lock for. This was WRONG and was proven wrong empirically
 * against Prisma 7.8.0 + PostgreSQL 17 (see the scratchpad probe run this
 * round): given an EMPTY `data: {}`, Prisma's query planner recognizes there
 * is nothing to write and silently downgrades the operation to a single
 * read:
 *
 *   SELECT "id" FROM "CommerceConnection" WHERE ("id" = $1 AND 1=1)
 *   LIMIT $2 OFFSET $3
 *
 * No `UPDATE` statement is ever emitted. No row-level write lock is ever
 * taken. A concurrent transaction attempting the SAME "lock" call proceeds
 * immediately without waiting — the two "locked" critical sections were
 * never actually serialized. This was confirmed both by inspecting the
 * emitted SQL (via Prisma's query-event log) and by a real blocking-behavior
 * test against disposable local PostgreSQL (see
 * `tests/commerce-connection-lock.test.ts`).
 *
 * ===========================================================================
 * THE FIX: AN INTENTIONAL, REAL `updatedAt` WRITE
 * ===========================================================================
 * `data: { updatedAt: new Date() }` forces Prisma to emit a genuine SQL
 * `UPDATE "CommerceConnection" SET "updatedAt" = $1 WHERE (...)`, verified by
 * the SAME probe. A real Postgres `UPDATE` statement takes a row-level
 * exclusive lock on the touched row for the remainder of the transaction —
 * a second transaction's own locking `UPDATE` against the SAME row
 * genuinely blocks (in Postgres terms, waits on the first transaction's row
 * lock) until the first commits or rolls back. This is the actual
 * serialization primitive `claimProductSyncRun` and the per-write
 * config-freshness fence need — proven with a real blocking test, not
 * assumed.
 *
 * `updatedAt` was chosen deliberately, after auditing every consumer in this
 * codebase (grep across `src/`): `CommerceConnection.updatedAt` is NEVER
 * read by any business logic, is not part of any index
 * (`prisma/schema.prisma`'s `CommerceConnection` model has no `@@index`
 * touching it), and is never selected/displayed by any API route or UI
 * component — every "updatedAt" reference elsewhere in this codebase
 * belongs to a DIFFERENT model (`CommerceOrder.updatedAt`, Shopify/Commerce7
 * order-API `updatedAt` filter params, etc.), never this one. The
 * config-only product fingerprint
 * (`./product-config-fingerprint.ts`) ALREADY deliberately excludes it —
 * see that module's own header for why (a normal successful product sync
 * writes `CommerceConnection.lastProductSyncAt`, which bumps `updatedAt` via
 * Prisma's `@updatedAt`, and using `updatedAt` as a "did config change"
 * signal previously caused every successful sync to self-invalidate). This
 * lock helper's intentional `updatedAt` write composes safely with that
 * exclusion: bumping `updatedAt` here can never make the fingerprint (or
 * anything else) observe a false "configuration changed."
 *
 * ===========================================================================
 * WHY NOT RAW SQL / `SELECT ... FOR UPDATE`
 * ===========================================================================
 * This codebase enforces, via a dedicated source-level lock test
 * (`tests/commerce-click-attribution.test.ts`), that `$queryRaw` /
 * `$executeRaw` / `Prisma.sql` never appear anywhere in `src/`. Prisma has
 * no ORM-level `.lock()` / `SELECT ... FOR UPDATE` API. An intentional,
 * real `update()` call is therefore the only no-raw-SQL, no-schema-change
 * mechanism available — and, per the analysis above, is genuinely safe for
 * this specific column.
 *
 * ===========================================================================
 * USAGE CONTRACT
 * ===========================================================================
 * MUST be called with an already-open transaction client (never the
 * module-level `prisma` singleton — locking requires participating in a
 * live transaction). MUST be the FIRST write inside that transaction, before
 * any read whose result must reflect a serialized, lock-protected view.
 * MUST NEVER be held across provider HTTP — every caller in this codebase
 * opens the transaction, calls this, does its short critical-section work,
 * and commits, all before any network call begins.
 */

import type { Prisma } from "@prisma/client";

/**
 * Minimal structural shape this helper needs — deliberately not
 * `Prisma.TransactionClient` itself, so it can also accept the narrower
 * per-module transaction-client wrappers already used elsewhere in this
 * codebase (e.g. `Commerce7ConfigTransactionClient`) without a type-only
 * dependency cycle.
 */
export type ConnectionLockClient = {
  commerceConnection: {
    update(args: {
      where: { id: string };
      data: { updatedAt: Date };
    }): Promise<{ id: string; updatedAt: Date }>;
  };
};

/**
 * Acquires a real PostgreSQL row-level lock on the exact `CommerceConnection`
 * row, held until the enclosing transaction commits or rolls back. See this
 * file's header for the full justification and empirical proof. Returns the
 * new `updatedAt` value only for observability/testing — callers must not
 * treat it as meaningful business data.
 */
export async function lockCommerceConnectionForTransaction(
  tx: ConnectionLockClient | Prisma.TransactionClient,
  connectionId: string,
): Promise<{ id: string; updatedAt: Date }> {
  return (tx as ConnectionLockClient).commerceConnection.update({
    where: { id: connectionId },
    data: { updatedAt: new Date() },
  });
}
