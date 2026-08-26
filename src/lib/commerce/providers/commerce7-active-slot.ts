/**
 * src/lib/commerce/providers/commerce7-active-slot.ts
 *
 * PHASE 20 (one-active-Commerce7-store round, Part 10) — the single,
 * shared, exhaustive predicate for "does this `CommerceConnectionStatus`
 * occupy a Brand's Commerce7 active slot." Used identically by
 * `../link-connection.ts` (link/re-link) and `./commerce7-connection-lifecycle.ts`
 * (disconnect/reconnect) so the invariant can never diverge between the two
 * call sites.
 *
 * DEFINITION (conservative by design): a Commerce7 connection occupies the
 * Brand's active slot UNLESS it is explicitly `DISCONNECTED` (a Brand Admin
 * chose to pause it — see `./commerce7-connection-lifecycle.ts`'s header for
 * why this is distinct from `UNINSTALLED`) or `UNINSTALLED` (Commerce7
 * itself reports the app is no longer on the tenant). Every OTHER status —
 * `CONNECTED` (obviously live), `PENDING` (an in-progress state that has not
 * yet been explicitly freed), `REQUIRES_RECONNECT` (was live and needs
 * credential/session repair, not a deliberate release), and `ERROR` (an
 * unexpected failure state, not a deliberate release) — is treated as
 * occupying the slot. This is intentionally the CONSERVATIVE reading:
 * `DISCONNECTED`/`UNINSTALLED` are the only two statuses this codebase ever
 * sets to mean "this Brand explicitly does not have a live Commerce7 store
 * here" (see `prisma/schema.prisma`'s `CommerceConnectionStatus` enum and
 * every place that sets it — the install/uninstall callbacks, and this
 * round's disconnect/reconnect actions). Any future status value added to
 * the enum defaults to OCCUPYING the slot (fail toward blocking a second
 * store, never toward silently permitting two live stores) unless a
 * reviewer explicitly adds it to the free-slot set below.
 */

import type { CommerceConnectionStatus } from "@prisma/client";

/**
 * Statuses that FREE the Brand's Commerce7 active slot. Every other status
 * occupies it. Exported as an array (not just the predicate below) so a
 * Prisma `where: { status: { notIn: COMMERCE7_FREE_SLOT_STATUSES } }` query
 * can derive its filter from this SAME single source of truth — never a
 * second, independently-typed literal that could silently drift from
 * `occupiesCommerce7ActiveSlot`.
 */
export const COMMERCE7_FREE_SLOT_STATUSES: readonly CommerceConnectionStatus[] = [
  "DISCONNECTED",
  "UNINSTALLED",
];

const FREE_SLOT_SET: ReadonlySet<CommerceConnectionStatus> = new Set(COMMERCE7_FREE_SLOT_STATUSES);

export function occupiesCommerce7ActiveSlot(status: CommerceConnectionStatus): boolean {
  return !FREE_SLOT_SET.has(status);
}
