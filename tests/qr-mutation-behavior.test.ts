process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { v2 as cloudinary } from "cloudinary";
import type { AuthResolvers } from "../src/lib/auth-session";

const deps = { resolveSession: async () => ({ user: { id: "u" } }), resolveBrandAdminContext: async () => ({ membership: { brand: { id: "b", name: "Brand" } } }) } as unknown as AuthResolvers;
let prisma: typeof import("../src/lib/prisma").default;
let patch: typeof import("../src/app/api/brand/qr-codes/[id]/route").patchQrCodeImpl;
before(async () => {
  prisma = (await import("../src/lib/prisma")).default;
  const qr = prisma.qRCode;
  const campaigns = prisma.campaign;
  Object.assign(prisma, {
    qRCode: { findFirst: qr.findFirst, findMany: qr.findMany },
    campaign: { findFirst: campaigns.findFirst },
  });
  patch = (await import("../src/app/api/brand/qr-codes/[id]/route")).patchQrCodeImpl;
});
const context = { params: Promise.resolve({ id: "qr" }) };
function request(body: object) { return new NextRequest("http://localhost/api/brand/qr-codes/qr", { method: "PATCH", body: JSON.stringify(body) }); }
const existing = { id: "qr", qrCodeData: "opaque", qrCodeUrl: "https://res.cloudinary.com/test/image/upload/v1/old.png", campaignId: "old", status: "USED", batchId: null };

test("a redeemed QR cannot be reset", async t => {
  t.mock.method(prisma.qRCode, "findFirst", async () => existing as never);
  const res = await patch(request({ campaignId: "old", status: "NEW" }), context, deps);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "QR_STATUS_IMMUTABLE");
});

test("an uncertain reassignment commit retains both images", async t => {
  t.mock.method(prisma.qRCode, "findFirst", async () => ({ ...existing, status: "NEW" }) as never);
  t.mock.method(prisma.campaign, "findFirst", async () => ({ id: "new", name: "New" }) as never);
  let options: Record<string, unknown> | undefined;
  t.mock.method(cloudinary.uploader, "upload", async (_data: string, opts: unknown) => { options = opts as Record<string, unknown>; return { secure_url: "https://res.cloudinary.com/test/image/upload/v1/new.png" } as never; });
  let destroys = 0;
  t.mock.method(cloudinary.uploader, "destroy", async () => { destroys++; return {} as never; });
  const res = await patch(request({ campaignId: "new" }), context, deps, async () => { throw new Error("uncertain commit"); });
  assert.equal(res.status, 500);
  assert.equal(options?.overwrite, false);
  assert.match(String(options?.public_id), /^qr_opaque_[0-9a-f-]+$/);
  assert.equal(destroys, 0);
});

test("reassignment conflict keeps the old image and removes only the unattached new image", async t => {
  t.mock.method(prisma.qRCode, "findFirst", async () => ({ ...existing, status: "NEW" }) as never);
  t.mock.method(prisma.qRCode, "findMany", async () => [{ status: "NEW", redeemedById: null, batch: null, _count: { unlocks: 1, pointTransactions: 0, userSessions: 0, analyticsEvents: 0, commerceClickAttributions: 0 } }] as never);
  t.mock.method(prisma.campaign, "findFirst", async () => ({ id: "new", name: "New" }) as never);
  t.mock.method(cloudinary.uploader, "upload", async () => ({ secure_url: "https://res.cloudinary.com/test/image/upload/v1/new.png" }) as never);
  const destroyed: string[] = [];
  t.mock.method(cloudinary.uploader, "destroy", async (publicId: string) => { destroyed.push(publicId); return {} as never; });
  const response = await patch(request({ campaignId: "new" }), context, deps, async () => false);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "QR_HAS_HISTORY");
  assert.deepEqual(destroyed, ["new"]);
});

test("confirmed reassignment cleans the old image after commit", async t => {
  t.mock.method(prisma.qRCode, "findFirst", async () => ({ ...existing, status: "NEW" }) as never);
  t.mock.method(prisma.campaign, "findFirst", async () => ({ id: "new", name: "New" }) as never);
  const events: string[] = [];
  t.mock.method(cloudinary.uploader, "upload", async () => { events.push("upload"); return { secure_url: "https://res.cloudinary.com/test/image/upload/v1/new.png" } as never; });
  t.mock.method(cloudinary.uploader, "destroy", async (publicId: string) => { events.push(`destroy:${publicId}`); return {} as never; });
  const response = await patch(request({ campaignId: "new" }), context, deps, async () => { events.push("commit"); return true; });
  assert.equal(response.status, 200);
  assert.deepEqual(events, ["upload", "commit", "destroy:old"]);
});
