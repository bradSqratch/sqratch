import type { Prisma } from "@prisma/client";
import { getPublicStorageUrl } from "@/lib/storage-upload";

/** A read-only defence against deleting an attached upload. P13 owns attach/delete races. */
export async function isMediaReferenced(
  db: Pick<Prisma.TransactionClient, "lesson" | "user" | "brand" | "experience">,
  object: { bucket: string; path: string },
  url?: string,
): Promise<boolean> {
  const canonical = getPublicStorageUrl(object.bucket, object.path);
  const encoded = getPublicStorageUrl(encodeURIComponent(object.bucket), object.path.split("/").map(encodeURIComponent).join("/"));
  const bases = new Set([canonical, encoded]);
  if (url) {
    const parsed = new URL(url);
    bases.add(`${parsed.origin}${parsed.pathname}`);
  }
  const matches = [...bases].flatMap((base) => [
    { equals: base }, { startsWith: `${base}?` }, { startsWith: `${base}#` },
  ]);
  const lesson = await db.lesson.findFirst({
    where: { OR: [
      { videoStorageBucket: object.bucket, videoStoragePath: object.path },
      ...matches.map((match) => ({ videoUploadUrl: match })),
    ] }, select: { id: true },
  });
  if (lesson) return true;
  const [user, brand, experience] = await Promise.all([
    db.user.findFirst({ where: { OR: matches.map((match) => ({ imageUrl: match })) }, select: { id: true } }),
    db.brand.findFirst({ where: { OR: matches.flatMap((match) => [{ logoUrl: match }, { coverImageUrl: match }]) }, select: { id: true } }),
    db.experience.findFirst({ where: { OR: matches.flatMap((match) => [{ coverImageUrl: match }, { whyVideoUploadUrl: match }]) }, select: { id: true } }),
  ]);
  return Boolean(user || brand || experience);
}
