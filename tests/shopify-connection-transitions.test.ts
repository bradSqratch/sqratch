import assert from "node:assert/strict";
import { test } from "node:test";
import { CommerceProvider, type Prisma } from "@prisma/client";
import { recordCommerceConnectionEvent } from "../src/lib/commerce/connection-lifecycle";

import {
  deactivateAllBrandRewardOffers,
  recordShopifyConnectionInstall,
  recordShopifyConnectionLoss,
  resolveInstallConnectionEventType,
  resolveLastKnownShopDomain,
} from "../src/lib/shopify-connection-transitions";

type Call = { args: unknown[] };

function makeFakeTx() {
  const calls: { updateMany: Call[]; create: Call[]; findFirst: Call[] } = {
    updateMany: [],
    create: [],
    findFirst: [],
  };

  const tx = {
    brandRewardOffer: {
      updateMany: async (...args: unknown[]) => {
        calls.updateMany.push({ args });
        return { count: 1 };
      },
    },
    commerceConnectionEvent: {
      create: async (...args: unknown[]) => {
        calls.create.push({ args });
        return {};
      },
      findFirst: async (...args: unknown[]) => {
        calls.findFirst.push({ args });
        return null;
      },
    },
  } as unknown as Prisma.TransactionClient;

  return { tx, calls };
}

test("resolveInstallConnectionEventType: no previous domain is CONNECTED", () => {
  assert.equal(
    resolveInstallConnectionEventType(null, "shop.myshopify.com"),
    "CONNECTED",
  );
});

test("resolveInstallConnectionEventType: identical normalized domain is RECONNECTED", () => {
  assert.equal(
    resolveInstallConnectionEventType(
      "Shop.MyShopify.com",
      "shop.myshopify.com",
    ),
    "RECONNECTED",
  );
});

test("resolveInstallConnectionEventType: a different domain is RELINKED", () => {
  assert.equal(
    resolveInstallConnectionEventType(
      "old-shop.myshopify.com",
      "new-shop.myshopify.com",
    ),
    "RELINKED",
  );
});

test("deactivateAllBrandRewardOffers sets isActive false for the brand and never true", async () => {
  const { tx, calls } = makeFakeTx();
  await deactivateAllBrandRewardOffers(tx, "brand-1");

  assert.equal(calls.updateMany.length, 1);
  const [args] = calls.updateMany[0].args as [
    { where: { brandId: string }; data: { isActive: boolean } },
  ];
  assert.equal(args.where.brandId, "brand-1");
  assert.equal(args.data.isActive, false);
});

test("recordShopifyConnectionLoss deactivates offers and records one event atomically", async () => {
  const { tx, calls } = makeFakeTx();

  await recordShopifyConnectionLoss(tx, {
    brandId: "brand-1",
    eventType: "DISCONNECTED",
    snapshot: {
      shopDomain: "shop.myshopify.com",
      currencyCode: "CAD",
      shopifyClientId: "client-1",
    },
  });

  assert.equal(calls.updateMany.length, 1, "deactivates offers exactly once");
  assert.equal(calls.create.length, 1, "records exactly one connection event");

  const [eventArgs] = calls.create[0].args as [
    {
      data: {
        brandId: string;
        provider: string;
        eventType: string;
        externalAccountId: string | null;
        previousExternalAccountId: string | null;
        currencyCode: string | null;
        previousCurrencyCode: string | null;
        providerClientId: string | null;
      };
    },
  ];

  assert.equal(eventArgs.data.brandId, "brand-1");
  assert.equal(eventArgs.data.provider, "SHOPIFY");
  assert.equal(eventArgs.data.eventType, "DISCONNECTED");
  assert.equal(eventArgs.data.externalAccountId, "shop.myshopify.com");
  assert.equal(eventArgs.data.currencyCode, "CAD");
  assert.equal(eventArgs.data.providerClientId, "client-1");
  // A loss event has no "previous, different" domain concept — that only
  // applies to install-time CONNECTED/RECONNECTED/RELINKED transitions.
  assert.equal(eventArgs.data.previousExternalAccountId, null);
  assert.equal(eventArgs.data.previousCurrencyCode, null);
});

test("recordShopifyConnectionInstall records CONNECTED/RECONNECTED/RELINKED with previous-domain context and never reactivates offers", async () => {
  const { tx, calls } = makeFakeTx();

  await recordShopifyConnectionInstall(tx, {
    brandId: "brand-1",
    eventType: "RELINKED",
    shopDomain: "New-Shop.MyShopify.com",
    previousShopDomain: "old-shop.myshopify.com",
    currencyCode: "USD",
    previousCurrencyCode: "CAD",
    shopifyClientId: "client-2",
  });

  assert.equal(calls.updateMany.length, 1);
  const [deactivateArgs] = calls.updateMany[0].args as [
    { data: { isActive: boolean } },
  ];
  assert.equal(
    deactivateArgs.data.isActive,
    false,
    "install/reconnect/relink never sets isActive true",
  );

  assert.equal(calls.create.length, 1);
  const [eventArgs] = calls.create[0].args as [
    {
      data: {
        provider: string;
        eventType: string;
        externalAccountId: string;
        previousExternalAccountId: string | null;
        currencyCode: string | null;
        previousCurrencyCode: string | null;
      };
    },
  ];
  assert.equal(eventArgs.data.provider, "SHOPIFY");
  assert.equal(eventArgs.data.eventType, "RELINKED");
  assert.equal(eventArgs.data.externalAccountId, "new-shop.myshopify.com");
  assert.equal(eventArgs.data.previousExternalAccountId, "old-shop.myshopify.com");
  assert.equal(eventArgs.data.currencyCode, "USD");
  assert.equal(eventArgs.data.previousCurrencyCode, "CAD");
});

test("resolveLastKnownShopDomain queries connection history and normalizes the result", async () => {
  const tx = {
    commerceConnectionEvent: {
      findFirst: async (args: unknown) => {
        const typedArgs = args as { where: { brandId: string } };
        assert.equal(typedArgs.where.brandId, "brand-1");
        return { externalAccountId: "Shop.MyShopify.com" };
      },
    },
  } as unknown as Prisma.TransactionClient;

  const result = await resolveLastKnownShopDomain(tx, "brand-1");
  assert.equal(result, "shop.myshopify.com");
});

test("resolveLastKnownShopDomain returns null when there is no history", async () => {
  const tx = {
    commerceConnectionEvent: {
      findFirst: async () => null,
    },
  } as unknown as Prisma.TransactionClient;

  const result = await resolveLastKnownShopDomain(tx, "brand-1");
  assert.equal(result, null);
});

test("generic lifecycle writer records Commerce7 without Shopify-shaped fields", async () => {
  const events: unknown[] = [];
  const tx = {
    commerceConnectionEvent: {
      create: async (args: unknown) => {
        events.push(args);
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;

  await recordCommerceConnectionEvent(tx, {
    brandId: "brand-commerce7",
    provider: CommerceProvider.COMMERCE7,
    eventType: "CONNECTED",
    snapshot: {
      externalAccountId: "winery-tenant",
      currencyCode: "USD",
      providerClientId: null,
    },
  });

  assert.deepEqual(events, [{
    data: {
      brandId: "brand-commerce7",
      provider: "COMMERCE7",
      eventType: "CONNECTED",
      externalAccountId: "winery-tenant",
      previousExternalAccountId: null,
      currencyCode: "USD",
      previousCurrencyCode: null,
      providerClientId: null,
    },
  }]);
});
