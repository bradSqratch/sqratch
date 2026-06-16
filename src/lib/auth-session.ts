/**
 * auth-session.ts
 *
 * Centralised helpers for resolving the NextAuth server session and the brand-
 * admin context inside API route handlers.
 *
 * Dependency injection model
 * --------------------------
 * Production route handlers depend on the real NextAuth / brand-auth helpers.
 * Tests that exercise a handler supply their own implementations by passing an
 * {@link AuthResolvers} object directly into the handler's implementation
 * function (see the `*Impl` exports on the route modules).  There are NO global
 * test hooks, no module mutation, and no `NODE_ENV` auth bypasses — the only way
 * to substitute the resolvers is to pass them explicitly as a typed argument.
 *
 * Routes that do not need test injection may call the standalone
 * {@link resolveSession} / {@link resolveBrandAdminContext} wrappers, which
 * always use the real implementation.
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

/**
 * Typed dependency object injected into route handler implementations.
 *
 * Production code uses {@link realAuthResolvers}; tests pass an object with the
 * same shape whose methods return canned sessions / brand contexts.
 */
export interface AuthResolvers {
  resolveSession: () => Promise<CustomSession | null>;
  resolveBrandAdminContext: () => Promise<BrandAdminContext | null>;
}

/**
 * The real, production resolvers backed by NextAuth and the brand-auth helper.
 */
export const realAuthResolvers: AuthResolvers = {
  resolveSession: async () =>
    (await getServerSession(authOptions)) as CustomSession | null,
  resolveBrandAdminContext: () => getBrandAdminContext(),
};

/**
 * Resolves the current user session using the real NextAuth stack.
 *
 * Returns `null` when there is no authenticated user.
 */
export async function resolveSession(): Promise<CustomSession | null> {
  return realAuthResolvers.resolveSession();
}

/**
 * Resolves the brand-admin context for the current request using the real
 * brand-auth helper.
 *
 * Returns `null` when the caller is not a brand admin or has no associated
 * brand membership.
 */
export async function resolveBrandAdminContext(): Promise<BrandAdminContext | null> {
  return realAuthResolvers.resolveBrandAdminContext();
}
