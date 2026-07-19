import { normalizeShopDomain } from "@/lib/shopify";

/**
 * True when a stored product link's sourceShopDomain matches the current
 * Shopify domain of the brand it's associated with. Links with a missing
 * brand, a missing source domain, or a source domain from a different store
 * are NOT current and must be hidden from public display — but never
 * deleted, and never hidden from creator/admin management (where they
 * should surface as needing relinking instead).
 *
 * Shared between ExperienceProductLink and LessonProductLink, which have
 * the same brandId/sourceShopDomain shape.
 */
export function isProductLinkCurrent(
  link: { brandId: string | null; sourceShopDomain: string | null },
  currentDomainByBrandId: Map<string, string | null | undefined>,
): boolean {
  const linkSource = normalizeShopDomain(link.sourceShopDomain);

  if (!linkSource || !link.brandId) {
    return false;
  }

  const brandDomain = normalizeShopDomain(
    currentDomainByBrandId.get(link.brandId) ?? null,
  );

  return Boolean(brandDomain) && brandDomain === linkSource;
}
