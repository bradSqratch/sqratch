import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getShopifyThemeTrackingReadiness } from "../src/lib/commerce/providers/shopify-theme-readiness";
import { SQRATCH_ATTRIBUTION_EMBED_BLOCK_HANDLE } from "../src/lib/commerce/shopify-app-embed";

const input = {
  brandId: "brand-1",
  shopDomain: "store.myshopify.com",
  apiKey: "0123456789abcdef0123456789abcdef",
  grantedScopes: ["read_products", "read_themes"],
};

function fetchFor(settings: unknown, status = 200): typeof fetch {
  return async (url) =>
    new Response(
      String(url).includes("themes.json")
        ? JSON.stringify({ themes: [{ id: 42, role: "main" }] })
        : JSON.stringify({ asset: { value: JSON.stringify(settings) } }),
      { status, headers: { "content-type": "application/json" } },
    );
}

const token = async () => ({ ok: true as const, accessToken: "opaque-test-token" });

/**
 * Shopify's OWN documented app-embed block type, verbatim from
 * https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration
 * ("Detecting app embed blocks") — the worked example there is a DIFFERENT
 * app ("faceforms-better-pop-ups"), reproduced here to prove the matcher
 * generalizes to SQRATCH's own block handle rather than to that literal
 * example string. The middle segment is the SHOPIFY APP'S HANDLE (a slug),
 * never a client_id/api_key — this is the exact distinction the fixed
 * matcher must respect.
 */
function documentedBlockType(appHandle: string, blockHandle: string, uuid: string): string {
  return `shopify://apps/${appHandle}/blocks/${blockHandle}/${uuid}`;
}

const SQRATCH_TYPE_UNDER_PRODUCTION_APP = documentedBlockType(
  "sqratch",
  SQRATCH_ATTRIBUTION_EMBED_BLOCK_HANDLE,
  "f2173231-e611-461d-884b-bd8e6cc2ded4",
);
const SQRATCH_TYPE_UNDER_CUSTOM_APP = documentedBlockType(
  "sqratch-custom-app-test",
  SQRATCH_ATTRIBUTION_EMBED_BLOCK_HANDLE,
  "cadef24e-ecf6-49f8-a544-6bb5186af219",
);

describe("app-embed detection matches Shopify's documented settings_data.json format", () => {
  test("a live ENABLED embed under the PRODUCTION app handle is detected as ENABLED", async () => {
    const readiness = await getShopifyThemeTrackingReadiness(input, {
      getAccessToken: token,
      fetchImpl: fetchFor({
        current: {
          blocks: { "17878678986028907411": { type: SQRATCH_TYPE_UNDER_PRODUCTION_APP, disabled: false, settings: {} } },
        },
      }),
    });
    assert.equal(readiness.state, "ENABLED", "this is the exact live-QA regression: a real enabled embed must read ENABLED");
  });

  test("a live ENABLED embed under the CUSTOM TEST app handle is ALSO detected as ENABLED — no hardcoded app identity", async () => {
    const readiness = await getShopifyThemeTrackingReadiness(input, {
      getAccessToken: token,
      fetchImpl: fetchFor({
        current: {
          blocks: { abc123: { type: SQRATCH_TYPE_UNDER_CUSTOM_APP, disabled: false, settings: {} } },
        },
      }),
    });
    assert.equal(
      readiness.state,
      "ENABLED",
      "custom.toml and toml are two separate Shopify app registrations with two different app handles — both must be detected without hardcoding either",
    );
  });

  test("a DISABLED embed (present, toggled off) is detected as DISABLED", async () => {
    const readiness = await getShopifyThemeTrackingReadiness(input, {
      getAccessToken: token,
      fetchImpl: fetchFor({
        current: { blocks: { abc: { type: SQRATCH_TYPE_UNDER_PRODUCTION_APP, disabled: true, settings: {} } } },
      }),
    });
    assert.equal(readiness.state, "DISABLED");
  });

  test("never-enabled: `blocks` key entirely absent from `current` is NOT_CONFIGURED, not UNKNOWN", async () => {
    const readiness = await getShopifyThemeTrackingReadiness(input, {
      getAccessToken: token,
      fetchImpl: fetchFor({ current: { sections: {} } }),
    });
    assert.equal(readiness.state, "NOT_CONFIGURED");
  });

  test("never-enabled: `blocks` present but empty is NOT_CONFIGURED", async () => {
    const readiness = await getShopifyThemeTrackingReadiness(input, {
      getAccessToken: token,
      fetchImpl: fetchFor({ current: { blocks: {} } }),
    });
    assert.equal(readiness.state, "NOT_CONFIGURED");
  });

  test("blocks present, but only OTHER apps' embeds — never matched, still NOT_CONFIGURED", async () => {
    const readiness = await getShopifyThemeTrackingReadiness(input, {
      getAccessToken: token,
      fetchImpl: fetchFor({
        current: {
          blocks: {
            other1: { type: documentedBlockType("faceforms-better-pop-ups", "app-embed", "f2173231-e611-461d-884b-bd8e6cc2ded4"), disabled: false },
            other2: { type: documentedBlockType("some-other-app", "widget", "aaaa-bbbb"), disabled: false },
          },
        },
      }),
    });
    assert.equal(readiness.state, "NOT_CONFIGURED");
  });

  test("the matcher never depends on api_key: the same fixture with a DIFFERENT api_key input still detects ENABLED", async () => {
    const readiness = await getShopifyThemeTrackingReadiness(
      { ...input, apiKey: "ffffffffffffffffffffffffffffffff" },
      {
        getAccessToken: token,
        fetchImpl: fetchFor({
          current: { blocks: { abc: { type: SQRATCH_TYPE_UNDER_PRODUCTION_APP, disabled: false, settings: {} } } },
        }),
      },
    );
    assert.equal(readiness.state, "ENABLED", "api_key must play no role in block-type matching — only the block handle segment does");
  });

  test("no hardcoded custom-app extension UUID: an arbitrary, never-seen-before block instance UUID still matches", async () => {
    const readiness = await getShopifyThemeTrackingReadiness(input, {
      getAccessToken: token,
      fetchImpl: fetchFor({
        current: {
          blocks: {
            xyz: { type: documentedBlockType("sqratch", SQRATCH_ATTRIBUTION_EMBED_BLOCK_HANDLE, "99999999-0000-1111-2222-333333333333"), disabled: false },
          },
        },
      }),
    });
    assert.equal(readiness.state, "ENABLED");
  });

  test("source-level lock: the matching REGEX itself is built only from the block-handle constant, never from apiKey or a literal UUID", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/commerce/providers/shopify-theme-readiness.ts"),
      "utf8",
    );
    // Scoped to the executable regex declaration only (not the surrounding
    // prose, which legitimately quotes Shopify's own worked example and the
    // prior bug's shape for documentation purposes).
    const patternDeclaration = /const APP_EMBED_BLOCK_TYPE_PATTERN = new RegExp\(\s*[\s\S]*?\);/.exec(source);
    assert.ok(patternDeclaration, "expected to find the APP_EMBED_BLOCK_TYPE_PATTERN declaration");
    const declarationText = patternDeclaration![0];
    assert.doesNotMatch(declarationText, /apiKey/, "the matching regex must never be built from apiKey");
    assert.doesNotMatch(
      declarationText,
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      "the matching regex must never embed a literal extension/block-instance UUID",
    );
    assert.match(declarationText, /SQRATCH_ATTRIBUTION_EMBED_BLOCK_HANDLE/);
  });
});

test("PERMISSION_REQUIRED when read_themes is not granted, regardless of live embed state", async () => {
  const readiness = await getShopifyThemeTrackingReadiness(
    { ...input, grantedScopes: ["read_products"] },
    { getAccessToken: token, fetchImpl: fetchFor({ current: { blocks: { abc: { type: SQRATCH_TYPE_UNDER_PRODUCTION_APP, disabled: false } } } }) },
  );
  assert.equal(readiness.state, "PERMISSION_REQUIRED");
});

describe("API, parse, and ambiguous-data failures are UNKNOWN — never DISABLED or NOT_CONFIGURED", () => {
  test("a non-200 API response is UNKNOWN", async () => {
    const apiFailure = await getShopifyThemeTrackingReadiness(input, { getAccessToken: token, fetchImpl: fetchFor({}, 500) });
    assert.equal(apiFailure.state, "UNKNOWN");
  });

  test("malformed JSON in the asset value is UNKNOWN", async () => {
    const malformed: typeof fetch = async (url) =>
      new Response(
        String(url).includes("themes.json") ? JSON.stringify({ themes: [{ id: 1, role: "main" }] }) : JSON.stringify({ asset: { value: "{" } }),
        { status: 200 },
      );
    assert.equal((await getShopifyThemeTrackingReadiness(input, { getAccessToken: token, fetchImpl: malformed })).state, "UNKNOWN");
  });

  test("no main theme found is UNKNOWN", async () => {
    const noMain: typeof fetch = async () => new Response(JSON.stringify({ themes: [] }), { status: 200 });
    assert.equal((await getShopifyThemeTrackingReadiness(input, { getAccessToken: token, fetchImpl: noMain })).state, "UNKNOWN");
  });

  test("`blocks` present but shaped as an array (malformed) is UNKNOWN, not NOT_CONFIGURED", async () => {
    const readiness = await getShopifyThemeTrackingReadiness(input, {
      getAccessToken: token,
      fetchImpl: fetchFor({ current: { blocks: [] } }),
    });
    assert.equal(readiness.state, "UNKNOWN");
  });

  test("`blocks` present but null (malformed) is UNKNOWN, not NOT_CONFIGURED", async () => {
    const readiness = await getShopifyThemeTrackingReadiness(input, {
      getAccessToken: token,
      fetchImpl: fetchFor({ current: { blocks: null } }),
    });
    assert.equal(readiness.state, "UNKNOWN");
  });

  test("two matching block entries (ambiguous) is UNKNOWN, never guessed", async () => {
    const readiness = await getShopifyThemeTrackingReadiness(input, {
      getAccessToken: token,
      fetchImpl: fetchFor({
        current: {
          blocks: {
            a: { type: SQRATCH_TYPE_UNDER_PRODUCTION_APP, disabled: false },
            b: { type: SQRATCH_TYPE_UNDER_CUSTOM_APP, disabled: true },
          },
        },
      }),
    });
    assert.equal(readiness.state, "UNKNOWN");
  });

  test("a matched block with a missing/non-boolean `disabled` field is UNKNOWN, never assumed ENABLED", async () => {
    const readiness = await getShopifyThemeTrackingReadiness(input, {
      getAccessToken: token,
      fetchImpl: fetchFor({
        current: { blocks: { abc: { type: SQRATCH_TYPE_UNDER_PRODUCTION_APP } } },
      }),
    });
    assert.equal(readiness.state, "UNKNOWN");
  });

  test("a getAccessToken throw is UNKNOWN", async () => {
    const throwingToken = async () => {
      throw new Error("boom");
    };
    const readiness = await getShopifyThemeTrackingReadiness(input, { getAccessToken: throwingToken, fetchImpl: fetchFor({ current: { blocks: {} } }) });
    assert.equal(readiness.state, "UNKNOWN");
  });

  test("a failed (ok:false) token result is UNKNOWN", async () => {
    const badToken = async () => ({ ok: false as const, reason: "NEEDS_RECONNECT" as const });
    const readiness = await getShopifyThemeTrackingReadiness(input, { getAccessToken: badToken, fetchImpl: fetchFor({ current: { blocks: {} } }) });
    assert.equal(readiness.state, "UNKNOWN");
  });
});

test("theme settings content is not persisted or returned", async () => {
  let requested = "";
  const fetchImpl: typeof fetch = async (url) => {
    requested = String(url);
    return fetchFor({ current: { blocks: {} } })(url);
  };
  const readiness = await getShopifyThemeTrackingReadiness(input, { getAccessToken: token, fetchImpl });
  assert.equal(readiness.provider, "SHOPIFY");
  assert.match(requested, /settings_data\.json/);
  assert.deepEqual(Object.keys(readiness), ["provider", "state"]);
});
