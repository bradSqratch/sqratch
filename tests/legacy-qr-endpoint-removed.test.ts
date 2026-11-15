import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

const routePath = (...segments: string[]) =>
  path.join(process.cwd(), "src", "app", "api", ...segments, "route.ts");

test("legacy unauthenticated QR email endpoint is removed", () => {
  assert.equal(
    existsSync(
      routePath("users", "add-user-send-verify-email"),
    ),
    false,
  );
});

test("QR redemption uses the supported public scan route", () => {
  assert.equal(existsSync(routePath("public", "scan")), true);
});

test("legacy QR mutation endpoints are removed", () => {
  for (const route of [["qr", "update-qrcode", "[id]"], ["qr", "delete-qrcode", "[id]"], ["qr", "bulk-delete"], ["qr", "bulk-generate-qr"]]) {
    assert.equal(existsSync(routePath(...route)), false);
  }
  assert.equal(existsSync(path.join(process.cwd(), "src/app/redeemQR/[campaignID]/[qrcodeID]/page.tsx")), true);
});
