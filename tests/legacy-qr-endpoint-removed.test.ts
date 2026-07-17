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
