"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface EmbeddedShellClientProps {
  shopifyApiKey: string;
  distribution: "public" | "custom";
  rawShop: string;
}

// Typed accessor for the App Bridge global injected by the CDN script.
declare global {
  interface Window {
    shopify?: {
      idToken(): Promise<string>;
      environment?: {
        embedded?: boolean;
      };
    };
  }
}

function isEmbedded(): boolean {
  try {
    return (
      window.self !== window.top ||
      Boolean(window.shopify?.environment?.embedded)
    );
  } catch {
    // cross-origin frame access blocked means we ARE embedded
    return true;
  }
}

export default function EmbeddedShellClient({
  shopifyApiKey,
  distribution,
  rawShop,
}: EmbeddedShellClientProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue() {
    setError(null);
    setLoading(true);

    try {
      if (distribution === "public" && typeof window !== "undefined" && isEmbedded()) {
        // Embedded public distribution: use App Bridge session token.
        if (!window.shopify) {
          throw new Error(
            "App Bridge is not loaded yet. Please reopen SQRATCH from your Shopify Admin."
          );
        }

        const sessionToken = await window.shopify.idToken();

        const res = await fetch("/api/shopify/embedded/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({}),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(
            `Session setup failed (${res.status})${text ? `: ${text}` : ""}. Please try again.`
          );
        }

        const json = (await res.json()) as {
          data?: { installId?: string; redirectTo?: string };
        };

        const redirectTo =
          json?.data?.redirectTo ??
          (json?.data?.installId
            ? `/dashboard/brand/shopify/install?install=${encodeURIComponent(json.data.installId)}`
            : null);

        if (!redirectTo) {
          throw new Error("Unexpected response from server. Please try again.");
        }

        // Navigate top-level out of the Shopify iframe.
        window.top!.location.href = redirectTo;
      } else {
        // Custom distribution OR non-embedded direct browser visit:
        // Fall back to initiating OAuth. Only use rawShop as an input to
        // /api/shopify/oauth/start (which validates the shop itself).
        if (rawShop) {
          window.location.href = `/api/shopify/oauth/start?shop=${encodeURIComponent(rawShop)}`;
        } else {
          setError(
            "No Shopify store context found. Please open SQRATCH from your Shopify Admin."
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  }

  // For the custom/non-embedded fallback we allow an OAuth start link only if
  // a raw shop was provided (server passes it through solely for this purpose).
  const showOAuthFallback = distribution === "custom" || !shopifyApiKey;

  return (
    <div className="space-y-6 px-7 py-7">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-white/45">
            Shopify store
          </p>
          <p className="mt-2 text-sm text-white/85">
            {rawShop
              ? "Store detected — open via Shopify Admin"
              : "Open SQRATCH from your Shopify Admin"}
          </p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-white/45">
            SQRATCH link
          </p>
          <p className="mt-2 text-sm text-white/85">
            Complete setup to link your store
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-[#b7a6e8]/20 bg-[#b7a6e8]/10 p-5 text-sm leading-6 text-white/75">
        Link this Shopify store to a SQRATCH Brand account so Brand Admins can
        display Shopify products inside SQRATCH experiences. SQRATCH only
        requests product read access.
      </div>

      {error ? (
        <p className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {showOAuthFallback && rawShop ? (
          <Button
            asChild
            className="rounded-full border border-white bg-white px-5 text-black hover:bg-white/90"
          >
            <a
              href={`/api/shopify/oauth/start?shop=${encodeURIComponent(rawShop)}`}
            >
              Continue to SQRATCH linking
            </a>
          </Button>
        ) : showOAuthFallback ? (
          <Button
            type="button"
            disabled
            className="rounded-full border border-white bg-white px-5 text-black hover:bg-white/90"
          >
            Continue to SQRATCH linking
          </Button>
        ) : (
          <Button
            type="button"
            disabled={loading}
            onClick={handleContinue}
            className="rounded-full border border-white bg-white px-5 text-black hover:bg-white/90"
          >
            {loading ? "Setting up…" : "Continue to SQRATCH linking"}
          </Button>
        )}
      </div>
    </div>
  );
}
