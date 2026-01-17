import { NextRequest, NextResponse } from "next/server";
// export { default } from "next-auth/middleware";
import { getToken } from "next-auth/jwt";

export async function middleware(request: NextRequest) {
  const url = request.nextUrl;
  console.log("Middleware invoked for:", url.pathname);
  const token = await getToken({ req: request }).catch(() => null);

  // Redirect /signup to /login
  // if (url.pathname === "/signup") {
  //   return NextResponse.redirect(new URL("/login", request.url));
  // }

  // Allow access to the scanner route for everyone (no redirects)
  // if (url.pathname.startsWith("/qr-scanner")) {
  //   return NextResponse.next();
  // }

  // Redirect temporary users away from all pages except allowed ones
  // if (
  //   token &&
  //   token.isTemporary &&
  //   !(
  //     url.pathname.startsWith("/my-scanned-qrs") ||
  //     url.pathname.startsWith("/victim-information") ||
  //     url.pathname.startsWith("/qr-scanner")
  //   )
  // ) {
  //   return NextResponse.redirect(new URL("/my-scanned-qrs", request.url));
  // }

  const isAuthPage =
    url.pathname.startsWith("/login") ||
    url.pathname.startsWith("/signup") ||
    url.pathname.startsWith("/verify-email");

  const isAdminRoute = url.pathname.startsWith("/admin");
  const isProtectedRoute =
    isAdminRoute ||
    url.pathname.startsWith("/dashboard") ||
    url.pathname.startsWith("/generateQR") ||
    url.pathname.startsWith("/control-panel") ||
    url.pathname.startsWith("/view-all-songs") ||
    url.pathname.startsWith("/user-management") ||
    url.pathname.startsWith("/qr-management");

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
    const role = (token as any).role; // must exist in token (see section 2)
    if (role !== "ADMIN") {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
  }

  // Allow access to public pages (e.g., home, about, signup)
  return NextResponse.next();
}
// See "Matching Paths" below to learn more
export const config = {
  matcher: [
    "/login",
    "/signup",
    "/sign-up",
    "/verify-email",
    "/admin/:path*",
    "/dashboard/:path*",
    "/generateQR/:path*",
    "/control-panel/:path*",
    "/view-all-songs/:path*",
    "/user-management/:path*",
    "/qr-management/:path*",
  ],
};
