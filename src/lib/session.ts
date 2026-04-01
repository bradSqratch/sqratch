import crypto from "crypto";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export const SESSION_COOKIE_NAME = "sqr_session";
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function generateSessionId() {
  return crypto.randomBytes(24).toString("hex");
}

export async function getSessionIdFromRequest(request?: NextRequest) {
  if (request) {
    return request.cookies.get(SESSION_COOKIE_NAME)?.value || null;
  }

  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value || null;
}

export async function getViewerSessionRecord(request?: NextRequest) {
  const sessionId = await getSessionIdFromRequest(request);

  if (!sessionId) {
    return null;
  }

  return prisma.userSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      campaignId: true,
      qrCodeId: true,
      qrCode: {
        select: {
          id: true,
          status: true,
          redeemedById: true,
          qrCodeData: true,
        },
      },
    },
  });
}

export function hasRedeemedQrWarning(options: {
  viewerSession: Awaited<ReturnType<typeof getViewerSessionRecord>>;
  currentUserId?: string | null;
  allowedCampaignIds?: string[];
}) {
  const { viewerSession, currentUserId = null, allowedCampaignIds } = options;

  if (!viewerSession?.qrCode || viewerSession.qrCode.status !== "USED") {
    return false;
  }

  if (
    allowedCampaignIds &&
    (!viewerSession.campaignId ||
      !allowedCampaignIds.includes(viewerSession.campaignId))
  ) {
    return false;
  }

  const ownerUserId = currentUserId || viewerSession.userId || null;

  if (
    ownerUserId &&
    viewerSession.qrCode.redeemedById &&
    viewerSession.qrCode.redeemedById === ownerUserId
  ) {
    return false;
  }

  return true;
}

export async function ensureViewerSession(options?: {
  request?: NextRequest;
  userId?: string | null;
  campaignId?: string | null;
  qrCodeId?: string | null;
}) {
  const sessionId =
    (await getSessionIdFromRequest(options?.request)) || generateSessionId();

  await prisma.userSession.upsert({
    where: { id: sessionId },
    update: {
      lastSeenAt: new Date(),
      userId: options?.userId || undefined,
      campaignId: options?.campaignId || undefined,
      qrCodeId: options?.qrCodeId || undefined,
    },
    create: {
      id: sessionId,
      anonKey: sessionId,
      userId: options?.userId || undefined,
      campaignId: options?.campaignId || undefined,
      qrCodeId: options?.qrCodeId || undefined,
    },
  });

  return sessionId;
}

export function attachSessionCookie(
  response: NextResponse,
  sessionId: string,
) {
  response.cookies.set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  });

  return response;
}
