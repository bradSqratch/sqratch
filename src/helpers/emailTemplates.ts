// src/helpers/emailTemplates.ts
// ================= WELCOME EMAIL SECTION =================
type WelcomeTemplateParams = {
  name: string;
  ctaUrl: string;
};

export function buildWelcomeEmailHtml(params: WelcomeTemplateParams) {
  const { name, ctaUrl } = params;

  const year = new Date().getFullYear();

  return `<!doctype html>
    <html lang="en">
        <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width" />
            <meta name="x-apple-disable-message-reformatting" />
            <title>Welcome to SQRATCH</title>
        </head>
        <body style="margin:0; padding:0; background:#0b1020;">
            <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
                Welcome to SQRATCH — scratch, scan, and connect to real people.
            </div>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0b1020;">
                <tr>
                <td align="center" style="padding:28px 14px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560"
                    style="width:560px; background:#020121; border-radius:18px; overflow:hidden; box-shadow:0 18px 60px rgba(0,0,0,0.45); border:1px solid rgba(255,255,255,0.10);">
                    
                    <tr>
                        <td align="center" style="padding:26px 28px 10px 28px;">
                        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
                            <div style="font-size:22px; font-weight:800; letter-spacing:-0.5px; color:#ffffff;">
                            SQRATCH<span style="font-weight:700; opacity:0.65;">™</span>
                            </div>
                            <div style="margin-top:6px; font-size:12px; letter-spacing:0.9px; text-transform:uppercase; color:#7a8299;">
                            POWERED BY PEOPLE WHO SHOW UP
                            </div>
                        </div>
                        </td>
                    </tr>

                    <tr>
                        <td align="center" style="padding:14px 28px 0 28px;">
                        <img
                            src="https://sqratch.com/assets/homepage/email_template_header.jpg"
                            width="504"
                            height="280"
                            alt="SQRATCH"
                            style="display:block; width:504px; height:280px; object-fit:cover; border-radius:14px; border:1px solid rgba(11,16,32,0.10);"
                        />
                        </td>
                    </tr>

                    <tr>
                        <td align="center" style="padding:22px 28px 0 28px;">
                        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; color:#0b1020;">
                            <div style="font-size:28px; line-height:1.15; font-weight:800; color:#ffffff;">Your SQRATCH is waiting</div>
                            <div style="margin:12px auto 0; width:44px; height:3px; background:#ff4d8d; border-radius:999px;"></div>
                        </div>
                        </td>
                    </tr>

                    <tr>
                        <td align="center" style="padding:16px 28px 0 28px;">
                        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; color:#d6d9e6; font-size:15px; line-height:1.6; text-align:center;">
                            <div style="color:#ffffff; font-weight:700; font-size:16px; margin-bottom:6px;">
                            Hi ${escapeHtml(name)},
                            </div>
                            You found a SQRATCH sticker. You scratched it. You scanned it. Now you're in. From here, you can keep collecting SQRATCH by scanning more stickers-each one adds to your balance and unlocks new drops, rewards, and access. The more you collect, the more your membership grows across participating brands and communities.
                        </div>
                        </td>
                    </tr>

                    <tr>
                        <td align="center" style="padding:22px 28px 0 28px;">
                        <a
                            href="${escapeAttr(ctaUrl)}"
                            target="_blank"
                            rel="noreferrer"
                            style="display:inline-block; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; font-size:15px; font-weight:700; color:#ffffff; text-decoration:none; background:#ff4d8d; padding:14px 22px; border-radius:999px; width:320px; text-align:center; box-shadow:0 14px 32px rgba(255,77,141,0.35);"
                        >
                            LET ME IN
                        </a>
                        </td>
                    </tr>

                    <tr>
                        <td align="center" style="padding:16px 28px 0 28px;">
                        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; color:#7a8299; font-size:13px; line-height:1.55; text-align:center;">
                            If you didn’t sign up for SQRATCH, you can safely ignore this email.
                        </div>
                        </td>
                    </tr>

                    <tr>
                        <td align="center" style="padding:26px 28px 22px 28px;">
                        <div style="margin-top:14px; font-size:11px; color:#b0b7c9;">
                            © ${year} SQRATCH Inc. All rights reserved.
                        </div>
                        </td>
                    </tr>

                    </table>
                </td>
                </tr>
            </table>
        </body>
    </html>`;
}

// ================= INVITE LINK EMAIL SECTION =================
type InviteTemplateParams = {
  name: string;
  campaignName: string;
  inviteUrl: string;
  heroImageUrl?: string;
};

export function buildInviteEmailHtml(params: InviteTemplateParams) {
  const { name, campaignName, inviteUrl, heroImageUrl } = params;

  const year = new Date().getFullYear();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>You’re invited to ${escapeHtml(campaignName)}</title>
</head>

<body style="margin:0; padding:0; background:#0b1020;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
    You’re invited to join ${escapeHtml(campaignName)} on SQRATCH.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b1020;">
    <tr>
      <td align="center" style="padding:28px 14px;">

        <!-- CARD -->
        <table role="presentation" width="560" cellpadding="0" cellspacing="0"
          style="width:560px; background:#020121; border-radius:18px; overflow:hidden;
                 box-shadow:0 18px 60px rgba(0,0,0,0.45);
                 border:1px solid rgba(255,255,255,0.10);">

          <!-- LOGO -->
          <tr>
            <td align="center" style="padding:26px 28px 10px;">
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
                <div style="font-size:22px; font-weight:800; letter-spacing:-0.5px; color:#ffffff;">
                  SQRATCH<span style="opacity:0.6;">™</span>
                </div>
                <div style="margin-top:6px; font-size:12px; letter-spacing:0.9px;
                            text-transform:uppercase; color:#7a8299;">
                  POWERED BY PEOPLE WHO SHOW UP
                </div>
              </div>
            </td>
          </tr>

          <!-- IMAGE (INSIDE CARD, NOT BACKGROUND) -->
          <tr>
            <td align="center" style="padding:14px 28px 0;">
              <img
                src="${
                  heroImageUrl ??
                  "https://sqratch.com/assets/homepage/email_template_header.jpg"
                }"
                width="504"
                height="280"
                alt="SQRATCH Invitation"
                style="display:block; width:504px; height:280px;
                       object-fit:cover; border-radius:14px;
                       border:1px solid rgba(11,16,32,0.10);"
              />
            </td>
          </tr>

          <!-- HEADLINE -->
          <tr>
            <td align="center" style="padding:22px 28px 0;">
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
                          color:#0b1020;">
                <div style="font-size:28px; font-weight:800; line-height:1.15; color:#ffffff;">
                  You’re invited to ${escapeHtml(campaignName)}
                </div>
                <div style="margin:12px auto 0; width:44px; height:3px;
                            background:#ff4d8d; border-radius:999px;"></div>
              </div>
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td align="center" style="padding:16px 28px 0;">
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
                          color:#d6d9e6; font-size:15px; line-height:1.6; text-align:center;">
                <div style="color:#ffffff; font-weight:700; font-size:16px; margin-bottom:6px;">
                  Hi ${escapeHtml(name)},
                </div>
                You’ve been invited to join <strong>${escapeHtml(
                  campaignName
                )}</strong>. Click the button below to join this exciting new exclusive community!
              </div>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td align="center" style="padding:22px 28px 0;">
              <a
                href="${escapeAttr(inviteUrl)}"
                target="_blank"
                rel="noreferrer"
                style="display:inline-block; width:320px; text-align:center;
                       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
                       font-size:15px; font-weight:700; color:#ffffff;
                       text-decoration:none; background:#ff4d8d;
                       padding:14px 22px; border-radius:999px;
                       box-shadow:0 14px 32px rgba(255,77,141,0.35);">
                JOIN ${escapeHtml(campaignName).toUpperCase()}
              </a>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td align="center" style="padding:18px 28px 22px;">
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
                          color:#7a8299; font-size:13px; line-height:1.55; text-align:center;">
                If you weren’t expecting this invitation, you can safely ignore this email.
                <div style="margin-top:14px; font-size:11px; color:#b0b7c9;">
                  © ${year} SQRATCH Inc. All rights reserved.
                </div>
              </div>
            </td>
          </tr>

        </table>
        <!-- /CARD -->

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Basic escaping so user-provided name can't break HTML. */
function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Escape for attribute values. */
function escapeAttr(input: string) {
  return escapeHtml(input).replaceAll("`", "&#096;");
}
