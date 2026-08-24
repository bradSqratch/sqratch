import Script from "next/script";
import {
  CommerceInstallationStatus,
  CommerceProvider,
  type Prisma,
} from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  commerce7RoleCanLink,
  normalizeCommerce7Tenant,
  verifyCommerce7AccountToken,
} from "@/lib/commerce/providers/commerce7";
import { createLinkIntent } from "@/lib/commerce/provider-installation";

/**
 * /commerce7/connect — the Commerce7 Admin App Extension page.
 *
 * Commerce7 renders this inside an admin iframe and supplies `tenantId` and
 * `account` (an account JWT) as query parameters.
 *
 * AUTHORIZATION MODEL: the account token is NEVER decoded locally to decide
 * anything. It is forwarded to Commerce7's `GET /v1/account/user`, whose
 * response is the sole authority on who the caller is and what role they hold.
 * A locally-parsed JWT proves nothing about validity, tenant binding, or role.
 *
 * The token is never logged and never persisted.
 *
 * This page performs NO SQRATCH authentication. Asking for SQRATCH credentials
 * inside a third-party iframe would be a phishing-shaped pattern; instead the
 * Connect button opens a TOP-LEVEL SQRATCH page carrying a one-time token.
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

function Shell({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "error" | "success";
}) {
  const border =
    tone === "error"
      ? "#dc2626"
      : tone === "success"
        ? "#16a34a"
        : "#d4d4d8";

  return (
    <>
      {/* Official Commerce7 iframe communication script, required by the Page
          extension so the frame can size/communicate with the Commerce7 admin. */}
      <Script
        src="https://dev-center.platform.commerce7.com/v2/commerce7.js"
        strategy="afterInteractive"
      />
      <main
        style={{
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          padding: "24px",
          maxWidth: "640px",
        }}
      >
        <div
          style={{
            border: `1px solid ${border}`,
            borderRadius: "10px",
            padding: "20px",
          }}
        >
          {children}
        </div>
      </main>
    </>
  );
}

export default async function Commerce7ConnectPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const tenantId = normalizeCommerce7Tenant(readParam(params, "tenantId"));
  const accountToken = readParam(params, "account");

  if (!tenantId || !accountToken) {
    return (
      <Shell tone="error">
        <h1 style={{ fontSize: "18px", margin: "0 0 8px" }}>
          Missing Commerce7 context
        </h1>
        <p style={{ margin: 0, color: "#52525b" }}>
          Open this page from the SQRATCH app inside your Commerce7 admin.
        </p>
      </Shell>
    );
  }

  // Authoritative identity check against Commerce7 itself.
  const verification = await verifyCommerce7AccountToken({
    tenant: tenantId,
    accountToken,
  });

  if (!verification.ok) {
    return (
      <Shell tone="error">
        <h1 style={{ fontSize: "18px", margin: "0 0 8px" }}>
          Could not verify your Commerce7 account
        </h1>
        <p style={{ margin: 0, color: "#52525b" }}>
          {verification.reason === "UNAUTHORIZED"
            ? "Your Commerce7 session has expired or is not permitted. Reload this page from your Commerce7 admin and try again."
            : "Commerce7 could not be reached right now. Please try again shortly."}
        </p>
      </Shell>
    );
  }

  const installation = await prisma.commerceProviderInstallation.findUnique({
    where: {
      provider_externalAccountId: {
        provider: CommerceProvider.COMMERCE7,
        externalAccountId: tenantId,
      },
    },
    select: { id: true, status: true },
  });

  if (!installation || installation.status !== CommerceInstallationStatus.INSTALLED) {
    return (
      <Shell tone="error">
        <h1 style={{ fontSize: "18px", margin: "0 0 8px" }}>
          SQRATCH is not installed on this tenant
        </h1>
        <p style={{ margin: 0, color: "#52525b" }}>
          Install the SQRATCH app on <strong>{tenantId}</strong> from the
          Commerce7 App Store, then reopen this page.
        </p>
      </Shell>
    );
  }

  // Already linked -> read-only status, no new intent is minted.
  const connection = await prisma.commerceConnection.findUnique({
    where: {
      provider_externalAccountId: {
        provider: CommerceProvider.COMMERCE7,
        externalAccountId: tenantId,
      },
    },
    select: { status: true, brand: { select: { name: true } } },
  });

  if (connection) {
    return (
      <Shell tone="success">
        <h1 style={{ fontSize: "18px", margin: "0 0 12px" }}>Connected to SQRATCH</h1>
        <dl style={{ margin: 0, display: "grid", gap: "6px" }}>
          <div>
            <dt style={{ display: "inline", color: "#52525b" }}>SQRATCH brand: </dt>
            <dd style={{ display: "inline", margin: 0, fontWeight: 600 }}>
              {connection.brand.name}
            </dd>
          </div>
          <div>
            <dt style={{ display: "inline", color: "#52525b" }}>Commerce7 tenant: </dt>
            <dd style={{ display: "inline", margin: 0, fontWeight: 600 }}>
              {tenantId}
            </dd>
          </div>
          <div>
            <dt style={{ display: "inline", color: "#52525b" }}>Status: </dt>
            <dd style={{ display: "inline", margin: 0, fontWeight: 600 }}>
              {connection.status}
            </dd>
          </div>
        </dl>
      </Shell>
    );
  }

  // Unlinked -> require a privileged Commerce7 role before minting an intent.
  if (!commerce7RoleCanLink(verification.user.role)) {
    return (
      <Shell tone="error">
        <h1 style={{ fontSize: "18px", margin: "0 0 8px" }}>
          Additional Commerce7 permission required
        </h1>
        <p style={{ margin: 0, color: "#52525b" }}>
          Connecting this tenant to a SQRATCH brand must be done by a Commerce7
          Admin Owner. Please ask an Admin Owner on{" "}
          <strong>{tenantId}</strong> to complete the connection.
        </p>
      </Shell>
    );
  }

  const intent = await prisma.$transaction((tx) =>
    createLinkIntent(tx as Prisma.TransactionClient, {
      installationId: installation.id,
    }),
  );

  // Application-relative on purpose: this page is already served from the
  // correct SQRATCH origin, so the destination must never be derived from a
  // caller-suppliable value (Host, X-Forwarded-Host, Referer, Origin). A
  // relative href always resolves against the page's own origin regardless of
  // what any request header claims.
  const linkUrl = `/commerce7/link?t=${encodeURIComponent(intent.rawToken)}`;

  return (
    <Shell>
      <h1 style={{ fontSize: "18px", margin: "0 0 8px" }}>Connect to SQRATCH</h1>
      <p style={{ margin: "0 0 16px", color: "#52525b" }}>
        Link Commerce7 tenant <strong>{tenantId}</strong> to your SQRATCH brand.
        You&apos;ll sign in to SQRATCH in a new tab and choose which brand to
        connect. This link is valid for 10 minutes.
      </p>
      <a
        href={linkUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-block",
          background: "#111827",
          color: "#ffffff",
          padding: "10px 16px",
          borderRadius: "8px",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        Connect to SQRATCH
      </a>
    </Shell>
  );
}
