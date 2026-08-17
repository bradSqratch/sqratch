import { CommerceProvider } from "@prisma/client";
import { getValidAccessToken } from "@/lib/shopify-token-manager";
import { SHOPIFY_API_VERSION, isValidShopDomain } from "@/lib/shopify";
import {
  SQRATCH_ATTRIBUTION_EMBED_BLOCK_HANDLE,
} from "@/lib/commerce/shopify-app-embed";
import type {
  CommerceThemeTrackingReadiness,
  CommerceThemeTrackingState,
} from "@/lib/commerce/types";

type ThemeReadinessInput = {
  brandId: string;
  shopDomain: string;
  apiKey: string;
  grantedScopes: string[];
};

type ThemeReadinessDeps = {
  fetchImpl?: typeof fetch;
  getAccessToken?: typeof getValidAccessToken;
};

const REQUIRED_SCOPE = "read_themes";

function result(state: CommerceThemeTrackingState): CommerceThemeTrackingReadiness {
  return { provider: CommerceProvider.SHOPIFY, state };
}

function hasScope(scopes: string[]): boolean {
  return scopes.some((scope) => scope.trim() === REQUIRED_SCOPE);
}

/**
 * Reads only the current main theme's settings_data.json. The response is
 * intentionally reduced to a neutral readiness state; theme JSON is never
 * persisted, logged, or returned to callers.
 */
export async function getShopifyThemeTrackingReadiness(
  input: ThemeReadinessInput,
  deps: ThemeReadinessDeps = {},
): Promise<CommerceThemeTrackingReadiness> {
  if (!hasScope(input.grantedScopes)) return result("PERMISSION_REQUIRED");
  if (!isValidShopDomain(input.shopDomain) || !input.apiKey.trim()) {
    return result("UNKNOWN");
  }

  const getToken = deps.getAccessToken ?? getValidAccessToken;
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Scope authority was checked against the provider-neutral summary above;
  // the token lifecycle helper must not re-authorize this request from the
  // legacy Brand scope mirror.
  let token: Awaited<ReturnType<typeof getValidAccessToken>>;
  try {
    token = await getToken(input.brandId, { skipScopeCheck: true });
  } catch {
    return result("UNKNOWN");
  }
  if (!token.ok) return result("UNKNOWN");

  const base = `https://${input.shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;
  try {
    const themesResponse = await fetchImpl(`${base}/themes.json?role=main`, {
      headers: { "X-Shopify-Access-Token": token.accessToken, Accept: "application/json" },
    });
    if (!themesResponse.ok) return result("UNKNOWN");
    const themesPayload = (await themesResponse.json()) as { themes?: unknown };
    const themes = Array.isArray(themesPayload.themes) ? themesPayload.themes : [];
    const mainTheme = themes.find(
      (theme): theme is { id: string | number; role?: string } =>
        typeof theme === "object" && theme !== null &&
        (theme as { role?: unknown }).role === "main" &&
        (typeof (theme as { id?: unknown }).id === "string" ||
          typeof (theme as { id?: unknown }).id === "number"),
    );
    if (!mainTheme) return result("UNKNOWN");

    const assetResponse = await fetchImpl(
      `${base}/themes/${encodeURIComponent(String(mainTheme.id))}/assets.json?asset[key]=config/settings_data.json`,
      { headers: { "X-Shopify-Access-Token": token.accessToken, Accept: "application/json" } },
    );
    if (!assetResponse.ok) return result("UNKNOWN");
    const assetPayload = (await assetResponse.json()) as {
      asset?: { value?: unknown };
    };
    if (typeof assetPayload.asset?.value !== "string") return result("UNKNOWN");
    const settings = JSON.parse(assetPayload.asset.value) as unknown;
    if (typeof settings !== "object" || settings === null) return result("UNKNOWN");
    const current = (settings as { current?: unknown }).current;
    if (typeof current !== "object" || current === null) return result("UNKNOWN");
    const blocks = (current as { blocks?: unknown }).blocks;
    if (typeof blocks !== "object" || blocks === null || Array.isArray(blocks)) {
      return result("NOT_CONFIGURED");
    }

    const expectedPrefix = `shopify://apps/${input.apiKey}/blocks/${SQRATCH_ATTRIBUTION_EMBED_BLOCK_HANDLE}/`;
    const matches = Object.values(blocks).filter((block): block is { type?: unknown; disabled?: unknown } => {
      if (typeof block !== "object" || block === null) return false;
      const type = (block as { type?: unknown }).type;
      return typeof type === "string" && type.startsWith(expectedPrefix);
    });
    if (matches.length === 0) return result("NOT_CONFIGURED");
    if (matches.length !== 1 || typeof matches[0].disabled !== "boolean") return result("UNKNOWN");
    return result(matches[0].disabled ? "DISABLED" : "ENABLED");
  } catch {
    return result("UNKNOWN");
  }
}
