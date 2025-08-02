import { NextRequest, NextResponse } from "next/server";
export { default } from "next-auth/middleware";
import { getToken } from "next-auth/jwt";

export async function middleware(request: NextRequest) {
  const url = request.nextUrl;
  console.log("Middleware invoked for:", url.pathname);
  // Handle language cookie first
  const localeCookie = request.cookies.get("NEXT_LOCALE");

  const token = await getToken({ req: request }).catch(() => null);

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

  // Redirect logged-in users away from login or signup pages
  if (
    token &&
    (url.pathname.startsWith("/login") ||
      // url.pathname.startsWith("/sign-up") ||
      url.pathname.startsWith("/verify-email"))
  ) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // Redirect unauthenticated users trying to access protected routes
  if (
    !token &&
    (url.pathname.startsWith("/admin") ||
      url.pathname.startsWith("/dashboard") ||
      url.pathname.startsWith("/generateQR") ||
      url.pathname.startsWith("/control-panel") ||
      url.pathname.startsWith("/view-all-songs") ||
      url.pathname.startsWith("/user-management") ||
      url.pathname.startsWith("/qr-management"))
  ) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Allow access to public pages (e.g., home, about, signup)
  return NextResponse.next();
}
// See "Matching Paths" below to learn more
export const config = {
  matcher: [
    "/qr-scanner",
    "/login",
    "/signup",
    "/(admin|dashboard|generateQR|control-panel|view-all-songs|user-management|qr-management)(/:path*)?",
  ],
};
