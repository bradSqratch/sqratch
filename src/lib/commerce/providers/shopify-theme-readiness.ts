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
  connectionId: string;
  shopDomain: string;
  /**
   * The install-time Shopify app client id. No longer used to MATCH the
   * embed block (see `APP_EMBED_BLOCK_TYPE_PATTERN` below) — kept only as a
   * connectivity precondition, mirroring the same "do we have enough on
   * record to even attempt this" guard `buildThemeEditorAppEmbedDeepLink`
   * uses for the SAME brand fields.
   */
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

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches Shopify's DOCUMENTED app-embed block `type` string —
 * https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration
 * ("Detecting app embed blocks"):
 *
 *   shopify://apps/<app handle>/blocks/<block handle>/<block instance uuid>
 *
 * Shopify's own worked example: `"type": "shopify://apps/faceforms-better-pop-ups/blocks/app-embed/f2173231-e611-461d-884b-bd8e6cc2ded4"`.
 * The `<app handle>` segment is the Shopify app's HANDLE (a slug assigned at
 * Partner Dashboard app creation) — it is NEVER the app's client_id/api_key.
 * This is a different Shopify-documented convention from the ACTIVATION deep
 * link's `activateAppId` parameter (see `buildThemeEditorAppEmbedDeepLink` in
 * `shopify-app-embed.ts`), which the SAME docs page confirms DOES use
 * `{api_key}` ("This is the same value as the client_id"). Two genuinely
 * different Shopify-documented identifiers for two different purposes —
 * easy to conflate, and conflating them was the exact prior bug here: this
 * function used to build `shopify://apps/${apiKey}/blocks/...` and compare
 * that against `settings_data.json`, which can never match a real embed
 * (api_key is never equal to the app's handle), producing a permanent false
 * `NOT_CONFIGURED` for every genuinely enabled embed.
 *
 * The app handle also differs between SQRATCH's custom test app and its
 * production app — `shopify.app.toml` and `shopify.app.custom.toml` are two
 * separate Partner Dashboard app registrations, each with its own
 * independently-assigned `client_id` AND its own independently-assigned
 * handle (confirmed live: the custom app's own permission screen names it
 * "sqratch-custom-app-test", not a value derived from its client_id). Rather
 * than resolve "our own app's handle" per environment — an extra Admin API
 * dependency this check does not otherwise need — this matches on the BLOCK
 * handle segment only: SQRATCH's own stable, already-authoritative
 * `SQRATCH_ATTRIBUTION_EMBED_BLOCK_HANDLE` constant (filename-derived, and
 * the exact same constant the deep-link builder uses), accepting any
 * app-handle segment. This is a "stable Shopify-supported identifier" in
 * exactly the sense required: it is Shopify's own documented block-type
 * grammar, applied to the one segment SQRATCH genuinely owns and controls,
 * with no per-environment app identity to hardcode or resolve. A different
 * Shopify app coincidentally registering a block with this exact literal
 * handle is not something Shopify's docs describe guarding against, but
 * this field is a purely informational readiness signal, never an
 * authorization gate — that failure mode would be a benign false ENABLED,
 * not a security or data-integrity issue.
 */
const APP_EMBED_BLOCK_TYPE_PATTERN = new RegExp(
  `^shopify://apps/[^/]+/blocks/${escapeForRegExp(SQRATCH_ATTRIBUTION_EMBED_BLOCK_HANDLE)}/[^/]+$`,
);

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
  // Scope authority was checked against the canonical provider-neutral
  // connection summary above; skip the token helper's baseline-scope gate
  // because theme readiness specifically reports the read_themes capability.
  let token: Awaited<ReturnType<typeof getValidAccessToken>>;
  try {
    token = await getToken(input.brandId, {
      connectionId: input.connectionId,
      expectedExternalAccountId: input.shopDomain,
      skipScopeCheck: true,
    });
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
    const blocksRaw = (current as { blocks?: unknown }).blocks;
    if (blocksRaw === undefined) {
      // Shopify's own docs are explicit: the `blocks` entry for an app embed
      // is added to settings_data.json only once the embed has been enabled
      // for the FIRST time. A theme whose `current` genuinely has no
      // `blocks` key at all is the documented "never enabled" state — not
      // malformed data — so NOT_CONFIGURED is the honest answer here.
      return result("NOT_CONFIGURED");
    }
    if (typeof blocksRaw !== "object" || blocksRaw === null || Array.isArray(blocksRaw)) {
      // Present but not shaped like Shopify's documented object-of-blocks —
      // genuinely unexpected data, never guessed into NOT_CONFIGURED.
      return result("UNKNOWN");
    }
    const blocks = blocksRaw;

    const matches = Object.values(blocks).filter((block): block is { type?: unknown; disabled?: unknown } => {
      if (typeof block !== "object" || block === null) return false;
      const type = (block as { type?: unknown }).type;
      return typeof type === "string" && APP_EMBED_BLOCK_TYPE_PATTERN.test(type);
    });
    if (matches.length === 0) return result("NOT_CONFIGURED");
    if (matches.length !== 1 || typeof matches[0].disabled !== "boolean") return result("UNKNOWN");
    return result(matches[0].disabled ? "DISABLED" : "ENABLED");
  } catch {
    return result("UNKNOWN");
  }
}
