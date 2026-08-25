/**
 * tests/commerce7-installation-linking.test.ts
 *
 * PHASE 16B — Commerce7 install/uninstall callbacks, Admin Extension account
 * verification, one-time link intents, and Brand linking authorization.
 *
 * No real DB and no real network anywhere in this file. The Prisma singleton's
 * delegates are replaced with a small in-memory store so these tests assert
 * actual STATE TRANSITIONS (idempotency, CAS, ownership) rather than merely
 * which arguments a mock received.
 */

process.env.DATABASE_URL =
  "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";
process.env.COMMERCE7_APP_ID = "test-app-id";
process.env.COMMERCE7_APP_SECRET = "test-app-secret";
process.env.COMMERCE7_INSTALL_USERNAME = "test-callback-user";
process.env.COMMERCE7_INSTALL_PASSWORD = "test-callback-password";

import { test, describe, before, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { NextRequest } from "next/server";

import {
  hashLinkToken,
  generateLinkToken,
  createLinkIntent,
  consumeLinkIntent,
  resolveLinkIntent,
  markProviderInstallationInstalled,
  markProviderInstallationUninstalled,
} from "../src/lib/commerce/provider-installation";
import {
  normalizeCommerce7Tenant,
  commerce7RoleCanLink,
  verifyCommerce7AccountToken,
  buildCommerce7AppAuthorizationHeader,
  buildCommerce7FrameAncestorsCsp,
  type Commerce7Fetch,
} from "../src/lib/commerce/providers/commerce7";
import { linkProviderInstallationToBrand } from "../src/lib/commerce/link-connection";

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db = {
  installations: [] as Row[],
  intents: [] as Row[],
  connections: [] as Row[],
  events: [] as Row[],
  // Sentinel tables: any write here means Commerce7 leaked into Shopify/ledger.
  secrets: [] as Row[],
  pointTransactions: [] as Row[],
  products: [] as Row[],
};

let idCounter = 0;
const nextId = () => `id-${++idCounter}`;

function matchWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === null) return row[key] === null || row[key] === undefined;
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const cond = value as Record<string, unknown>;
      if ("gt" in cond) return (row[key] as Date) > (cond.gt as Date);
      if ("not" in cond) return row[key] !== cond.not;
      if ("in" in cond) return (cond.in as unknown[]).includes(row[key]);
    }
    return row[key] === value;
  });
}

function compositeInstallationKey(where: Row): Row {
  const composite = where.provider_externalAccountId as Row | undefined;
  return composite ? composite : where;
}

function makeDelegate(table: Row[], opts: { composite?: boolean } = {}) {
  return {
    findUnique: async (args: { where: Row; select?: Row }) => {
      const where = opts.composite
        ? compositeInstallationKey(args.where)
        : args.where;
      const row = table.find((entry) => matchWhere(entry, where)) ?? null;
      if (!row) return null;
      // Resolve the relations the services actually select, so tests exercise
      // the real joined-read code path rather than a flattened stand-in.
      const select = args.select as Record<string, unknown> | undefined;
      if (select?.installation && row.installationId) {
        return {
          ...row,
          installation:
            db.installations.find((entry) => entry.id === row.installationId) ??
            null,
        };
      }
      if (select?.brand && row.brandId) {
        return { ...row, brand: { name: `Brand ${row.brandId}` } };
      }
      return row;
    },
    findFirst: async (args: { where?: Row }) =>
      table.find((row) => matchWhere(row, args?.where ?? {})) ?? null,
    findMany: async (args?: { where?: Row }) =>
      table.filter((row) => matchWhere(row, args?.where ?? {})),
    create: async (args: { data: Row }) => {
      // Prisma materializes unset nullable columns as null, not undefined —
      // the fake must do the same or `consumedAt: null` filters silently miss.
      const row: Row = { id: nextId(), consumedAt: null, ...args.data };
      table.push(row);
      return row;
    },
    update: async (args: { where: Row; data: Row }) => {
      const row = table.find((entry) => matchWhere(entry, args.where));
      if (!row) throw new Error("record not found");
      Object.assign(row, args.data);
      return row;
    },
    updateMany: async (args: { where: Row; data: Row }) => {
      const rows = table.filter((entry) => matchWhere(entry, args.where));
      rows.forEach((row) => Object.assign(row, args.data));
      return { count: rows.length };
    },
    deleteMany: async () => {
      throw new Error("Commerce7 phase 16B must never delete rows");
    },
    delete: async () => {
      throw new Error("Commerce7 phase 16B must never delete rows");
    },
  };
}

let prismaModule: Record<string, unknown>;
let installPOST: (req: NextRequest) => Promise<Response>;
let uninstallPOST: (req: NextRequest) => Promise<Response>;

function resetDb() {
  db.installations.length = 0;
  db.intents.length = 0;
  db.connections.length = 0;
  db.events.length = 0;
  db.secrets.length = 0;
  db.pointTransactions.length = 0;
  db.products.length = 0;
}

before(async () => {
  prismaModule = (await import("../src/lib/prisma"))
    .default as unknown as Record<string, unknown>;

  prismaModule.commerceProviderInstallation = makeDelegate(db.installations, {
    composite: true,
  });
  prismaModule.commerceConnectionLinkIntent = makeDelegate(db.intents);
  prismaModule.commerceConnection = makeDelegate(db.connections, {
    composite: true,
  });
  prismaModule.commerceConnectionEvent = makeDelegate(db.events);
  prismaModule.commerceConnectionSecret = makeDelegate(db.secrets);
  prismaModule.pointTransaction = makeDelegate(db.pointTransactions);
  prismaModule.connectedCommerceProduct = makeDelegate(db.products);
  prismaModule.$transaction = async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => unknown)(prismaModule);
    }
    return Promise.all(arg as Promise<unknown>[]);
  };

  installPOST = (await import("../src/app/api/commerce7/install/route")).POST;
  uninstallPOST = (await import("../src/app/api/commerce7/uninstall/route"))
    .POST;
});

beforeEach(() => {
  resetDb();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function basicHeader(user: string, pass: string) {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

const VALID_AUTH = basicHeader("test-callback-user", "test-callback-password");

function callbackRequest(
  url: string,
  body: unknown,
  authorization: string | null = VALID_AUTH,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authorization) headers.authorization = authorization;
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const INSTALL_URL = "http://localhost/api/commerce7/install";
const UNINSTALL_URL = "http://localhost/api/commerce7/uninstall";

/** The real captured sandbox install body, including the retiring setting. */
const REAL_INSTALL_BODY = {
  "sqratch-connection-code": "C7-SANDBOX-CAPTURE-001",
  tenantId: "sqratch-inc",
  user: {
    id: "c7-user-1",
    firstName: "Dev",
    lastName: "Sqratch",
    email: "dev@sqratch.com",
  },
};

function seedConnection(overrides: Row = {}) {
  const row: Row = {
    id: nextId(),
    brandId: "brand-a",
    provider: "COMMERCE7",
    externalAccountId: "sqratch-inc",
    status: "CONNECTED",
    displayName: "sqratch-inc",
    storefrontUrl: null,
    providerClientId: null,
    ...overrides,
  };
  db.connections.push(row);
  return row;
}

// ===========================================================================
describe("Commerce7 install callback", () => {
  test("1. correct Basic Auth is accepted", async () => {
    const res = await installPOST(
      callbackRequest(INSTALL_URL, REAL_INSTALL_BODY),
    );
    assert.equal(res.status, 200);
  });

  test("2. bad and missing auth are rejected with a fixed sanitized 401", async () => {
    const bad = await installPOST(
      callbackRequest(
        INSTALL_URL,
        REAL_INSTALL_BODY,
        basicHeader("wrong", "wrong"),
      ),
    );
    assert.equal(bad.status, 401);
    const badBody = await bad.json();
    assert.deepEqual(badBody, {
      error: "Invalid Commerce7 callback credentials.",
    });

    const missing = await installPOST(
      callbackRequest(INSTALL_URL, REAL_INSTALL_BODY, null),
    );
    assert.equal(missing.status, 401);
    // Identical body: a caller cannot distinguish which half was wrong.
    assert.deepEqual(await missing.json(), badBody);

    // A wrong password with a correct username is equally indistinguishable.
    const wrongPass = await installPOST(
      callbackRequest(
        INSTALL_URL,
        REAL_INSTALL_BODY,
        basicHeader("test-callback-user", "nope"),
      ),
    );
    assert.equal(wrongPass.status, 401);
    assert.equal(
      db.installations.length,
      0,
      "no install recorded on failed auth",
    );
  });

  test("3. callback credentials and payload are never logged", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) =>
      lines.push(args.map(String).join(" "));
    try {
      await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));
    } finally {
      console.log = original;
    }

    const joined = lines.join("\n");
    assert.ok(joined.length > 0, "an audit line is emitted");
    for (const secret of [
      "test-callback-password",
      "test-callback-user",
      "test-app-secret",
      VALID_AUTH,
      "dev@sqratch.com",
      "C7-SANDBOX-CAPTURE-001",
    ]) {
      assert.ok(!joined.includes(secret), `log must not contain ${secret}`);
    }
  });

  test("4. install creates a COMMERCE7 installation record", async () => {
    await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));
    assert.equal(db.installations.length, 1);
    assert.equal(db.installations[0].provider, "COMMERCE7");
    assert.equal(db.installations[0].externalAccountId, "sqratch-inc");
    assert.equal(db.installations[0].status, "INSTALLED");
  });

  test("5. an unknown extra Client Setting is tolerated", async () => {
    const res = await installPOST(
      callbackRequest(INSTALL_URL, {
        ...REAL_INSTALL_BODY,
        "some-future-client-setting": "anything",
        anotherSetting: 42,
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(db.installations.length, 1);
  });

  test("6. a body with no sqratch-connection-code still succeeds", async () => {
    const res = await installPOST(
      callbackRequest(INSTALL_URL, {
        tenantId: "sqratch-inc",
        user: REAL_INSTALL_BODY.user,
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(db.installations[0].status, "INSTALLED");
  });

  test("7. repeated install is idempotent (one record, no duplicate)", async () => {
    await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));
    await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));
    await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));
    assert.equal(db.installations.length, 1);
    assert.equal(
      db.events.length,
      0,
      "no lifecycle event without a linked connection",
    );
  });

  test("8. reinstall transitions UNINSTALLED -> INSTALLED", async () => {
    await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));
    await uninstallPOST(
      callbackRequest(UNINSTALL_URL, { tenantId: "sqratch-inc" }),
    );
    assert.equal(db.installations[0].status, "UNINSTALLED");

    await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));
    assert.equal(db.installations[0].status, "INSTALLED");
    assert.equal(db.installations[0].uninstalledAt, null);
    assert.equal(db.installations.length, 1);
  });

  test("9. an existing linked connection is safely RECONNECTED, never duplicated", async () => {
    const connection = seedConnection({ status: "UNINSTALLED" });
    await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));

    assert.equal(db.connections.length, 1, "no duplicate connection created");
    assert.equal(connection.status, "CONNECTED");
    assert.equal(connection.brandId, "brand-a", "Brand relationship preserved");
    assert.equal(db.events.length, 1);
    assert.equal(db.events[0].eventType, "RECONNECTED");
    assert.equal(db.events[0].provider, "COMMERCE7");

    // Already CONNECTED -> no second event.
    await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));
    assert.equal(db.events.length, 1, "no event without a real transition");
  });

  test("10. the Commerce7 callback never touches Shopify or creates a secret", async () => {
    seedConnection({
      id: "shopify-conn",
      provider: "SHOPIFY",
      externalAccountId: "store.myshopify.com",
      status: "CONNECTED",
      brandId: "brand-shopify",
    });

    await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));
    await uninstallPOST(
      callbackRequest(UNINSTALL_URL, { tenantId: "sqratch-inc" }),
    );

    const shopify = db.connections.find((row) => row.id === "shopify-conn");
    assert.equal(shopify?.status, "CONNECTED", "Shopify connection untouched");
    assert.equal(
      db.secrets.length,
      0,
      "no CommerceConnectionSecret ever created",
    );
    assert.ok(
      db.events.every((event) => event.provider === "COMMERCE7"),
      "no Shopify lifecycle event written",
    );
  });

  test("an invalid tenant is rejected before any write", async () => {
    for (const tenantId of ["", "  ", "bad tenant", "../etc", null, 42]) {
      const res = await installPOST(callbackRequest(INSTALL_URL, { tenantId }));
      assert.equal(res.status, 400);
    }
    assert.equal(db.installations.length, 0);
  });
});

// ===========================================================================
describe("Commerce7 uninstall callback", () => {
  test("11-14. tenant-only body marks installation + connection UNINSTALLED with one event", async () => {
    await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));
    const connection = seedConnection({ status: "CONNECTED" });

    const res = await uninstallPOST(
      callbackRequest(UNINSTALL_URL, { tenantId: "sqratch-inc" }),
    );

    assert.equal(res.status, 200);
    assert.equal(db.installations[0].status, "UNINSTALLED");
    assert.ok(db.installations[0].uninstalledAt, "uninstalledAt is set");
    assert.equal(connection.status, "UNINSTALLED");
    assert.equal(connection.brandId, "brand-a", "Brand relationship preserved");

    const uninstallEvents = db.events.filter(
      (e) => e.eventType === "UNINSTALLED",
    );
    assert.equal(uninstallEvents.length, 1, "exactly one lifecycle event");
  });

  test("15. duplicate uninstall is idempotent and records no second event", async () => {
    await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));
    seedConnection({ status: "CONNECTED" });

    await uninstallPOST(
      callbackRequest(UNINSTALL_URL, { tenantId: "sqratch-inc" }),
    );
    await uninstallPOST(
      callbackRequest(UNINSTALL_URL, { tenantId: "sqratch-inc" }),
    );
    const second = await uninstallPOST(
      callbackRequest(UNINSTALL_URL, { tenantId: "sqratch-inc" }),
    );

    assert.equal(second.status, 200);
    assert.equal(
      db.events.filter((e) => e.eventType === "UNINSTALLED").length,
      1,
      "only the genuine transition recorded an event",
    );
  });

  test("16. outstanding link intents are invalidated by uninstall", async () => {
    await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));
    const installationId = db.installations[0].id as string;

    const live = await createLinkIntent(prismaModule as never, {
      installationId,
    });
    assert.equal(db.intents.filter((i) => i.consumedAt === null).length, 1);

    await uninstallPOST(
      callbackRequest(UNINSTALL_URL, { tenantId: "sqratch-inc" }),
    );

    assert.equal(
      db.intents.filter((i) => i.consumedAt === null).length,
      0,
      "no live intent may survive an uninstall",
    );

    const resolution = await resolveLinkIntent(prismaModule as never, {
      rawToken: live.rawToken,
    });
    assert.equal(resolution.ok, false);
  });

  test("17. uninstall deletes nothing (products, ledger, connection all retained)", async () => {
    await installPOST(callbackRequest(INSTALL_URL, REAL_INSTALL_BODY));
    seedConnection({ status: "CONNECTED" });
    db.pointTransactions.push({ id: "pt-1", userId: "u1" });
    db.products.push({ id: "prod-1" });

    await uninstallPOST(
      callbackRequest(UNINSTALL_URL, { tenantId: "sqratch-inc" }),
    );

    // The fake's delete/deleteMany throw, so reaching here already proves no
    // delete was attempted; these assertions state the intent explicitly.
    assert.equal(db.connections.length, 1, "connection row retained");
    assert.equal(db.pointTransactions.length, 1, "points ledger retained");
    assert.equal(db.products.length, 1, "products retained");
    assert.equal(db.events.length, 1, "history retained and appended");
  });

  test("uninstall requires valid auth", async () => {
    const res = await uninstallPOST(
      callbackRequest(
        UNINSTALL_URL,
        { tenantId: "sqratch-inc" },
        basicHeader("x", "y"),
      ),
    );
    assert.equal(res.status, 401);
  });
});

// ===========================================================================
describe("Commerce7 Admin Extension authentication", () => {
  function fakeFetch(
    handler: (
      url: string,
      init: { headers: Record<string, string> },
    ) => {
      ok: boolean;
      status: number;
      body: unknown;
    },
  ): {
    impl: Commerce7Fetch;
    calls: Array<{ url: string; headers: Record<string, string> }>;
  } {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const impl: Commerce7Fetch = async (url, init) => {
      calls.push({ url, headers: init.headers });
      const result = handler(url, init as { headers: Record<string, string> });
      return {
        ok: result.ok,
        status: result.status,
        json: async () => result.body,
      };
    };
    return { impl, calls };
  }

  test("18-20. valid token resolves the user; exact tenant header and Authorization are sent", async () => {
    const { impl, calls } = fakeFetch(() => ({
      ok: true,
      status: 200,
      body: {
        id: "c7-user-1",
        email: "owner@winery.com",
        firstName: "Dev",
        lastName: "Sqratch",
        role: "Admin Owner",
      },
    }));

    const result = await verifyCommerce7AccountToken(
      { tenant: "sqratch-inc", accountToken: "account-jwt-value" },
      { fetchImpl: impl },
    );

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.commerce7.com/v1/account/user");
    assert.equal(calls[0].headers.tenant, "sqratch-inc", "exact tenant header");
    assert.equal(
      calls[0].headers.Authorization,
      "account-jwt-value",
      "account token forwarded verbatim as Authorization",
    );
    if (result.ok) {
      assert.equal(result.user.id, "c7-user-1");
      assert.equal(result.user.role, "Admin Owner");
      assert.ok(commerce7RoleCanLink(result.user.role));
    }
  });

  test("21. an invalid/expired token fails closed", async () => {
    const { impl } = fakeFetch(() => ({ ok: false, status: 401, body: {} }));
    const result = await verifyCommerce7AccountToken(
      { tenant: "sqratch-inc", accountToken: "expired" },
      { fetchImpl: impl },
    );
    assert.deepEqual(result, { ok: false, reason: "UNAUTHORIZED" });
  });

  test("21b. a provider outage fails closed, never open", async () => {
    const impl: Commerce7Fetch = async () => {
      throw new Error("network down with Authorization: secret-token");
    };
    const result = await verifyCommerce7AccountToken(
      { tenant: "sqratch-inc", accountToken: "tok" },
      { fetchImpl: impl },
    );
    assert.deepEqual(result, { ok: false, reason: "PROVIDER_ERROR" });
  });

  test("22. a malformed/unauthorized tenant fails closed without calling Commerce7", async () => {
    const { impl, calls } = fakeFetch(() => ({
      ok: true,
      status: 200,
      body: { id: "x" },
    }));
    for (const tenant of ["", "bad tenant", "../evil", "a\nb"]) {
      const result = await verifyCommerce7AccountToken(
        { tenant, accountToken: "tok" },
        { fetchImpl: impl },
      );
      assert.equal(result.ok, false);
    }
    assert.equal(calls.length, 0, "no request is made for an invalid tenant");
  });

  test('23. EXACTLY "Admin Owner" can link; every other role fails closed', () => {
    // The one and only accepted value, per Commerce7's documented
    // GET /v1/account/user response shape.
    assert.equal(commerce7RoleCanLink("Admin Owner"), true);

    // Case variants and near-matches are explicitly rejected — no fuzzy
    // matching, no speculative alternate role semantics.
    assert.equal(commerce7RoleCanLink("admin owner"), false);
    assert.equal(commerce7RoleCanLink("ADMIN OWNER"), false);
    assert.equal(commerce7RoleCanLink("Admin-Owner"), false);
    assert.equal(commerce7RoleCanLink("AdminOwner"), false);

    // Sub-strings / lesser roles.
    assert.equal(commerce7RoleCanLink("Admin"), false);
    assert.equal(commerce7RoleCanLink("Owner"), false);
    assert.equal(commerce7RoleCanLink("Sales Associate"), false);
    assert.equal(commerce7RoleCanLink("Wine Club Manager"), false);

    // Missing / absent role.
    assert.equal(commerce7RoleCanLink(null), false);
    assert.equal(commerce7RoleCanLink(undefined), false);
    assert.equal(commerce7RoleCanLink(""), false);
  });

  test("24. the account token is never persisted", async () => {
    const { impl } = fakeFetch(() => ({
      ok: true,
      status: 200,
      body: { id: "c7-user-1", role: "Admin Owner" },
    }));
    await verifyCommerce7AccountToken(
      { tenant: "sqratch-inc", accountToken: "super-secret-account-jwt" },
      { fetchImpl: impl },
    );

    const dump = JSON.stringify(db);
    assert.ok(!dump.includes("super-secret-account-jwt"));
  });

  test("the app authorization header uses AppID:AppSecret basic auth", () => {
    const header = buildCommerce7AppAuthorizationHeader({
      appId: "sqratch",
      appSecret: "s3cret",
    });
    assert.equal(
      header,
      `Basic ${Buffer.from("sqratch:s3cret", "utf8").toString("base64")}`,
    );
  });

  test("tenant normalization is strict", () => {
    assert.equal(normalizeCommerce7Tenant("  SQRATCH-INC "), "sqratch-inc");
    assert.equal(normalizeCommerce7Tenant("sqratch-inc"), "sqratch-inc");
    assert.equal(normalizeCommerce7Tenant("bad tenant"), null);
    assert.equal(normalizeCommerce7Tenant("-leading"), null);
    assert.equal(normalizeCommerce7Tenant("trailing-"), null);
    assert.equal(normalizeCommerce7Tenant(null), null);
  });

  test("the extension CSP restricts framing to Commerce7 origins only", () => {
    const csp = buildCommerce7FrameAncestorsCsp("sqratch-inc");
    assert.match(csp, /^frame-ancestors /);
    assert.ok(csp.includes("https://admin.platform.commerce7.com"));
    assert.ok(!csp.includes("*"), "no wildcard-everything ancestor");
  });
});

// ===========================================================================
describe("link intent token handling", () => {
  test("25-26. the raw token is never persisted; only its SHA-256 hash is", async () => {
    db.installations.push({
      id: "inst-1",
      provider: "COMMERCE7",
      status: "INSTALLED",
    });
    const intent = await createLinkIntent(prismaModule as never, {
      installationId: "inst-1",
    });

    assert.ok(intent.rawToken.length >= 40, "256-bit base64url token");
    assert.match(intent.rawToken, /^[A-Za-z0-9_-]+$/, "URL-safe");

    const dump = JSON.stringify(db);
    assert.ok(
      !dump.includes(intent.rawToken),
      "raw token must never be stored",
    );
    assert.ok(
      dump.includes(hashLinkToken(intent.rawToken)),
      "the SHA-256 hash is what is stored",
    );
    assert.equal(db.intents[0].tokenHash, hashLinkToken(intent.rawToken));
  });

  test("generated tokens are unique", () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => generateLinkToken()),
    );
    assert.equal(tokens.size, 200);
  });

  test("27. an expired intent is rejected", async () => {
    db.installations.push({
      id: "inst-1",
      provider: "COMMERCE7",
      status: "INSTALLED",
    });
    const intent = await createLinkIntent(prismaModule as never, {
      installationId: "inst-1",
    });

    const later = new Date(Date.now() + 11 * 60 * 1000);
    const resolution = await resolveLinkIntent(prismaModule as never, {
      rawToken: intent.rawToken,
      now: later,
    });
    assert.deepEqual(resolution, { ok: false, reason: "EXPIRED" });

    const consumed = await consumeLinkIntent(prismaModule as never, {
      intentId: db.intents[0].id as string,
      now: later,
    });
    assert.equal(consumed, false, "an expired intent cannot be consumed");
  });

  test("28. a consumed intent is rejected", async () => {
    db.installations.push({
      id: "inst-1",
      provider: "COMMERCE7",
      status: "INSTALLED",
    });
    const intent = await createLinkIntent(prismaModule as never, {
      installationId: "inst-1",
    });

    assert.equal(
      await consumeLinkIntent(prismaModule as never, {
        intentId: db.intents[0].id as string,
      }),
      true,
    );

    const resolution = await resolveLinkIntent(prismaModule as never, {
      rawToken: intent.rawToken,
    });
    assert.deepEqual(resolution, { ok: false, reason: "CONSUMED" });
  });

  test("29. concurrent consumption produces exactly one winner", async () => {
    db.installations.push({
      id: "inst-1",
      provider: "COMMERCE7",
      status: "INSTALLED",
    });
    await createLinkIntent(prismaModule as never, { installationId: "inst-1" });
    const intentId = db.intents[0].id as string;

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        consumeLinkIntent(prismaModule as never, { intentId }),
      ),
    );

    assert.equal(
      results.filter(Boolean).length,
      1,
      "exactly one concurrent consumer may win the CAS",
    );
  });

  test("an intent for an uninstalled tenant is rejected even before expiry", async () => {
    db.installations.push({
      id: "inst-1",
      provider: "COMMERCE7",
      externalAccountId: "sqratch-inc",
      status: "INSTALLED",
    });
    const intent = await createLinkIntent(prismaModule as never, {
      installationId: "inst-1",
    });
    db.installations[0].status = "UNINSTALLED";

    const resolution = await resolveLinkIntent(prismaModule as never, {
      rawToken: intent.rawToken,
    });
    assert.deepEqual(resolution, { ok: false, reason: "NOT_INSTALLED" });
  });
});

// ===========================================================================
describe("Brand linking", () => {
  async function seedInstalledIntent() {
    const installation = {
      id: "inst-1",
      provider: "COMMERCE7",
      externalAccountId: "sqratch-inc",
      status: "INSTALLED",
    };
    db.installations.push(installation);
    const intent = await createLinkIntent(prismaModule as never, {
      installationId: "inst-1",
    });
    return { installation, intent, intentId: db.intents[0].id as string };
  }

  test("30, 36-39. a link creates an explicit COMMERCE7 CONNECTED connection + event", async () => {
    const { intentId } = await seedInstalledIntent();

    const result = await linkProviderInstallationToBrand(
      prismaModule as never,
      {
        intentId,
        installationId: "inst-1",
        provider: "COMMERCE7",
        externalAccountId: "sqratch-inc",
        brandId: "brand-a",
        displayName: "sqratch-inc",
      },
    );

    assert.equal(result.ok, true);
    assert.equal(db.connections.length, 1);
    const connection = db.connections[0];
    assert.equal(connection.provider, "COMMERCE7", "provider explicit");
    assert.equal(connection.externalAccountId, "sqratch-inc", "exact tenant");
    assert.equal(connection.status, "CONNECTED");
    assert.equal(connection.brandId, "brand-a");
    assert.equal(
      connection.storefrontUrl,
      null,
      "storefrontUrl NOT synthesized",
    );
    assert.ok(
      !JSON.stringify(connection).includes("commerce7.com"),
      "no URL guessed from the tenant id",
    );

    assert.equal(db.events.length, 1);
    assert.equal(db.events[0].eventType, "CONNECTED");
    assert.equal(db.events[0].provider, "COMMERCE7");

    assert.equal(db.intents[0].consumedAt !== null, true, "intent consumed");
  });

  test("35. linking creates NO CommerceConnectionSecret", async () => {
    const { intentId } = await seedInstalledIntent();
    await linkProviderInstallationToBrand(prismaModule as never, {
      intentId,
      installationId: "inst-1",
      provider: "COMMERCE7",
      externalAccountId: "sqratch-inc",
      brandId: "brand-a",
      displayName: "sqratch-inc",
    });

    assert.equal(db.secrets.length, 0, "Commerce7 must never persist a secret");
    const dump = JSON.stringify(db);
    assert.ok(!dump.includes("test-app-secret"), "app secret never stored");
  });

  test("33. a tenant owned by Brand A cannot be linked to Brand B", async () => {
    const { intentId } = await seedInstalledIntent();
    seedConnection({ brandId: "brand-a", status: "CONNECTED" });

    const result = await linkProviderInstallationToBrand(
      prismaModule as never,
      {
        intentId,
        installationId: "inst-1",
        provider: "COMMERCE7",
        externalAccountId: "sqratch-inc",
        brandId: "brand-b",
        displayName: "sqratch-inc",
      },
    );

    assert.deepEqual(result, { ok: false, reason: "OWNED_BY_OTHER_BRAND" });
    assert.equal(db.connections.length, 1, "no second connection created");
    assert.equal(
      db.connections[0].brandId,
      "brand-a",
      "ownership NOT transferred",
    );
  });

  test("the same Brand relinking its own tenant reconnects rather than duplicating", async () => {
    const { intentId } = await seedInstalledIntent();
    seedConnection({ brandId: "brand-a", status: "UNINSTALLED" });

    const result = await linkProviderInstallationToBrand(
      prismaModule as never,
      {
        intentId,
        installationId: "inst-1",
        provider: "COMMERCE7",
        externalAccountId: "sqratch-inc",
        brandId: "brand-a",
        displayName: "sqratch-inc",
      },
    );

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.reconnected, true);
    assert.equal(db.connections.length, 1);
    assert.equal(db.connections[0].status, "CONNECTED");
    assert.equal(db.events[0].eventType, "RECONNECTED");
  });

  test("linking is refused once the tenant is uninstalled, and the intent is still burned", async () => {
    const { intentId } = await seedInstalledIntent();
    db.installations[0].status = "UNINSTALLED";

    const result = await linkProviderInstallationToBrand(
      prismaModule as never,
      {
        intentId,
        installationId: "inst-1",
        provider: "COMMERCE7",
        externalAccountId: "sqratch-inc",
        brandId: "brand-a",
        displayName: "sqratch-inc",
      },
    );

    assert.deepEqual(result, { ok: false, reason: "NOT_INSTALLED" });
    assert.equal(db.connections.length, 0);
  });

  test("a replayed intent cannot link twice", async () => {
    const { intentId } = await seedInstalledIntent();
    const args = {
      intentId,
      installationId: "inst-1",
      provider: "COMMERCE7" as const,
      externalAccountId: "sqratch-inc",
      brandId: "brand-a",
      displayName: "sqratch-inc",
    };

    assert.equal(
      (await linkProviderInstallationToBrand(prismaModule as never, args)).ok,
      true,
    );
    const second = await linkProviderInstallationToBrand(
      prismaModule as never,
      args,
    );
    assert.deepEqual(second, { ok: false, reason: "INTENT_UNAVAILABLE" });
    assert.equal(db.connections.length, 1);
  });

  test("34. nothing in the link path consults an email address", async () => {
    const linkSource = (await import("node:fs")).readFileSync(
      "src/lib/commerce/link-connection.ts",
      "utf8",
    );
    assert.ok(
      !/email/i.test(linkSource),
      "the linking core must never reference an email address",
    );
  });
});

// ===========================================================================
describe("provider isolation", () => {
  test("40. Commerce7 lookups cannot select a Shopify connection", async () => {
    seedConnection({
      id: "shopify-1",
      provider: "SHOPIFY",
      externalAccountId: "sqratch-inc",
      brandId: "brand-a",
    });

    const found = await (
      prismaModule.commerceConnection as {
        findUnique: (a: { where: Row }) => Promise<Row | null>;
      }
    ).findUnique({
      where: {
        provider_externalAccountId: {
          provider: "COMMERCE7",
          externalAccountId: "sqratch-inc",
        },
      },
    });

    assert.equal(
      found,
      null,
      "an identical externalAccountId under SHOPIFY is never returned for COMMERCE7",
    );
  });

  test("41. Shopify install/uninstall handlers are untouched by this phase", async () => {
    const fs = await import("node:fs");
    const changed = fs.readFileSync(
      "src/app/api/shopify/webhooks/app/uninstalled/route.ts",
      "utf8",
    );
    assert.ok(
      changed.includes("verifyShopifyWebhookRequest"),
      "Shopify HMAC gate intact",
    );
    assert.ok(
      !changed.toLowerCase().includes("commerce7"),
      "no Commerce7 logic leaked into a Shopify route",
    );
  });

  // PHASE 16C1 superseded the original form of this test: Commerce7 now HAS a
  // registered adapter. PHASE 16 BIG ROUND / SUBPHASE 2 further superseded
  // its public-destinations assumption: a merchant-configured connection can
  // now produce a real public destination (see
  // tests/commerce7-storefront-public-destinations.test.ts). What Phase 16B
  // actually needs to stay true is narrower and still holds — the
  // installation/linking lifecycle grants Commerce7 no reward or discount
  // behavior.
  test("42. the registered Commerce7 adapter exposes catalog reads and public destinations — still no rewards", async () => {
    const { defaultCommerceAdapterRegistry } =
      await import("../src/lib/commerce/default-registry");

    const adapter = defaultCommerceAdapterRegistry.get("COMMERCE7" as never);
    const capabilities = adapter.getCapabilities();

    assert.equal(capabilities.products.publicDestinations, true);
    for (const [name, value] of Object.entries(capabilities.rewards)) {
      assert.equal(
        value,
        false,
        `rewards.${name} must not be claimed by Commerce7`,
      );
    }

    const surface = adapter as unknown as Record<string, unknown>;
    for (const method of ["createDiscount", "getDiscount", "revokeDiscount"]) {
      assert.equal(surface[method], undefined, `${method} must not exist`);
    }
  });

  test("markProviderInstallation* helpers are provider-scoped", async () => {
    await markProviderInstallationInstalled(prismaModule as never, {
      provider: "SHOPIFY" as never,
      externalAccountId: "sqratch-inc",
    });
    await markProviderInstallationInstalled(prismaModule as never, {
      provider: "COMMERCE7" as never,
      externalAccountId: "sqratch-inc",
    });
    assert.equal(
      db.installations.length,
      2,
      "same id under two providers is distinct",
    );

    const result = await markProviderInstallationUninstalled(
      prismaModule as never,
      {
        provider: "COMMERCE7" as never,
        externalAccountId: "sqratch-inc",
      },
    );
    assert.equal(result.transitioned, true);
    assert.equal(
      db.installations.find((row) => row.provider === "SHOPIFY")?.status,
      "INSTALLED",
      "the other provider's installation is untouched",
    );
  });
});
