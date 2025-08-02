import nodemailer from "nodemailer";

export const sendVerificationEmail = async (
  email: string,
  emailVerifyToken: string
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
      host: "sandbox.smtp.mailtrap.io",
      port: 2525,
      auth: {
        user: process.env.MAILTRAP_USER,
        pass: process.env.MAILTRAP_PASSWORD,
      },
    });

    const verificationUrl = `${process.env.DOMAIN}/verify-email?token=${emailVerifyToken}`;

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
