import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as formatting from "../src/lib/reward-formatting";
type Node = { type: string; props: Record<string, unknown> };
function harness(path: string, exportName: string, props = {}) {
  const states: unknown[] = []; const effects: unknown[][] = []; let index = 0; let effectIndex = 0; let effectsToRun: (() => void)[] = [];
  const requests: { url: string; init?: RequestInit; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const storage = new Map<string, string>(); const copied: string[] = []; let requestKey = 0;
  const exports: Record<string, (props: object) => Node> = {};
  const react = {
    useState(initial: unknown) { const i = index++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial; return [states[i], (value: unknown) => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
    useRef(initial: unknown) { const i = index++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useCallback(value: unknown, deps: unknown[]) { const i = index++; const prior = states[i] as { deps: unknown[]; value: unknown } | undefined; if (!prior || !deps.every((dep, j) => Object.is(dep, prior.deps[j]))) states[i] = { deps, value }; return (states[i] as { value: unknown }).value; },
    useEffect(run: () => void, deps: unknown[]) { const i = effectIndex++; if (!effects[i] || !deps.every((dep, j) => Object.is(dep, effects[i][j]))) { effects[i] = deps; effectsToRun.push(run); } },
  };
  const jsx = (type: string, props: object) => ({ type, props });
  runInNewContext(ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, URLSearchParams, Date, Set, Map, Array, Number, JSON, crypto: { randomUUID: () => `synthetic-client-request-key-${++requestKey}` }, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, navigator: { clipboard: { writeText: async (value: string) => { copied.push(value); } } },
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "next/navigation") return { useRouter: () => ({ refresh() {} }) };
      if (name === "@/lib/reward-formatting") return formatting;
      if (name === "@/components/experience/client-utils") return { fetchJson: (url: string, init?: RequestInit) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })), getErrorMessage: (error: Error) => error.message };
      if (name.startsWith("@/components/ui/")) return new Proxy({}, { get: (_target, key) => String(key) });
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return { requests, copied, storage, setProps(value: object) { props = value; }, render() { index = 0; effectIndex = 0; return exports[exportName](props); }, flush() { const work = effectsToRun; effectsToRun = []; work.forEach((run) => run()); } };
}
function nodes(value: unknown): Node[] { if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== "object" || !("props" in value)) return []; const node = value as Node; return [node, ...nodes(node.props.children)]; }
function text(value: unknown): string { if (Array.isArray(value)) return value.map(text).join(" "); if (value && typeof value === "object" && "props" in value) return text((value as Node).props.children); return value == null || value === false ? "" : String(value); }
function button(tree: Node, label: string) { const result = nodes(tree).find((node) => node.type === "Button" && text(node).includes(label)); assert.ok(result, label); return result; }
async function settle() { for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }
const offer = { id: "offer", title: "Wine discount", brandName: "Winery", description: "A thank you", pointsCost: 100, discountType: "FIXED_AMOUNT", discountAmountCents: 1000, discountPercentageBasisPoints: null, currencyCode: "CAD", minimumSubtotalCents: 5000, codeValidDays: 30, claimEndsAt: null, remaining: 25, claimable: true };

test("claimant UI renders real offers and manual eligibility; double click and lost response reuse one request key", async () => {
  const app = harness("src/components/rewards/commerce7-rewards-client.tsx", "Commerce7RewardsClient", { experienceSlug: "wine", campaignId: "campaign" });
  app.render(); app.flush(); assert.match(app.requests[0].url, /experienceSlug=wine&campaignId=campaign/);
  app.requests[0].resolve({ offers: [offer], claims: [], points: 500 }); await settle();
  let tree = app.render(); assert.match(text(tree), /same verified email/); assert.match(text(tree), /25\s+claims remaining/); assert.match(text(tree), /10/); assert.match(text(tree), /50/);
  const claim = button(tree, "Claim for"); (claim.props.onClick as () => void)(); (claim.props.onClick as () => void)();
  assert.equal(app.requests.length, 2); const first = JSON.parse(String(app.requests[1].init?.body)); assert.equal(first.offerId, "offer"); assert.equal(first.campaignId, "campaign"); assert.equal(first.email, undefined); assert.equal(first.customerId, undefined);
  app.requests[1].reject(new Error("Temporary request failure")); await settle(); tree = app.render(); assert.match(text(tree), /Temporary request failure/);
  (button(tree, "Claim for").props.onClick as () => void)(); assert.equal(JSON.parse(String(app.requests[2].init?.body)).idempotencyKey, first.idempotencyKey);
  app.requests[2].resolve({ id: "claim" }); await settle(); app.requests[3].resolve({ offers: [offer], claims: [{ id: "claim", title: "Wine discount", status: "POINTS_DEBITED", provisioningState: "AWAITING_ELIGIBILITY", code: null, canRetry: true, canCancel: true, message: "The store must assign your Customer tag." }], points: 400 }); await settle();
  tree = app.render(); assert.match(text(tree), /Waiting for store approval/); assert.match(text(tree), /Customer tag/); assert.equal(button(tree, "Cancel and return points").props.disabled, false);
  (button(tree, "Cancel and return points").props.onClick as () => void)(); assert.equal(app.requests[4].init?.method, "DELETE");
});
test("claimant UI shows ready code and expiry, hides cancel during uncertain issuance, and copies only the displayed code", async () => {
  const app = harness("src/components/rewards/commerce7-rewards-client.tsx", "Commerce7RewardsClient"); app.render(); app.flush();
  app.requests[0].resolve({ offers: [], claims: [{ id: "ready", title: "Ready", status: "ISSUED", provisioningState: "READY", code: "SQRA-EXAMPLE", expiresAt: "2027-01-01T00:00:00.000Z", canRetry: false, canCancel: false }, { id: "unknown", title: "Pending", status: "POINTS_DEBITED", provisioningState: "MANUAL_REVIEW", code: null, canRetry: false, canCancel: false, message: "The store must review this claim." }], points: 400 }); await settle();
  const tree = app.render(); assert.match(text(tree), /SQRA-EXAMPLE/); assert.match(text(tree), /Expires/); assert.match(text(tree), /Store review needed/); assert.ok(!nodes(tree).some((node) => node.type === "Button" && text(node).includes("Cancel")));
  (button(tree, "Copy coupon").props.onClick as () => void)(); await settle(); assert.deepEqual(app.copied, ["SQRA-EXAMPLE"]);
});
test("Brand UI exposes real setup requirements, catalog choices and disables exclusive access activation", async () => {
  const app = harness("src/components/rewards/commerce7-brand-rewards.tsx", "Commerce7BrandRewardsPanel"); app.render(); app.flush();
  app.requests[0].resolve({ providers: { COMMERCE7: true, SHOPIFY: false }, connection: { displayName: "Winery", currencyCode: "CAD" }, readiness: { backendConfigured: true }, offers: [], claims: [], products: [{ externalId: "wine-id", title: "Rare wine" }] }); await settle();
  let tree = app.render(); assert.match(text(tree), /Coupon: Full/); assert.match(text(tree), /Customer tag/); assert.match(text(tree), /Rare wine/);
  const mode = nodes(tree).find((node) => node.type === "select" && node.props.value === "DISCOUNT"); assert.ok(mode); (mode.props.onChange as (event: object) => void)({ target: { value: "EXCLUSIVE_PRODUCT_ACCESS" } });
  tree = app.render(); const active = nodes(tree).find((node) => node.type === "input" && node.props.type === "checkbox" && node.props.disabled === true); assert.equal(active?.props.disabled, true); assert.equal(active?.props.checked, false);
});

test("late reward responses cannot cross experience/campaign context", async () => {
  const app = harness("src/components/rewards/commerce7-rewards-client.tsx", "Commerce7RewardsClient", { experienceSlug: "old", campaignId: "old-campaign" }); app.render(); app.flush();
  app.setProps({ experienceSlug: "new", campaignId: "new-campaign" }); app.render(); app.flush();
  app.requests[1].resolve({ offers: [{ ...offer, title: "New campaign offer" }], claims: [], points: 100 }); await settle();
  app.requests[0].resolve({ offers: [{ ...offer, title: "Old campaign offer" }], claims: [], points: 100 }); await settle();
  const tree = app.render(); assert.match(text(tree), /New campaign offer/); assert.doesNotMatch(text(tree), /Old campaign offer/);
});
test("a completed claim permits a later intentional claim with a new key; unavailable offers explain the limit", async () => {
  const app = harness("src/components/rewards/commerce7-rewards-client.tsx", "Commerce7RewardsClient"); app.render(); app.flush();
  app.requests[0].resolve({ offers: [offer], claims: [], points: 500 }); await settle();
  (button(app.render(), "Claim for").props.onClick as () => void)();
  const firstKey = JSON.parse(String(app.requests[1].init?.body)).idempotencyKey;
  app.requests[1].resolve({ id: "first", offerId: offer.id, status: "ISSUED" }); await settle();
  app.requests[2].resolve({ offers: [offer], claims: [], points: 400 }); await settle();
  (button(app.render(), "Claim for").props.onClick as () => void)();
  assert.notEqual(JSON.parse(String(app.requests[3].init?.body)).idempotencyKey, firstKey);
  app.requests[3].resolve({ id: "second", offerId: offer.id, status: "ISSUED" }); await settle();
  app.requests[4].resolve({ offers: [{ ...offer, claimable: false, unavailableReason: "You have reached this reward's per-user claim limit." }], claims: [], points: 300 }); await settle();
  assert.match(text(app.render()), /per-user claim limit/); assert.equal(button(app.render(), "Claim unavailable").props.disabled, true);
});
