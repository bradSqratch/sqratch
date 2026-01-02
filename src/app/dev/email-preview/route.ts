import { NextResponse } from "next/server";
import { buildWelcomeEmailHtml } from "@/helpers/emailTemplates";

export async function GET() {
  const html = buildWelcomeEmailHtml({
    name: "User",
    ctaUrl: "https://sqratch.com/dashboard",
  });

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html",
    },
  });
}
