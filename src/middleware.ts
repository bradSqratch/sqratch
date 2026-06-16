import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

export async function middleware(request: NextRequest) {
  const url = request.nextUrl;

  if (url.pathname.startsWith("/api/shopify/webhooks/")) {
    return NextResponse.next();
  }

  const rawToken = await getToken({ req: request }).catch(() => null);
  const token = rawToken?.accountInvalidated ? null : rawToken;

  const isAuthPage =
    url.pathname.startsWith("/login") ||
    url.pathname.startsWith("/signup") ||
    url.pathname.startsWith("/verify-email");

  const isAdminRoute = url.pathname.startsWith("/admin");
  const isProtectedRoute =
    isAdminRoute ||
    url.pathname.startsWith("/dashboard");

  // 1) If logged in, keep them out of auth pages
  if (token && isAuthPage) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // 2) If not logged in, block protected routes
  if (!token && isProtectedRoute) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // 3) If logged in but NOT admin, block /admin/*
  if (token && isAdminRoute) {
    const role = (token as { role?: string }).role; // must exist in token (see section 2)
    if (role !== "ADMIN") {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/login",
    "/signup",
    "/sign-up",
    "/verify-email",
    "/api/shopify/webhooks/:path*",
    "/admin/:path*",
    "/dashboard/:path*",
  ],
};
