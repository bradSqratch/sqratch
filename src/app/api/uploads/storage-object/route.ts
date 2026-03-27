import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { deleteStorageObjectByUrl } from "@/lib/storage-upload";

export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    const role = session?.user?.role || null;

    if (!session?.user?.id || !role || !["ADMIN", "BRAND_ADMIN", "CREATOR"].includes(role)) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const url = String(body?.url || "").trim();

    if (!url) {
      return NextResponse.json(
        { error: "Storage object URL is required." },
        { status: 400 },
      );
    }

    const deleted = await deleteStorageObjectByUrl(url);

    return NextResponse.json({ data: { deleted } });
  } catch (error) {
    console.error("[uploads/storage-object][DELETE] Error:", error);
    return NextResponse.json(
      { error: "Failed to delete storage object." },
      { status: 500 },
    );
  }
}
