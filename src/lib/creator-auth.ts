import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

export type CreatorContext = {
  userId: string;
  creatorProfile: {
    id: string;
    userId: string;
    displayName: string | null;
  };
};

export async function getCreatorContext(): Promise<CreatorContext | null> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || null;
  const role = session?.user?.role || null;

  if (!userId || role !== "CREATOR") {
    return null;
  }

  const creatorProfile = await prisma.creatorProfile.findUnique({
    where: {
      userId,
    },
    select: {
      id: true,
      userId: true,
      displayName: true,
    },
  });

  if (!creatorProfile) {
    return null;
  }

  return {
    userId,
    creatorProfile,
  };
}

export async function getOwnedExperienceForCreator(
  experienceId: string,
  userId: string,
) {
  return prisma.experience.findFirst({
    where: {
      id: experienceId,
      creator: {
        userId,
      },
    },
    select: {
      id: true,
      title: true,
      slug: true,
      description: true,
      coverImageUrl: true,
      isActive: true,
      creatorId: true,
    },
  });
}

export function normalizeExperienceStatus(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  return normalized === "PUBLISHED" ? "PUBLISHED" : "DRAFT";
}

export function isPublishedStatus(value: unknown) {
  return normalizeExperienceStatus(value) === "PUBLISHED";
}

export function slugifyValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
