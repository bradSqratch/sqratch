import type { Role } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

type LessonProductActor = {
  userId: string;
  role: Extract<Role, "ADMIN" | "CREATOR">;
};

type CandidateBrand = {
  id: string;
  name: string;
  slug: string;
  shopifyShopDomain: string | null;
  shopifyAdminAccessTokenEncrypted: string | null;
  shopifyConnectionStatus: "DISCONNECTED" | "CONNECTED" | "UNINSTALLED" | "REQUIRES_RECONNECT";
};

export type LessonProductManagementContext = {
  actor: LessonProductActor;
  lesson: {
    id: string;
    title: string;
    course: {
      id: string;
      title: string;
      experience: {
        id: string;
        title: string;
        slug: string;
        creatorUserId: string;
      };
    };
  };
  candidateBrands: CandidateBrand[];
  primaryBrand: CandidateBrand | null;
};

export type LessonProductLinkRecord = {
  id: string;
  lessonId: string;
  productUrl: string;
  title: string | null;
  imageUrl: string | null;
  priceText: string | null;
  currency: string | null;
  brandId: string | null;
  createdAt: Date;
};

type ProductInputResult =
  | {
      ok: true;
      value: {
        productUrl: string;
        title: string | null;
        imageUrl: string | null;
        priceText: string | null;
        currency: string | null;
        brandId: string | null;
      };
    }
  | {
      ok: false;
      error: string;
    };

function toNullableString(value: unknown) {
  const normalized = String(value || "").trim();
  return normalized ? normalized : null;
}

export function normalizeProductUrl(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return trimmed;
  }
}

function normalizeCurrency(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  return normalized || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function getLessonProductManagementContext(
  lessonId: string,
): Promise<
  | { ok: false; status: number; error: string }
  | { ok: true; data: LessonProductManagementContext }
> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || null;
  const role = session?.user?.role || null;

  if (!userId) {
    return { ok: false, status: 401, error: "Unauthorized." };
  }

  if (role !== "CREATOR" && role !== "ADMIN") {
    return { ok: false, status: 403, error: "Creator or admin access required." };
  }

  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
      title: true,
      course: {
        select: {
          id: true,
          title: true,
          experience: {
            select: {
              id: true,
              title: true,
              slug: true,
              creator: {
                select: {
                  userId: true,
                },
              },
              campaigns: {
                orderBy: {
                  sortOrder: "asc",
                },
                select: {
                  campaign: {
                    select: {
                      brand: {
                        select: {
                          id: true,
                          name: true,
                          slug: true,
                          shopifyShopDomain: true,
                          shopifyAdminAccessTokenEncrypted: true,
                          shopifyConnectionStatus: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!lesson) {
    return { ok: false, status: 404, error: "Lesson not found." };
  }

  if (role === "CREATOR" && lesson.course.experience.creator.userId !== userId) {
    return { ok: false, status: 403, error: "Lesson access denied." };
  }

  const brandMap = new Map<string, CandidateBrand>();
  lesson.course.experience.campaigns.forEach((item) => {
    const brand = item.campaign.brand;

    if (brand && !brandMap.has(brand.id)) {
      brandMap.set(brand.id, brand);
    }
  });

  const candidateBrands = Array.from(brandMap.values());

  // Experiences can be attached to multiple campaign brands. Until the lesson
  // editor gets an explicit brand selector, use the first connected brand by
  // campaign sort order and then fall back to the first campaign brand.
  const primaryBrand =
    candidateBrands.find(
      (brand) =>
        brand.shopifyShopDomain &&
        brand.shopifyAdminAccessTokenEncrypted &&
        brand.shopifyConnectionStatus === "CONNECTED",
    ) || candidateBrands[0] || null;

  return {
    ok: true,
    data: {
      actor: {
        userId,
        role,
      },
      lesson: {
        id: lesson.id,
        title: lesson.title,
        course: {
          id: lesson.course.id,
          title: lesson.course.title,
          experience: {
            id: lesson.course.experience.id,
            title: lesson.course.experience.title,
            slug: lesson.course.experience.slug,
            creatorUserId: lesson.course.experience.creator.userId,
          },
        },
      },
      candidateBrands,
      primaryBrand,
    },
  };
}

export async function loadLessonProductLinks(lessonId: string) {
  const items = await prisma.lessonProductLink.findMany({
    where: {
      lessonId,
    },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      lessonId: true,
      productUrl: true,
      title: true,
      imageUrl: true,
      priceText: true,
      currency: true,
      brandId: true,
      createdAt: true,
    },
  });

  return items satisfies LessonProductLinkRecord[];
}

export function parseLessonProductInput(
  input: unknown,
  options?: {
    defaultBrandId?: string | null;
    allowedBrandIds?: string[];
  },
): ProductInputResult {
  const body = isRecord(input) ? input : {};
  const product = isRecord(body.product) ? body.product : {};

  const productUrl = normalizeProductUrl(
    String(product.productUrl || body.productUrl || "").trim(),
  );
  const title = toNullableString(product.title || body.title);
  const imageUrl = toNullableString(
    product.imageUrl ||
      (Array.isArray(product.images) ? product.images[0] : null) ||
      body.imageUrl,
  );
  const currency =
    normalizeCurrency(product.currency || body.currency) ||
    (product.priceRange ? "USD" : null);

  const range = isRecord(product.priceRange) ? product.priceRange : null;
  const minPrice =
    typeof range?.min === "number" && Number.isFinite(range.min)
      ? range.min
      : null;
  const maxPrice =
    typeof range?.max === "number" && Number.isFinite(range.max)
      ? range.max
      : null;

  let priceText = toNullableString(product.priceText || body.priceText);

  if (!priceText && (minPrice !== null || maxPrice !== null)) {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    });

    if (minPrice !== null && maxPrice !== null && minPrice !== maxPrice) {
      priceText = `${formatter.format(minPrice)} - ${formatter.format(maxPrice)}`;
    } else if (minPrice !== null) {
      priceText = formatter.format(minPrice);
    } else if (maxPrice !== null) {
      priceText = formatter.format(maxPrice);
    }
  }

  const requestedBrandId = toNullableString(product.brandId || body.brandId);
  const allowedBrandIds = new Set(options?.allowedBrandIds || []);

  if (requestedBrandId && allowedBrandIds.size > 0 && !allowedBrandIds.has(requestedBrandId)) {
    return {
      ok: false,
      error: "Selected brand is not available for this lesson.",
    };
  }

  if (!productUrl) {
    return {
      ok: false,
      error: "productUrl is required.",
    };
  }

  try {
    const url = new URL(productUrl);

    if (!["http:", "https:"].includes(url.protocol)) {
      return {
        ok: false,
        error: "productUrl must be an absolute http or https URL.",
      };
    }
  } catch {
    return {
      ok: false,
      error: "productUrl must be a valid URL.",
    };
  }

  return {
    ok: true,
    value: {
      productUrl,
      title,
      imageUrl,
      priceText,
      currency,
      brandId:
        requestedBrandId ||
        (allowedBrandIds.size > 0 ? options?.defaultBrandId || null : null),
    },
  };
}
