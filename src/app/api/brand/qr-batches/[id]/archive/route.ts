import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { realAuthResolvers, type AuthResolvers } from "@/lib/auth-session";
import { assertExpectedBrand, getBrandContextFailure } from "@/lib/brand-auth";

/**
 * Sets this batch's list state to archived. Operational list hygiene only: no
 * QR code, unlock, ledger row, attribution record or printed link is touched,
 * and scanning and redemption never read this state. Repeating the request is a
 * no-op that still answers with the batch's current state.
 */
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  return archiveBatchImpl(request, context, realAuthResolvers);
}

export async function archiveBatchImpl(request: NextRequest, { params }: Context, deps: AuthResolvers) {
  try {
    if (!(await deps.resolveSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const brand = await deps.resolveBrandAdminContext();
    if (!brand?.membership?.brand) {
      const failure = getBrandContextFailure(brand);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }
    const mismatch = assertExpectedBrand(request, brand);
    if (mismatch) return NextResponse.json(mismatch, { status: mismatch.status });

    const { id } = await params;
    const scope = { id, campaign: { brandId: brand.membership.brand.id } };
    await prisma.qRCodeBatch.updateMany({
      where: { ...scope, archivedAt: null },
      data: { archivedAt: new Date(), archivedById: brand.userId },
    });
    const batch = await prisma.qRCodeBatch.findFirst({ where: scope, select: { id: true, archivedAt: true } });
    if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({ data: { id: batch.id, archivedAt: batch.archivedAt } });
  } catch (error) {
    console.error("[brand/qr-batches][archive] Error:", error);
    return NextResponse.json({ error: "Failed to update the batch." }, { status: 500 });
  }
}
