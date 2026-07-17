import { NextResponse } from "next/server";
import { buildWelcomeEmailHtml } from "@/helpers/emailTemplates";

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }
  const html = buildWelcomeEmailHtml({
    name: "User",
    ctaUrl: new URL("/login", request.url).toString(),
  });

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html",
    },
  });
}
