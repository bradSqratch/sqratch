// src/helpers/mailer.ts
import nodemailer from "nodemailer";
import {
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

/**
 * Sends the verification email with a link to /verify-email
 */
export async function sendVerificationEmail(
  email: string,
  emailVerifyToken: string,
  qrCodeId?: string
) {
  const domain = process.env.DOMAIN;

  const verificationUrl = `${domain}/verify-email?token=${emailVerifyToken}${
    qrCodeId ? `&qrcodeID=${encodeURIComponent(qrCodeId)}` : ""
  }`;

  const from = process.env.ADMIN_EMAIL;

  const mailOptions = {
    from,
    to: email,
    subject: "Verify Your Email Address",
    html: `
      <h1>Welcome to SQRATCH!</h1>
      <p>Please click the link below to verify your email address:</p>
      <a href="${verificationUrl}" style="padding:10px 20px;color:#fff;background:#3b82f6;text-decoration:none;border-radius:6px;">
        Verify Email
      </a>
      <p>If you did not sign up, you can safely ignore this email.</p>
    `,
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
  name?: string
) {
  const from = process.env.ADMIN_EMAIL;

  const html = buildInviteEmailHtml({
    name,
    campaignName,
    inviteUrl,
    heroImageUrl: "https://sqratch.com/assets/homepage/home_bg.jpeg",
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

/**
 * Sends a welcome email to a new user with signup link 30 to 90 minutes from when he has redeemed a QR code.
 */
export async function sendWelcomeEmail(email: string, name?: string) {
  const from = process.env.ADMIN_EMAIL;

  const safeName = name && name.trim() ? name.trim() : "there";

  const html = buildWelcomeEmailHtml({
    name: safeName,
    ctaUrl: "https://sqratch.com/signup",
  });
  const mailOptions = {
    from,
    to: email,
    subject: "Welcome to SQRATCH!",
    html,
    text: `Welcome to SQRATCH!\n\nHi ${safeName},\nYou found a SQRATCH sticker. You scratched it. You scanned it. Now you're in. From here, you can keep collecting SQRATCH by scanning more stickers-each one adds to your balance and unlocks new drops, rewards, and access. The more you collect, the more your membership grows across participating brands and communities.\nComplete your setup: https://sqratch.com/signup\n`,
  };

  return transporter.sendMail(mailOptions);
}
