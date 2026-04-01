import { NextRequest, NextResponse } from "next/server";
import { getViewerSessionRecord, hasRedeemedQrWarning } from "@/lib/session";

export async function GET(request: NextRequest) {
  try {
    const viewerSession = await getViewerSessionRecord(request);

    return NextResponse.json({
      data: {
        hasRedeemedQrWarning: hasRedeemedQrWarning({
          viewerSession,
        }),
      },
    });
  } catch (error) {
    console.error("[public/viewer-status] Error:", error);
    return NextResponse.json(
      { error: "Failed to load viewer status." },
      { status: 500 },
    );
  }
}
