import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { normalizeInternalRedirectPath } from "@/lib/safe-redirect";

function isAuthPath(pathname: string) {
  return (
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/verify-email")
  );
}

function getAuthRedirectTarget(request: NextRequest) {
  const requestedTarget =
    request.nextUrl.searchParams.get("callbackUrl") ||
    request.nextUrl.searchParams.get("next");
  const target = normalizeInternalRedirectPath(requestedTarget);

  return isAuthPath(target) ? "/dashboard" : target;
}

export async function middleware(request: NextRequest) {
  const url = request.nextUrl;

  if (url.pathname.startsWith("/api/shopify/webhooks/")) {
    return NextResponse.next();
  }

  const rawToken = await getToken({ req: request }).catch(() => null);
  const token = rawToken?.accountInvalidated ? null : rawToken;

  const isAuthPage = isAuthPath(url.pathname);

  const isAdminRoute = url.pathname.startsWith("/admin");
  const isProtectedRoute =
    isAdminRoute ||
    url.pathname.startsWith("/dashboard") ||
    url.pathname.startsWith("/profile");

  // 1) If logged in, keep them out of auth pages
  if (token && isAuthPage) {
    return NextResponse.redirect(
      new URL(getAuthRedirectTarget(request), request.url),
    );
  }

  // 2) If not logged in, block protected routes
  if (!token && isProtectedRoute) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", `${url.pathname}${url.search}`);
    return NextResponse.redirect(loginUrl);
  }

  // 3) If logged in but NOT admin, block /admin/*
  if (token && isAdminRoute) {
    const role = (token as { role?: string }).role; // must exist in token (see section 2)
    if (role !== "ADMIN") {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
  }

  // Expose the requested pathname to server layouts (e.g. the Brand dashboard
  // layout needs to distinguish the Shopify install route to render its
  // access-denied messaging precisely) without each layout re-deriving it.
  const response = NextResponse.next();
  response.headers.set("x-pathname", url.pathname);
  return response;
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
    "/profile",
  ],
};
