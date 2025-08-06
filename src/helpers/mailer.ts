import nodemailer from "nodemailer";

export const sendVerificationEmail = async (
  email: string,
  emailVerifyToken: string,
  qrCodeId?: string
) => {
  try {
    // create a hased token
    // const hashedToken = await bcryptjs.hash(userId.toString(), 10);

    // if (emailType === "VERIFY") {
    //   await User.findByIdAndUpdate(userId, {
    //     verifyToken: hashedToken,
    //     verifyTokenExpiry: Date.now() + 3600000,
    //   });
    // } else if (emailType === "RESET") {
    //   await User.findByIdAndUpdate(userId, {
    //     forgotPasswordToken: hashedToken,
    //     forgotPasswordTokenExpiry: Date.now() + 3600000,
    //   });
    // }

    var transport = nodemailer.createTransport({
      host: process.env.MAILTRAP_HOST,
      port: 2525,
      auth: {
        user: process.env.MAILTRAP_USER,
        pass: process.env.MAILTRAP_PASSWORD,
      },
    });

    const verificationUrl = `${
      process.env.DOMAIN
    }/verify-email?token=${emailVerifyToken}${
      qrCodeId ? `&qrcodeID=${qrCodeId}` : ""
    }`;

    const mailOptions = {
      from: process.env.ADMIN_EMAIL,
      to: email,
      subject: "Verify Your Email Address",
      html: `
        <h1>Welcome to SQRATCH!</h1>
        <p>Please click the link below to verify your email address:</p>
        <a href="${verificationUrl}" style="padding: 10px 20px; color: white; background-color: blue; text-decoration: none; border-radius: 5px;">Verify Email</a>
        <p>If you did not sign up, you can safely ignore this email.</p>
      `,
    };

    const mailresponse = await transport.sendMail(mailOptions);
    return mailresponse;
  } catch (error: any) {
    throw new Error(error.message);
  }
};

export async function sendInviteEmail(
  email: string,
  inviteUrl: string,
  campaignName: string
) {
  const transport = nodemailer.createTransport({
    host: process.env.MAILTRAP_HOST,
    port: 2525,
    auth: {
      user: process.env.MAILTRAP_USER,
      pass: process.env.MAILTRAP_PASSWORD,
    },
  });

  const mailOptions = {
    from: process.env.ADMIN_EMAIL,
    to: email,
    subject: `You're invited to join ${campaignName} on SQRATCH!`,
    html: `
      <h1>Welcome to ${campaignName}!</h1>
      <p>Click the link below to join the campaign:</p>
      <a href="${inviteUrl}" style="padding: 10px 20px; background: #2563eb; color: white; border-radius: 4px;">Join Campaign</a>
    `,
  };

  return await transport.sendMail(mailOptions);
}
