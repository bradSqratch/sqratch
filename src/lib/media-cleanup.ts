import prisma from "@/lib/prisma";
import { isMediaReferenced } from "@/lib/media-references";
import { deleteStorageObjectByUrl, parsePublicStorageUrl } from "@/lib/storage-upload";

/** Cleanup is best effort after commit; an uncertain reference check retains the asset. */
export async function cleanupUnreferencedMedia(url: string) {
  try {
    const object = parsePublicStorageUrl(url);
    if (!object || await isMediaReferenced(prisma, object, url)) return false;
    return await deleteStorageObjectByUrl(url);
  } catch {
    console.error("Media cleanup deferred after storage or reference-check failure.");
    return false;
  }
}
