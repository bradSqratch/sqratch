// src/helpers/mailer.ts
import nodemailer from "nodemailer";

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
 * Sends a simple invite email that contains the campaign invite URL.
 * Used in the "default" (non-BetterMode) branch after email verification.
 */
export async function sendInviteEmail(
  email: string,
  inviteUrl: string,
  campaignName: string
) {
  const from = process.env.ADMIN_EMAIL;

  const mailOptions = {
    from,
    to: email,
    subject: `You're invited to join ${campaignName}!`,
    html: `
      <h1>Welcome to ${campaignName}!</h1>
      <p>Click the button below to join this exciting new exclusive community!</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="start">
        <tr>
          <td align="start" bgcolor="#3E93DE" style="border-radius:8px;">
            <a href="${inviteUrl}"
              target="_blank"
              style="display:inline-block; padding:12px 24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
                    font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:8px;">
              Join ${campaignName}
            </a>
          </td>
        </tr>
      </table>
    `,
  };

  return transporter.sendMail(mailOptions);
}

export async function sendWelcomeEmail(email: string, name?: string) {
  const from = process.env.ADMIN_EMAIL;

  const safeName = name && name.trim() ? name.trim() : "there";

  const mailOptions = {
    from,
    to: email,
    subject: "Welcome to SQRATCH!",
    html: `
      <h1>Welcome to SQRATCH!</h1>
      <p>Hi ${safeName} — thanks for joining SQRATCH.</p>
      <p>You're all set.</p>
    `,
  };

  return transporter.sendMail(mailOptions);
}
