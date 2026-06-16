/**
 * auth-session.ts
 *
 * Centralised helpers for resolving the NextAuth server session and the brand-
 * admin context inside API route handlers.
 *
 * In production these simply call the real NextAuth / brand-auth helpers.
 *
 * During tests, the `node:test` suite may set `globalThis.__mockGetServerSession`
 * and / or `globalThis.__mockGetBrandAdminContext` before invoking a route.  By
 * concentrating those reads here we keep every route file free of test-only
 * branching while still allowing lightweight integration tests that do not need
 * a live NextAuth stack.
 *
 * NOTE: The globalThis hooks are intentionally confined to this single file.
 *       Do NOT add them anywhere else in production source.
 */

import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { getBrandAdminContext, BrandAdminContext } from "@/lib/brand-auth";

export type { BrandAdminContext };

/** Minimal session shape expected by the app's route handlers. */
export interface CustomSession {
  user: {
    id: string;
    role: string;
    email?: string | null;
  };
}

// ---- internal types used only for the test-hook slot ----------------------

type SessionResolver = (options: unknown) => Promise<CustomSession | null>;
type BrandCtxResolver = () => Promise<BrandAdminContext | null>;

interface TestHooks {
  __mockGetServerSession?: SessionResolver;
  __mockGetBrandAdminContext?: BrandCtxResolver;
}

// ---------------------------------------------------------------------------

/**
 * Resolves the current user session.
 *
 * Returns `null` when there is no authenticated user.
 */
export async function resolveSession(): Promise<CustomSession | null> {
  const g = globalThis as unknown as TestHooks;
  if (typeof g.__mockGetServerSession === "function") {
    return g.__mockGetServerSession(authOptions);
  }
  return (await getServerSession(authOptions)) as CustomSession | null;
}

/**
 * Resolves the brand-admin context for the current request.
 *
 * Returns `null` when the caller is not a brand admin or has no associated
 * brand membership.
 */
export async function resolveBrandAdminContext(): Promise<BrandAdminContext | null> {
  const g = globalThis as unknown as TestHooks;
  if (typeof g.__mockGetBrandAdminContext === "function") {
    return g.__mockGetBrandAdminContext();
  }
  return getBrandAdminContext();
}
