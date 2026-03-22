import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { getMaxUploadBytes, uploadFileToStorage } from "@/lib/storage-upload";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

const MIME_TYPE_TO_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

function buildAvatarPath(userId: string, file: File) {
  const extension = MIME_TYPE_TO_EXTENSION[file.type] || "bin";
  return `users/${userId}/avatar/${Date.now()}.${extension}`;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "An image file is required." },
        { status: 400 },
      );
    }

    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: "Only PNG, JPG, JPEG, and WEBP images are allowed." },
        { status: 400 },
      );
    }

    if (file.size > getMaxUploadBytes()) {
      return NextResponse.json(
        { error: "File is too large." },
        { status: 400 },
      );
    }

    const bucket = process.env.SUPABASE_USER_AVATAR_BUCKET || "user-avatars";
    const path = buildAvatarPath(userId, file);
    const uploaded = await uploadFileToStorage({
      bucket,
      path,
      file,
      cacheControl: "3600",
      upsert: true,
    });

    return NextResponse.json({
      data: {
        bucket: uploaded.bucket,
        path: uploaded.path,
        fileUrl: uploaded.fileUrl,
      },
    });
  } catch (error) {
    console.error("[uploads/user-avatar][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to upload avatar." },
      { status: 500 },
    );
  }
}
