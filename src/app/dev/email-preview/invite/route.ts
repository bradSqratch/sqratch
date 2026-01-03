import { NextResponse } from "next/server";
import { buildInviteEmailHtml } from "@/helpers/emailTemplates";

export async function GET(req: Request) {
  const url = new URL(req.url);

  const name = url.searchParams.get("name") ?? "there";
  const campaignName = url.searchParams.get("campaignName") ?? "Demo Campaign";
  const inviteUrl =
    url.searchParams.get("inviteUrl") ?? "https://sqratch.com/invite/demo123";

  const html = buildInviteEmailHtml({
    name,
    campaignName,
    inviteUrl,
    // optional override
    heroImageUrl:
      "https://sqratch.com/assets/homepage/email_template_header.jpg",
  });

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // helpful to avoid caching while iterating
      "Cache-Control": "no-store",
    },
  });
}
