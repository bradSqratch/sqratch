export type ShopifyInstallBrandOption = {
  id: string;
};

/**
 * Choose the initial install destination from server-authorized options.
 * The active brand wins only when it is present in the eligible list; the
 * list itself is the source of truth for every fallback.
 */
export function getDefaultShopifyInstallBrandId(
  brands: ShopifyInstallBrandOption[],
  activeBrandId: string | null | undefined,
) {
  return (
    brands.find((brand) => brand.id === activeBrandId)?.id ||
    brands[0]?.id ||
    ""
  );
}
