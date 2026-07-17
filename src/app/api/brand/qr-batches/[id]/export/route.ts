import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AuthResolvers, realAuthResolvers } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

function sanitizeForCsv(value: string): string {
  if (!value) return "";
  // Check for CSV formula injection prefixes (=, +, -, @)
  const firstChar = value.charAt(0);
  if (["=", "+", "-", "@"].includes(firstChar)) {
    return `'${value}`;
  }
  return value;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  return exportBatchImpl(request, context, realAuthResolvers);
}

export async function exportBatchImpl(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
  deps: AuthResolvers,
) {
  try {
    const session = await deps.resolveSession();

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.user.role !== "BRAND_ADMIN" && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id: batchId } = await context.params;

    // Load batch with campaign detail to verify ownership
    const batch = await prisma.qRCodeBatch.findUnique({
      where: { id: batchId },
      select: {
        id: true,
        campaign: {
          select: {
            id: true,
            brandId: true,
          },
        },
      },
    });

    if (!batch || !batch.campaign) {
      return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    }

    const brand = await deps.resolveBrandAdminContext();
    const brandId = brand?.membership?.brand?.id || null;
    if (!brandId) {
      return NextResponse.json({ error: "Select an active brand.", code: "ACTIVE_BRAND_REQUIRED" }, { status: 409 });
    }
    if (batch.campaign.brandId !== brandId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Get count of QR codes in this batch to enforce hard maximum
    const qrCount = await prisma.qRCode.count({
      where: { batchId },
    });

    const EXPORT_LIMIT = 5000;
    if (qrCount > EXPORT_LIMIT) {
      return NextResponse.json(
        { error: `Export size too large. Hard maximum is ${EXPORT_LIMIT}.` },
        { status: 400 }
      );
    }

    // Load QR codes selecting only public printable fields (exclude redeemer emails / user PII)
    const qrCodes = await prisma.qRCode.findMany({
      where: { batchId },
      orderBy: { id: "asc" },
      select: {
        qrCodeData: true,
        qrCodeUrl: true,
        status: true,
      },
    });

    // Generate CSV content
    const domain = (
      process.env.DOMAIN ||
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      request.nextUrl.origin
    ).replace(/\/$/, "");

    const headers = ["QR Code Data", "QR Code URL", "Status", "Scan Redirect URL"];
    const rows = qrCodes.map((qr) => {
      const scanUrl = `${domain}/q/${qr.qrCodeData}`;
      return [
        sanitizeForCsv(qr.qrCodeData),
        sanitizeForCsv(qr.qrCodeUrl || ""),
        sanitizeForCsv(qr.status === "USED" ? "REDEEMED" : "NEW"),
        sanitizeForCsv(scanUrl),
      ];
    });

    const csvContent = [
      headers.join(","),
      ...rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")),
    ].join("\n");

    // Sanitized Audit Logging (excludes QR secret token values)
    console.log(
      `[Audit Log] QR Export generated. Brand ID: ${batch.campaign.brandId || "N/A"}, Campaign ID: ${batch.campaign.id}, Batch ID: ${batch.id}, Row Count: ${qrCodes.length}`
    );

    // Update batch to record export date
    await prisma.qRCodeBatch.update({
      where: { id: batchId },
      data: { csvExportedAt: new Date() },
    });

    return new NextResponse(csvContent, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="qr_batch_${batchId}.csv"`,
      },
    });
  } catch (error) {
    console.error("[brand/qr-batches/export][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to export QR batch." },
      { status: 500 }
    );
  }
}
