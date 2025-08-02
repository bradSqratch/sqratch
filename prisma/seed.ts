import { PrismaClient, QRStatus, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  // 1. Create Admin User
  const adminPassword = bcrypt.hashSync("pass", 10);
  const admin = await prisma.user.upsert({
    where: { email: "admin@gmail.com" },
    update: {},
    create: {
      name: "Platform Admin",
      email: "admin@gmail.com",
      password: adminPassword,
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
      role: Role.ADMIN,
    },
  });
  console.log("✅ Admin user created:", admin.email);

  // 2. Create a Campaign
  const campaign = await prisma.campaign.create({
    data: {
      name: "launch2024",
      description: "Early Access Launch Campaign",
      inviteUrl: "https://minds.com/invite/launch2024",
      createdById: admin.id,
    },
  });
  console.log("✅ Campaign created:", campaign.name);

  // 3. Create QR Codes for the Campaign
  const qr1 = await prisma.qRCode.create({
    data: {
      qrCodeData: "abc123xyz",
      status: QRStatus.NEW,
      qrCodeUrl: `https://sqratch.com/c/${campaign.name}/abc123xyz`,
      campaignId: campaign.id,
      createdById: admin.id,
    },
  });

  const qr2 = await prisma.qRCode.create({
    data: {
      qrCodeData: "xyz789abc",
      status: QRStatus.NEW,
      qrCodeUrl: `https://sqratch.com/c/${campaign.name}/xyz789abc`,
      campaignId: campaign.id,
      createdById: admin.id,
    },
  });

  console.log("✅ QR codes created:", qr1.qrCodeData, qr2.qrCodeData);

  // 4. Create External User who redeems a QR code
  const redeemer = await prisma.user.create({
    data: {
      name: "Jane Doe",
      email: "jane@example.com",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
      role: Role.EXTERNAL,
    },
  });
  console.log("✅ External user created:", redeemer.email);

  // 5. Mark QR code as redeemed
  const redeemedQRCode = await prisma.qRCode.update({
    where: { id: qr1.id },
    data: {
      status: QRStatus.USED,
      usedAt: new Date(),
      redeemedById: redeemer.id,
      email: redeemer.email,
    },
  });
  console.log("✅ QR code redeemed by:", redeemer.email);

  // 6. Create Email Verification Token
  const token = await prisma.emailVerificationToken.create({
    data: {
      userId: redeemer.id,
      emailVerifyToken: "verify-token-001",
      expires: new Date(Date.now() + 1000 * 60 * 60), // 1 hour
    },
  });
  console.log("✅ Email verification token created for:", redeemer.email);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
