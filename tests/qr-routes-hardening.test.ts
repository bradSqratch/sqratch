process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";

import assert from "node:assert/strict";
import { test, describe, before } from "node:test";
import { NextRequest } from "next/server";
import type {
  AuthResolvers,
  CustomSession,
  BrandAdminContext,
} from "../src/lib/auth-session";

/** Narrowest type that satisfies node:test mock.method's overloads. */
type MockableDelegate = Record<string, (...args: unknown[]) => unknown>;

interface MockedPrismaClient {
  campaign: MockableDelegate;
  qRCode: MockableDelegate;
  qRCodeBatch: MockableDelegate;
}

let prisma: MockedPrismaClient;

// Route implementation functions accept an explicit AuthResolvers dependency.
let getAllQrCodesImpl: (req: NextRequest, deps: AuthResolvers) => Promise<Response>;
let getSingleQrImpl: (req: NextRequest, deps: AuthResolvers) => Promise<Response>;
let checkQrCodeImpl: (req: NextRequest, context: { params: Promise<{ qrcodeID: string }> }, deps: AuthResolvers) => Promise<Response>;
let exportBatchImpl: (req: NextRequest, context: { params: Promise<{ id: string }> }, deps: AuthResolvers) => Promise<Response>;

// Per-test injected resolvers, populated by setupMocks/clearMocks.
let currentDeps: AuthResolvers = {
  resolveSession: async () => null,
  resolveBrandAdminContext: async () => null,
};

// Thin wrappers that keep the existing call sites unchanged while threading the
// per-test injected dependencies into the route implementations.
const getAllQRs = (req: NextRequest) => getAllQrCodesImpl(req, currentDeps);
const getSingleQR = (req: NextRequest) => getSingleQrImpl(req, currentDeps);
const checkQR = (
  req: NextRequest,
  context: { params: Promise<{ qrcodeID: string }> },
) => checkQrCodeImpl(req, context, currentDeps);
const exportBatch = (
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) => exportBatchImpl(req, context, currentDeps);

before(async () => {
  const prismaModule = (await import("../src/lib/prisma")).default as unknown as {
    campaign: Record<string, (...args: unknown[]) => unknown>;
    qRCode: Record<string, (...args: unknown[]) => unknown>;
    qRCodeBatch: Record<string, (...args: unknown[]) => unknown>;
  };
  prisma = prismaModule as unknown as MockedPrismaClient;

  // Unwrap Prisma Client proxy properties so node:test mock.method can see them
  prisma.campaign = {
    findFirst: prismaModule.campaign.findFirst as MockableDelegate[string],
    findUnique: prismaModule.campaign.findUnique as MockableDelegate[string],
    findMany: prismaModule.campaign.findMany as MockableDelegate[string],
    count: prismaModule.campaign.count as MockableDelegate[string],
  };

  prisma.qRCode = {
    findFirst: prismaModule.qRCode.findFirst as MockableDelegate[string],
    findUnique: prismaModule.qRCode.findUnique as MockableDelegate[string],
    findMany: prismaModule.qRCode.findMany as MockableDelegate[string],
    count: prismaModule.qRCode.count as MockableDelegate[string],
  };

  prisma.qRCodeBatch = {
    findFirst: prismaModule.qRCodeBatch.findFirst as MockableDelegate[string],
    findUnique: prismaModule.qRCodeBatch.findUnique as MockableDelegate[string],
    findMany: prismaModule.qRCodeBatch.findMany as MockableDelegate[string],
    count: prismaModule.qRCodeBatch.count as MockableDelegate[string],
    update: prismaModule.qRCodeBatch.update as MockableDelegate[string],
  };

  getAllQrCodesImpl = (await import("../src/app/api/qr/get-all-qrcodes/route")).getAllQrCodesImpl;
  getSingleQrImpl = (await import("../src/app/api/qr/get-single-qr/route")).getSingleQrImpl;
  checkQrCodeImpl = (await import("../src/app/api/qr/check-qrcode/[qrcodeID]/route")).checkQrCodeImpl;
  exportBatchImpl = (await import("../src/app/api/brand/qr-batches/[id]/export/route")).exportBatchImpl;
});

// Inject canned session / brand-admin resolvers for the next handler call.
function setupMocks(session: unknown, brandAdminContext: unknown = null) {
  currentDeps = {
    resolveSession: async () => session as CustomSession | null,
    resolveBrandAdminContext: async () =>
      brandAdminContext as BrandAdminContext | null,
  };
}

function clearMocks() {
  currentDeps = {
    resolveSession: async () => null,
    resolveBrandAdminContext: async () => null,
  };
}

describe("QR Hardening Route-Level Tests", () => {
  // Test Case 1: Unauthenticated access
  test("unauthenticated access is rejected with 401", async () => {
    setupMocks(null);
    try {
      const req = new NextRequest("http://localhost/api/qr/get-all-qrcodes");
      const res = await getAllQRs(req);
      assert.equal(res.status, 401);

      const singleReq = new NextRequest("http://localhost/api/qr/get-single-qr?qrId=123");
      const singleRes = await getSingleQR(singleReq);
      assert.equal(singleRes.status, 401);

      const checkReq = new NextRequest("http://localhost/api/qr/check-qrcode/code123?campaignId=camp123");
      const checkRes = await checkQR(checkReq, { params: Promise.resolve({ qrcodeID: "code123" }) });
      assert.equal(checkRes.status, 401);

      const exportReq = new NextRequest("http://localhost/api/brand/qr-batches/batch123/export");
      const exportRes = await exportBatch(exportReq, { params: Promise.resolve({ id: "batch123" }) });
      assert.equal(exportRes.status, 401);
    } finally {
      clearMocks();
    }
  });

  // Test Case 2: Wrong role
  test("wrong role (USER) is rejected with 403", async () => {
    setupMocks({ user: { id: "user-1", role: "USER" } });
    try {
      const req = new NextRequest("http://localhost/api/qr/get-all-qrcodes");
      const res = await getAllQRs(req);
      assert.equal(res.status, 403);

      const singleReq = new NextRequest("http://localhost/api/qr/get-single-qr?qrId=123");
      const singleRes = await getSingleQR(singleReq);
      assert.equal(singleRes.status, 403);
    } finally {
      clearMocks();
    }
  });

  // Test Case 3: Cross-brand access is restricted for BRAND_ADMIN
  test("cross-brand access is rejected with 403 for BRAND_ADMIN", async (t) => {
    // Brand Admin for brand-1
    setupMocks(
      { user: { id: "brand-admin-1", role: "BRAND_ADMIN" } },
      { membership: { brand: { id: "brand-1", name: "Brand One" } } }
    );

    // Mock prisma check to return campaign owned by brand-2
    t.mock.method(prisma.campaign, "findFirst", async () => {
      // simulate not found because campaign does not belong to brand-1
      return null;
    });

    try {
      const checkReq = new NextRequest("http://localhost/api/qr/check-qrcode/code123?campaignId=camp-of-brand-2");
      const checkRes = await checkQR(checkReq, { params: Promise.resolve({ qrcodeID: "code123" }) });
      assert.equal(checkRes.status, 403);
    } finally {
      clearMocks();
    }
  });

  // Test Case 4: Valid Brand admin access is authorized
  test("valid BRAND_ADMIN access is authorized", async (t) => {
    setupMocks(
      { user: { id: "brand-admin-1", role: "BRAND_ADMIN" } },
      { membership: { brand: { id: "brand-1", name: "Brand One" } } }
    );

    // Mock prisma check to verify campaign ownership
    t.mock.method(prisma.campaign, "findFirst", async () => {
      return { id: "campaign-1", name: "Campaign One" };
    });

    // Mock QR findFirst
    t.mock.method(prisma.qRCode, "findFirst", async () => {
      return { status: "NEW" };
    });

    try {
      const checkReq = new NextRequest("http://localhost/api/qr/check-qrcode/code123?campaignId=campaign-1");
      const checkRes = await checkQR(checkReq, { params: Promise.resolve({ qrcodeID: "code123" }) });
      assert.equal(checkRes.status, 200);
      const json = await checkRes.json();
      assert.equal(json.status, "NEW");
    } finally {
      clearMocks();
    }
  });

  // Test Case 5: ADMIN access is globally authorized
  test("ADMIN access is globally authorized without brand restriction checks", async (t) => {
    setupMocks({ user: { id: "admin-1", role: "ADMIN" } });

    t.mock.method(prisma.qRCode, "findFirst", async () => {
      return { status: "NEW" };
    });

    try {
      const checkReq = new NextRequest("http://localhost/api/qr/check-qrcode/code123?campaignId=any-campaign");
      const checkRes = await checkQR(checkReq, { params: Promise.resolve({ qrcodeID: "code123" }) });
      assert.equal(checkRes.status, 200);
      const json = await checkRes.json();
      assert.equal(json.status, "NEW");
    } finally {
      clearMocks();
    }
  });

  // Test Case 6: Empty results handling
  test("empty results handles pagination and formats data correctly", async (t) => {
    setupMocks({ user: { id: "admin-1", role: "ADMIN" } });

    t.mock.method(prisma.qRCode, "findMany", async () => []);
    t.mock.method(prisma.qRCode, "count", async () => 0);

    try {
      const req = new NextRequest("http://localhost/api/qr/get-all-qrcodes?page=1&pageSize=10");
      const res = await getAllQRs(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.deepEqual(json.data, []);
      assert.equal(json.pagination.total, 0);
      assert.equal(json.pagination.totalPages, 0);
    } finally {
      clearMocks();
    }
  });

  // Test Case 7: Pagination boundaries and maximum page size limits
  test("enforces max pageSize limit", async (t) => {
    setupMocks({ user: { id: "admin-1", role: "ADMIN" } });

    let capturedTake = 0;
    t.mock.method(prisma.qRCode, "findMany", async (args: Record<string, unknown>) => {
      capturedTake = (args?.take as number) || 0;
      return [];
    });
    t.mock.method(prisma.qRCode, "count", async () => 0);

    try {
      // request 500 records
      const req = new NextRequest("http://localhost/api/qr/get-all-qrcodes?page=1&pageSize=500");
      await getAllQRs(req);
      // must be capped at MAX_PAGE_SIZE = 200
      assert.equal(capturedTake, 200);
    } finally {
      clearMocks();
    }
  });

  // Test Case 8: Stable ordering with tie-breaker
  test("specifies stable ordering with deterministic tie-breaker", async (t) => {
    setupMocks({ user: { id: "admin-1", role: "ADMIN" } });

    let capturedOrderBy: unknown = null;
    t.mock.method(prisma.qRCode, "findMany", async (args: Record<string, unknown>) => {
      capturedOrderBy = args?.orderBy;
      return [];
    });
    t.mock.method(prisma.qRCode, "count", async () => 0);

    try {
      const req = new NextRequest("http://localhost/api/qr/get-all-qrcodes");
      await getAllQRs(req);
      assert.deepEqual(capturedOrderBy, [
        { createdAt: "desc" },
        { id: "asc" },
      ]);
    } finally {
      clearMocks();
    }
  });

  // Test Case 9: Bounded export under limit works
  test("small batch export returns CSV data successfully", async (t) => {
    setupMocks({ user: { id: "admin-1", role: "ADMIN" } });

    // Mock batch lookup
    t.mock.method(prisma.qRCodeBatch, "findUnique", async () => ({
      id: "batch-1",
      campaign: { id: "campaign-1", brandId: "brand-1" },
    }));

    // Mock count under limit
    t.mock.method(prisma.qRCode, "count", async () => 10);

    // Mock QRs findMany
    t.mock.method(prisma.qRCode, "findMany", async () => [
      { qrCodeData: "qr1", qrCodeUrl: "http://cloudinary.com/qr1.png", status: "NEW" },
      { qrCodeData: "qr2", qrCodeUrl: "http://cloudinary.com/qr2.png", status: "USED" },
    ]);

    // Mock update batch CSV export date
    t.mock.method(prisma.qRCodeBatch, "update", async () => ({}));

    try {
      const req = new NextRequest("http://localhost/api/brand/qr-batches/batch-1/export");
      const res = await exportBatch(req, { params: Promise.resolve({ id: "batch-1" }) });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Content-Type"), "text/csv; charset=utf-8");

      const csvText = await res.text();
      assert.ok(csvText.includes("QR Code Data,QR Code URL,Status,Scan Redirect URL"));
      assert.ok(csvText.includes("qr1"));
      assert.ok(csvText.includes("qr2"));
    } finally {
      clearMocks();
    }
  });

  // Test Case 10: Maximum allowed export limits
  test("batch export rejects requests exceeding hard limit", async (t) => {
    setupMocks({ user: { id: "admin-1", role: "ADMIN" } });

    t.mock.method(prisma.qRCodeBatch, "findUnique", async () => ({
      id: "batch-1",
      campaign: { id: "campaign-1", brandId: "brand-1" },
    }));

    // Mock count exceeding limit (5001 > 5000)
    t.mock.method(prisma.qRCode, "count", async () => 5001);

    try {
      const req = new NextRequest("http://localhost/api/brand/qr-batches/batch-1/export");
      const res = await exportBatch(req, { params: Promise.resolve({ id: "batch-1" }) });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.ok(json.error.includes("Export size too large"));
    } finally {
      clearMocks();
    }
  });

  // Test Case 11: Preventing PII and Raw Secrets leakage
  test("export does not include sensitive fields or user PII", async (t) => {
    setupMocks({ user: { id: "admin-1", role: "ADMIN" } });

    t.mock.method(prisma.qRCodeBatch, "findUnique", async () => ({
      id: "batch-1",
      campaign: { id: "campaign-1", brandId: "brand-1" },
    }));
    t.mock.method(prisma.qRCode, "count", async () => 1);
    t.mock.method(prisma.qRCode, "findMany", async () => [
      { qrCodeData: "qr1", qrCodeUrl: "http://url.com", status: "NEW" },
    ]);
    t.mock.method(prisma.qRCodeBatch, "update", async () => ({}));

    try {
      const req = new NextRequest("http://localhost/api/brand/qr-batches/batch-1/export");
      const res = await exportBatch(req, { params: Promise.resolve({ id: "batch-1" }) });
      const csvText = await res.text();

      // Ensure headers only contain printable elements and no PII like email
      assert.ok(!csvText.toLowerCase().includes("email"));
      assert.ok(!csvText.toLowerCase().includes("user"));
      assert.ok(!csvText.toLowerCase().includes("redeemer"));
      assert.ok(!csvText.toLowerCase().includes("password"));
    } finally {
      clearMocks();
    }
  });

  // Test Case 12: CSV Formula Injection handling
  test("sanitizes CSV cells starting with formula trigger chars", async (t) => {
    setupMocks({ user: { id: "admin-1", role: "ADMIN" } });

    t.mock.method(prisma.qRCodeBatch, "findUnique", async () => ({
      id: "batch-1",
      campaign: { id: "campaign-1", brandId: "brand-1" },
    }));
    t.mock.method(prisma.qRCode, "count", async () => 2);
    t.mock.method(prisma.qRCode, "findMany", async () => [
      { qrCodeData: "=1+1", qrCodeUrl: "+1-1", status: "NEW" },
      { qrCodeData: "@injection", qrCodeUrl: "-subtraction", status: "NEW" },
    ]);
    t.mock.method(prisma.qRCodeBatch, "update", async () => ({}));

    try {
      const req = new NextRequest("http://localhost/api/brand/qr-batches/batch-1/export");
      const res = await exportBatch(req, { params: Promise.resolve({ id: "batch-1" }) });
      const csvText = await res.text();

      // trigger chars should be escaped with a leading single quote (')
      assert.ok(csvText.includes("'=1+1"));
      assert.ok(csvText.includes("'+1-1"));
      assert.ok(csvText.includes("'@injection"));
      assert.ok(csvText.includes("'-subtraction"));
    } finally {
      clearMocks();
    }
  });
});
