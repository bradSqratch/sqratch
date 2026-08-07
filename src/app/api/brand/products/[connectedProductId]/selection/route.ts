import { NextRequest, NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import { validateSelectionUpdate, type SelectionUpdateInput } from "@/lib/commerce/product-catalog-api";

/**
 * `PATCH /api/brand/products/[connectedProductId]/selection` — upserts the
 * brand's `BrandCommerceProduct` row for a `ConnectedCommerceProduct`
 * (visibility, campaign eligibility, display order, and the two
 * SQRATCH-side presentation overrides).
 *
 * SECURITY: the product is resolved with
 * `findFirst({ where: { id, brandId: brand.id } })` — never a bare
 * `findUnique({ where: { id } })` followed by a brandId comparison — so a
 * wrong-brand id and a nonexistent id take the exact same code path and
 * return the exact same 404.
 *
 * SCOPE: this route writes ONLY `BrandCommerceProduct` (a SQRATCH-side
 * presentation table). It never calls a commerce adapter, never imports
 * `@/lib/commerce/registry` or any provider client, and never touches
 * `ConnectedCommerceProduct` — overrides here must never write back to
 * Shopify or any other provider.
 */

export type ConnectedProductRef = { id: string };

export type SelectionResult = {
  connectedProductId: string;
  isVisibleInShop: boolean;
  isCampaignEligible: boolean;
  displayOrder: number;
  titleOverride: string | null;
  shortDescriptionOverride: string | null;
};

export type BrandProductSelectionDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  /** Resolves the product ONLY if it belongs to `brandId` — a wrong-brand or nonexistent id both resolve to `null`. */
  findOwnedProduct(id: string, brandId: string): Promise<ConnectedProductRef | null>;
  upsertSelection(
    brandId: string,
    connectedProductId: string,
    data: SelectionUpdateInput,
  ): Promise<SelectionResult>;
};

async function defaultFindOwnedProduct(
  id: string,
  brandId: string,
): Promise<ConnectedProductRef | null> {
  return prisma.connectedCommerceProduct.findFirst({
    where: { id, brandId },
    select: { id: true },
  });
}

async function defaultUpsertSelection(
  brandId: string,
  connectedProductId: string,
  data: SelectionUpdateInput,
): Promise<SelectionResult> {
  const row = await prisma.brandCommerceProduct.upsert({
    where: { brandId_connectedProductId: { brandId, connectedProductId } },
    create: {
      brandId,
      connectedProductId,
      isVisibleInShop: data.isVisibleInShop ?? false,
      isCampaignEligible: data.isCampaignEligible ?? false,
      displayOrder: data.displayOrder ?? 0,
      titleOverride: data.titleOverride ?? null,
      shortDescriptionOverride: data.shortDescriptionOverride ?? null,
    },
    update: {
      ...(data.isVisibleInShop !== undefined ? { isVisibleInShop: data.isVisibleInShop } : {}),
      ...(data.isCampaignEligible !== undefined
        ? { isCampaignEligible: data.isCampaignEligible }
        : {}),
      ...(data.displayOrder !== undefined ? { displayOrder: data.displayOrder } : {}),
      ...("titleOverride" in data ? { titleOverride: data.titleOverride } : {}),
      ...("shortDescriptionOverride" in data
        ? { shortDescriptionOverride: data.shortDescriptionOverride }
        : {}),
    },
    select: {
      connectedProductId: true,
      isVisibleInShop: true,
      isCampaignEligible: true,
      displayOrder: true,
      titleOverride: true,
      shortDescriptionOverride: true,
    },
  });
  return row;
}

const DEFAULT_DEPS: BrandProductSelectionDeps = {
  getContext: getBrandManagementContext,
  findOwnedProduct: defaultFindOwnedProduct,
  upsertSelection: defaultUpsertSelection,
};

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ connectedProductId: string }> },
) {
  return selectionPatchImpl(request, context);
}

export async function selectionPatchImpl(
  request: NextRequest,
  context: { params: Promise<{ connectedProductId: string }> },
  overrides: Partial<BrandProductSelectionDeps> = {},
) {
  const deps: BrandProductSelectionDeps = { ...DEFAULT_DEPS, ...overrides };

  try {
    const authContext = await deps.getContext();

    if (!authContext?.membership?.brand) {
      const failure = getBrandContextFailure(authContext);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    // The ONLY brand id ever used below.
    const brand = authContext.membership.brand;

    const { connectedProductId } = await context.params;

    const body = await request.json().catch(() => null);
    const validation = validateSelectionUpdate(body);

    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // findFirst({ id, brandId }) — a wrong-brand product id and a
    // nonexistent id are indistinguishable: both hit this branch, both
    // return the same 404 body/status.
    const owned = await deps.findOwnedProduct(connectedProductId, brand.id);

    if (!owned) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }

    const result = await deps.upsertSelection(brand.id, owned.id, validation.data);

    return NextResponse.json({ data: result });
  } catch (error) {
    console.error("[brand/products/[connectedProductId]/selection][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update product selection." },
      { status: 500 },
    );
  }
}
