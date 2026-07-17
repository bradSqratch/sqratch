// src/helpers/mailer.ts
import nodemailer from "nodemailer";
import {
  buildApprovalEmailHtml,
  buildWelcomeEmailHtml,
  buildInviteEmailHtml,
} from "@/helpers/emailTemplates";

function createTransport() {
  const host = process.env.MAILTRAP_HOST;
  const port = Number(process.env.MAILTRAP_PORT || 2525);
  const user = process.env.MAILTRAP_USER;
  const pass = process.env.MAILTRAP_PASSWORD;

  if (!host || !user || !pass) {
    throw new Error("Mailtrap credentials are missing in env");
  }

  return nodemailer.createTransport({
    host,
    port,
    auth: { user, pass },
  });
}

const transporter = createTransport();

function getAppBaseUrl() {
  const domain = String(process.env.DOMAIN || "").trim();

  if (domain) {
    return domain.startsWith("http") ? domain : `https://${domain}`;
  }

  return "http://localhost:3000";
}

/**
 * Sends a 6-digit OTP verification email
 */
export async function sendVerificationEmail(email: string, otpCode: string) {
  const from = process.env.ADMIN_EMAIL;

  const mailOptions = {
    from,
    to: email,
    subject: "Your SQRATCH verification code",
    html: `
      <div style="font-family: Arial, sans-serif; color: #111; line-height: 1.6;">
        <h1 style="margin-bottom: 12px;">Verify Your Email</h1>
        <p style="margin: 0 0 16px;">
          Use the 6-digit code below to verify your email address:
        </p>

        <div
          style="
            display: inline-block;
            padding: 14px 22px;
            font-size: 28px;
            font-weight: 700;
            letter-spacing: 8px;
            background: #f3f4f6;
            border: 1px solid #d1d5db;
            border-radius: 10px;
            color: #111827;
            margin: 8px 0 20px;
          "
        >
          ${otpCode}
        </div>

        <p style="margin: 0 0 12px;">
          This code will expire in 10 minutes.
        </p>

        <p style="margin: 0; color: #4b5563;">
          If you did not request this, you can safely ignore this email.
        </p>
      </div>
    `,
    text: `Your SQRATCH verification code is: ${otpCode}\n\nThis code expires in 10 minutes.\n\nIf you did not request this, you can ignore this email.`,
  };

  return transporter.sendMail(mailOptions);
}

/**
 * Sends a invite email that contains the campaign invite URL.
 */
export async function sendInviteEmail(
  email: string,
  inviteUrl: string,
  campaignName: string,
  name?: string,
) {
  const from = process.env.ADMIN_EMAIL;
  const safeName = (name ?? "").trim() || "there";

  const html = buildInviteEmailHtml({
    name: safeName,
    campaignName,
    inviteUrl,
    heroImageUrl:
      "https://sqratch.com/assets/homepage/email_template_header.jpg",
  });

  const text =
    `You're invited to join ${campaignName} on SQRATCH.\n\n` +
    `Join here: ${inviteUrl}\n\n` +
    `If you didn’t request this, ignore this email.\n`;

  return transporter.sendMail({
    from,
    to: email,
    subject: `You're invited to join ${campaignName}!`,
    html,
    text,
  });
}

export async function sendWelcomeEmail({
  email,
  name,
}: {
  email: string;
  name?: string | null;
}) {
  const from = process.env.ADMIN_EMAIL;

  const safeName = name && name.trim() ? name.trim() : "there";
  const ctaUrl = `${getAppBaseUrl().replace(/\/+$/, "")}/login`;

  const html = buildWelcomeEmailHtml({
    name: safeName,
    ctaUrl,
  });
  const mailOptions = {
    from,
    to: email,
    subject: "Welcome to SQRATCH!",
    html,
    text:
      `Welcome to SQRATCH!\n\n` +
      `Hi ${safeName},\n\n` +
      "Welcome to SQRATCH. Explore experiences unlocked through participating campaigns, learn from creators, join conversations, ask questions, collect points, and discover rewards connected to the brands and communities you engage with.\n\n" +
      `Log in to SQRATCH: ${ctaUrl}\n\n` +
      "If you did not create a SQRATCH account, you can safely ignore this email.\n",
  };

  return transporter.sendMail(mailOptions);
}

export async function sendApprovalEmail(
  email: string,
  accountType: "creator" | "brand",
  name?: string,
) {
  const from = process.env.ADMIN_EMAIL;
  const safeName = name && name.trim() ? name.trim() : "there";
  const loginUrl = `${getAppBaseUrl().replace(/\/+$/, "")}/login`;
  const accountTypeLabel =
    accountType === "creator" ? "creator" : "brand administrator";

  const html = buildApprovalEmailHtml({
    name: safeName,
    accountTypeLabel,
    loginUrl,
  });

  const text =
    `Hello ${safeName},\n\n` +
    `Your SQRATCH ${accountTypeLabel} account request has been approved.\n` +
    `You can now log in here: ${loginUrl}\n\n` +
    `If you did not request access to SQRATCH, you can safely ignore this email.\n`;

  return transporter.sendMail({
    from,
    to: email,
    subject: "Your SQRATCH account has been approved",
    html,
    text,
  });
}
