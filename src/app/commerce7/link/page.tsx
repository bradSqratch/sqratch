import { redirect } from "next/navigation";
import prisma from "@/lib/prisma";
import { getBrandAdminContext } from "@/lib/brand-auth";
import { resolveLinkIntent } from "@/lib/commerce/provider-installation";
import { Commerce7LinkConfirmForm } from "./confirm-form";

/**
 * /commerce7/link — the TOP-LEVEL SQRATCH linking page.
 *
 * Reached by the "Connect to SQRATCH" button in the Commerce7 Admin Extension,
 * deliberately in a new top-level tab rather than inside the Commerce7 iframe:
 * SQRATCH authentication must never be collected inside a third-party frame.
 *
 * AUTHORIZATION: possession of the one-time token proves a privileged Commerce7
 * admin initiated the link. It confers NO SQRATCH authority on its own — the
 * visitor must additionally be an authenticated SQRATCH Brand Admin, and may
 * only select Brands they actually administer. Commerce7 and SQRATCH identities
 * are never matched by email; the linked Brand is always chosen explicitly.
 */
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function readParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  const value = params[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        fontFamily:
          "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        padding: "40px 24px",
        maxWidth: "560px",
        margin: "0 auto",
      }}
    >
      {children}
    </main>
  );
}

export default async function Commerce7LinkPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const rawToken = readParam(params, "t");

  if (!rawToken) {
    return (
      <Shell>
        <h1 style={{ fontSize: "20px" }}>This link is not valid</h1>
        <p style={{ color: "#52525b" }}>
          Reopen the SQRATCH app from your Commerce7 admin to start again.
        </p>
      </Shell>
    );
  }

  // Require SQRATCH authentication BEFORE resolving anything about the intent,
  // and return the visitor here afterwards via the existing login flow.
  const context = await getBrandAdminContext({ allowWithoutBrand: true });

  if (!context) {
    const callbackUrl = `/commerce7/link?t=${encodeURIComponent(rawToken)}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  const intent = await resolveLinkIntent(prisma, { rawToken });

  if (!intent.ok) {
    const message =
      intent.reason === "EXPIRED"
        ? "This connection link has expired. Reopen the SQRATCH app in Commerce7 to get a new one."
        : intent.reason === "CONSUMED"
          ? "This connection link has already been used."
          : intent.reason === "NOT_INSTALLED"
            ? "The SQRATCH app is no longer installed on that Commerce7 tenant."
            : "This connection link is not valid.";

    return (
      <Shell>
        <h1 style={{ fontSize: "20px" }}>Connection link unavailable</h1>
        <p style={{ color: "#52525b" }}>{message}</p>
      </Shell>
    );
  }

  // Only Brands this user genuinely administers (ADMIN/MANAGER membership, per
  // the shared Brand-management policy) are ever offered.
  const brands = context.brands;

  if (brands.length === 0) {
    return (
      <Shell>
        <h1 style={{ fontSize: "20px" }}>No eligible SQRATCH brand</h1>
        <p style={{ color: "#52525b" }}>
          Your SQRATCH account doesn&apos;t administer any brand yet, so there is
          nothing to connect <strong>{intent.externalAccountId}</strong> to.
        </p>
      </Shell>
    );
  }

  const alreadyOwned = await prisma.commerceConnection.findUnique({
    where: {
      provider_externalAccountId: {
        provider: intent.provider,
        externalAccountId: intent.externalAccountId,
      },
    },
    select: { brandId: true, brand: { select: { name: true } } },
  });

  if (alreadyOwned && !brands.some((brand) => brand.id === alreadyOwned.brandId)) {
    return (
      <Shell>
        <h1 style={{ fontSize: "20px" }}>Already connected to another brand</h1>
        <p style={{ color: "#52525b" }}>
          Commerce7 tenant <strong>{intent.externalAccountId}</strong> is already
          connected to a different SQRATCH brand. Transferring a connected store
          between brands isn&apos;t automatic — please contact SQRATCH support to
          arrange it.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 style={{ fontSize: "20px", marginBottom: "8px" }}>
        Connect Commerce7 to SQRATCH
      </h1>
      <p style={{ color: "#52525b", marginTop: 0 }}>
        Commerce7 tenant <strong>{intent.externalAccountId}</strong>
      </p>
      <Commerce7LinkConfirmForm
        token={rawToken}
        tenantId={intent.externalAccountId}
        brands={brands.map((brand) => ({ id: brand.id, name: brand.name }))}
      />
    </Shell>
  );
}
