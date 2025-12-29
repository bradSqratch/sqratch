// supabase/functions/sendInviteEmail/index.ts
/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std/http/server.ts";
import nodemailer from "npm:nodemailer";

// Simple secret check so only our DB job can call this function
function requireCronSecret(req: Request) {
  const header = req.headers.get("x-cron-secret");
  const expected = Deno.env.get("CRON_SECRET");
  const isValid = header && expected && header === expected;
  console.log("🔐 Checking x-cron-secret:", {
    received: header,
    expected,
    isValid,
  });
  return isValid;
}

serve(async (req: Request): Promise<Response> => {
  console.log("Caller headers:", {
    ua: req.headers.get("user-agent"),
    referer: req.headers.get("referer"),
    xff: req.headers.get("x-forwarded-for"),
    supabase: req.headers.get("x-supabase-signature"),
  });
  try {
    console.log("📩 sendInviteEmail triggered:", new Date().toISOString());
    // console.log("📥 Headers:", Object.fromEntries(req.headers));

    if (!requireCronSecret(req)) {
      console.error("❌ Unauthorized: Invalid or missing x-cron-secret");
      return new Response("Unauthorized", { status: 401 });
    }

    const { email, id, subject, text, html } = await req.json();
    console.log("📧 Email payload:", { email, id, subject });

    // Create Mailtrap transporter
    const transporter = nodemailer.createTransport({
      host: Deno.env.get("MAILTRAP_HOST"),
      port: Number(Deno.env.get("MAILTRAP_PORT") || 2525),
      auth: {
        user: Deno.env.get("MAILTRAP_USER"),
        pass: Deno.env.get("MAILTRAP_PASSWORD"),
      },
    });

    await transporter.sendMail({
      from: Deno.env.get("ADMIN_EMAIL"),
      to: email,
      subject: subject ?? "Reminder from SQRATCH",
      text: text ?? `This is your scheduled email for record ${id}.`,
      html:
        html ??
        `<p>This is your scheduled email for record <strong>${id}</strong>.</p>`,
    });

    console.log("✅ Email successfully sent to:", email);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("💥 sendInviteEmail error:", e);
    return new Response("Internal Error", { status: 500 });
  }
});
