/**
 * tests/brand-commerce-readiness-refresh.test.ts
 *
 * PHASE 21 (live QA hotfix, Issue 1) — the Commerce7 readiness checklist did
 * not refresh after a successful "Sync settings from Commerce7", disconnect,
 * or reconnect, because `Commerce7ReadinessChecklist`'s diagnostics
 * `useEffect` depended only on `connectionId`, which none of those actions
 * change. Fixed by threading a `refreshKey` (bumped via the pure
 * `nextDiagnosticsRefreshKey` in `commerce-response-validation.ts`) into that
 * effect's dependency array.
 *
 * There is no React testing library in this repo (see CLAUDE.md / prior
 * rounds), so this file combines:
 *   1. Direct unit tests of the pure `nextDiagnosticsRefreshKey` transition
 *      (properties 1-4 below).
 *   2. Static source-inspection assertions against
 *      `BrandCommerceClient.tsx`, proving the component actually wires that
 *      pure function into the right places — same idiom as
 *      `tests/shopify-scope-drift.test.ts` / `tests/brand-product-page.test.ts`.
 */
import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  nextDiagnosticsRefreshKey,
  type DiagnosticsRefreshEvent,
} from "../src/app/(withSidebar)/dashboard/brand/commerce/commerce-response-validation";

const COMMERCE_CLIENT_PATH = path.join(
  process.cwd(),
  "src/app/(withSidebar)/dashboard/brand/commerce/BrandCommerceClient.tsx",
);

function readComponentSource(): string {
  return readFileSync(COMMERCE_CLIENT_PATH, "utf8");
}

// ---------------------------------------------------------------------------
// 1-4. nextDiagnosticsRefreshKey — pure transition logic
// ---------------------------------------------------------------------------

describe("nextDiagnosticsRefreshKey", () => {
  test("1. a successful settings sync bumps the refresh key", () => {
    const event: DiagnosticsRefreshEvent = { type: "SETTINGS_SYNC_SUCCEEDED" };
    assert.equal(nextDiagnosticsRefreshKey(0, event), 1);
    assert.equal(nextDiagnosticsRefreshKey(7, event), 8);
  });

  test("2. a FAILED settings sync does NOT bump the refresh key — the checklist must never falsely look refreshed", () => {
    const event: DiagnosticsRefreshEvent = { type: "SETTINGS_SYNC_FAILED" };
    assert.equal(nextDiagnosticsRefreshKey(0, event), 0);
    assert.equal(nextDiagnosticsRefreshKey(7, event), 7, "the key must be UNCHANGED, not merely 'not incremented by 1'");
  });

  test("3. a successful disconnect bumps the refresh key", () => {
    assert.equal(nextDiagnosticsRefreshKey(3, { type: "CONNECTION_DISCONNECTED" }), 4);
  });

  test("4. a successful reconnect bumps the refresh key", () => {
    assert.equal(nextDiagnosticsRefreshKey(3, { type: "CONNECTION_RECONNECTED" }), 4);
  });

  test("repeated successful events keep advancing — never saturate or wrap", () => {
    let key = 0;
    const events: DiagnosticsRefreshEvent[] = [
      { type: "SETTINGS_SYNC_SUCCEEDED" },
      { type: "CONNECTION_DISCONNECTED" },
      { type: "CONNECTION_RECONNECTED" },
      { type: "SETTINGS_SYNC_FAILED" },
      { type: "SETTINGS_SYNC_SUCCEEDED" },
    ];
    for (const event of events) key = nextDiagnosticsRefreshKey(key, event);
    assert.equal(key, 4, "3 real changes + 1 no-op failure + 1 more real change = 4");
  });
});

// ---------------------------------------------------------------------------
// 5. Source-inspection: the component actually wires refreshKey into the
// diagnostics effect's dependency array — connectionId alone no longer
// gates the re-fetch.
// ---------------------------------------------------------------------------

describe("Commerce7ReadinessChecklist wiring (source inspection)", () => {
  test("5. the diagnostics useEffect depends on BOTH connectionId and refreshKey, not connectionId alone", () => {
    const source = readComponentSource();
    // The old, buggy dependency array this fix replaces.
    assert.ok(
      !/\},\s*\[connectionId\]\s*\)/.test(source),
      "no diagnostics effect may depend on connectionId ALONE anymore",
    );
    assert.ok(
      /\},\s*\[connectionId,\s*refreshKey\]\s*\)/.test(source),
      "the diagnostics effect must depend on [connectionId, refreshKey]",
    );
  });

  test("Commerce7ReadinessChecklist accepts a refreshKey prop", () => {
    const source = readComponentSource();
    assert.match(source, /function Commerce7ReadinessChecklist\(\{[\s\S]*?refreshKey[\s\S]*?\}/);
  });

  test("a successful settings sync (onSynced) bumps the diagnostics refresh via SETTINGS_SYNC_SUCCEEDED", () => {
    const source = readComponentSource();
    assert.match(source, /onSynced=\{[\s\S]*?bumpDiagnosticsRefresh\(\{ type: "SETTINGS_SYNC_SUCCEEDED" \}\)/);
  });

  test("disconnect/reconnect (onChanged) is wired to a handler that bumps diagnostics for BOTH outcomes", () => {
    const source = readComponentSource();
    assert.match(source, /onChanged=\{handleConnectionChanged\}/);
    assert.match(source, /CONNECTION_DISCONNECTED/);
    assert.match(source, /CONNECTION_RECONNECTED/);
  });

  test("no window.location.reload() or router.refresh() anywhere in this component", () => {
    const source = readComponentSource();
    assert.ok(!/location\.reload\(/.test(source), "must never force a full page reload");
    assert.ok(!/router\.refresh\(/.test(source), "must never force a full route refresh");
    assert.ok(!/useRouter\(/.test(source), "no router dependency was introduced for this fix");
  });
});
