import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as formatting from "../src/lib/reward-formatting";
import * as contractModule from "../src/lib/commerce7-coupon-contract";
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
      if (name === "@/lib/commerce7-coupon-contract") return contractModule;
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
const couponContract = { eligibility: { ANYONE_WITH_CODE: true, CLAIMANT_ONLY: false }, scope: { ALL_PRODUCTS: true, SPECIFIC_PRODUCTS: false } };
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
test("Brand UI explains template-free setup, lists catalog choices only when selected, and disables exclusive access activation", async () => {
  const app = harness("src/components/rewards/commerce7-brand-rewards.tsx", "Commerce7BrandRewardsPanel"); app.render(); app.flush();
  app.requests[0].resolve({ providers: { COMMERCE7: true, SHOPIFY: false }, connection: { displayName: "Winery", currencyCode: "CAD" }, readiness: { backendConfigured: true, couponContract }, offers: [], claims: [], products: [{ externalId: "wine-id", title: "Rare wine" }] }); await settle();
  let tree = app.render(); const copy = text(tree);
  assert.match(copy, /no Commerce7 coupon needs to be created manually/); assert.match(copy, /SQRATCH creates the claim.s single-use native Commerce7 coupon when points are redeemed/);
  assert.match(copy, /Coupon: Full/); assert.match(copy, /Customer tag/); assert.doesNotMatch(copy, /Rare wine/);
  assert.doesNotMatch(copy, /template/i, "no template concept anywhere in the Brand UX");
  assert.ok(!nodes(tree).some((node) => node.type === "label" && /template/i.test(text(node))), "no template input"); assert.ok(!nodes(tree).some((node) => node.type === "Input" && /template/i.test(String(node.props.id ?? node.props.name ?? ""))));
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

const brandData = { providers: { COMMERCE7: true, SHOPIFY: false }, connection: { displayName: "Winery", currencyCode: "CAD" }, readiness: { backendConfigured: true, couponContract }, offers: [], claims: [], products: [{ externalId: "wine-id", title: "Rare wine" }, { externalId: "second-wine", title: "Second wine" }] };
function select(tree: Node, value: string) { const node = nodes(tree).find((node) => node.type === "select" && node.props.value === value); assert.ok(node, value); return node; }
function change(node: Node, value: string) { (node.props.onChange as (event: object) => void)({ target: { value } }); }
function product(tree: Node, title: string) { const label = nodes(tree).find((node) => node.type === "label" && text(node).trim() === title); assert.ok(label, title); const checkbox = nodes(label).find((node) => node.type === "Checkbox"); assert.ok(checkbox); return checkbox; }

test("Brand scope selector hides All products, requires selected products, toggles selection and clears stale IDs on save", async () => {
  const app = harness("src/components/rewards/commerce7-brand-rewards.tsx", "Commerce7BrandRewardsPanel"); app.render(); app.flush(); app.requests[0].resolve(brandData); await settle();
  let tree = app.render(); assert.equal(nodes(tree).filter((node) => node.type === "Checkbox").length, 0); assert.ok(select(tree, "ANYONE_WITH_CODE"));
  change(select(tree, "ALL_PRODUCTS"), "SPECIFIC_PRODUCTS"); tree = app.render();
  const submit = () => (nodes(app.render()).find((node) => node.type === "form")!.props.onSubmit as (event: object) => void)({ preventDefault() {} });
  submit(); await settle(); assert.match(text(app.render()), /Select at least one product/); assert.equal(app.requests.length, 1);
  (product(app.render(), "Rare wine").props.onCheckedChange as (value: boolean) => void)(true); tree = app.render(); assert.equal(product(tree, "Rare wine").props.checked, true);
  (button(tree, "Clear selection").props.onClick as () => void)(); assert.equal(product(app.render(), "Rare wine").props.checked, false);
  (product(app.render(), "Rare wine").props.onCheckedChange as (value: boolean) => void)(true);
  change(select(app.render(), "SPECIFIC_PRODUCTS"), "ALL_PRODUCTS"); tree = app.render(); assert.equal(nodes(tree).filter((node) => node.type === "Checkbox").length, 0);
  submit(); assert.equal(app.requests.length, 2); const body = JSON.parse(String(app.requests[1].init?.body)); assert.equal(body.appliesTo, "ALL_PRODUCTS"); assert.deepEqual(body.productIds, []); assert.equal(body.eligibilityMode, "ANYONE_WITH_CODE");
  assert.ok(!("templateCouponId" in body), "the request DTO has no template field"); assert.ok(!JSON.stringify(body).includes("template"));
});

test("Brand edit restores exact product scope and legacy/customer-bound eligibility; exclusive forces binding", async () => {
  const app = harness("src/components/rewards/commerce7-brand-rewards.tsx", "Commerce7BrandRewardsPanel"); app.render(); app.flush();
  const saved = { ...offer, appliesTo: "SPECIFIC_PRODUCTS", rewardMode: "DISCOUNT", isActive: false, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, totalClaims: 0, issuedCount: 0, _count: { redemptions: 0 }, commerce7Config: { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: true, templateCouponId: "stale-field-from-an-old-api" }, products: [{ externalProductId: "wine-id" }] };
  app.requests[0].resolve({ ...brandData, offers: [saved] }); await settle(); (button(app.render(), "Edit").props.onClick as () => void)();
  let tree = app.render(); assert.ok(select(tree, "SPECIFIC_PRODUCTS")); assert.ok(select(tree, "CLAIMANT_ONLY")); assert.equal(product(tree, "Rare wine").props.checked, true);
  const submit = () => (nodes(app.render()).find((node) => node.type === "form")!.props.onSubmit as (event: object) => void)({ preventDefault() {} });
  submit(); const edited = JSON.parse(String(app.requests[1].init?.body)); assert.equal(app.requests[1].init?.method, "PUT"); assert.equal(edited.eligibilityMode, "CLAIMANT_ONLY"); assert.deepEqual(edited.productIds, ["wine-id"]);
  assert.ok(!JSON.stringify(edited).includes("template") && !JSON.stringify(edited).includes("stale-field"), "an edit never replays a stored template ID");
  app.requests[1].reject(new Error("stop")); await settle();
  (button(app.render(), "Cancel edit").props.onClick as () => void)(); tree = app.render(); assert.ok(select(tree, "ALL_PRODUCTS")); assert.ok(select(tree, "ANYONE_WITH_CODE"));
  change(select(tree, "DISCOUNT"), "EXCLUSIVE_PRODUCT_ACCESS"); tree = app.render(); assert.equal(select(tree, "CLAIMANT_ONLY").props.disabled, true); assert.equal(select(tree, "SPECIFIC_PRODUCTS").props.disabled, true);
});

test("bearer claimant UI gives no matching-email or CRM approval requirement", async () => {
  const app = harness("src/components/rewards/commerce7-rewards-client.tsx", "Commerce7RewardsClient"); app.render(); app.flush();
  app.requests[0].resolve({ offers: [{ ...offer, eligibilityMode: "ANYONE_WITH_CODE" }], claims: [{ id: "ready", title: "Ready", eligibilityMode: "ANYONE_WITH_CODE", status: "ISSUED", provisioningState: "READY", code: "SYNTHETIC-CODE", canRetry: false, canCancel: false }], points: 400 }); await settle();
  const value = text(app.render()); assert.match(value, /Anyone with the code/); assert.doesNotMatch(value, /same verified email|Log in with your verified|approve your Customer tag/);
});

test("a late claim completion cannot invalidate loading rewards in the new campaign", async () => {
  const app = harness("src/components/rewards/commerce7-rewards-client.tsx", "Commerce7RewardsClient", { campaignId: "old" }); app.render(); app.flush();
  app.requests[0].resolve({ offers: [offer], claims: [], points: 500 }); await settle(); (button(app.render(), "Claim for").props.onClick as () => void)();
  app.setProps({ campaignId: "new" }); app.render(); app.flush(); assert.equal(app.requests.length, 3);
  app.requests[1].resolve({ id: "old-claim", offerId: offer.id, status: "ISSUED" }); await settle(); assert.equal(app.requests.length, 3);
  app.requests[2].resolve({ offers: [{ ...offer, title: "New context reward" }], claims: [], points: 400 }); await settle(); assert.match(text(app.render()), /New context reward/);
});

test("Brand UI keeps unverified coupon branches draft-only: Active is disabled and forced off, with no provider detail", async () => {
  const app = harness("src/components/rewards/commerce7-brand-rewards.tsx", "Commerce7BrandRewardsPanel"); app.render(); app.flush(); app.requests[0].resolve(brandData); await settle();
  const activeBox = () => { const label = nodes(app.render()).find((node) => node.type === "label" && /Active and open for claims/.test(text(node))); assert.ok(label); const box = nodes(label).find((node) => node.type === "input" && node.props.type === "checkbox"); assert.ok(box); return box; };
  assert.equal(activeBox().props.disabled, false); (activeBox().props.onChange as (event: object) => void)({ target: { checked: true } }); assert.equal(activeBox().props.checked, true);
  change(select(app.render(), "ANYONE_WITH_CODE"), "CLAIMANT_ONLY");
  assert.equal(activeBox().props.disabled, true); assert.equal(activeBox().props.checked, false, "switching to an unverified branch clears Active");
  assert.match(text(app.render()), /saved as a draft/i); assert.doesNotMatch(text(app.render()), /enum|availableTo|appliesTo|Commerce7 API/i);
  change(select(app.render(), "CLAIMANT_ONLY"), "ANYONE_WITH_CODE"); assert.equal(activeBox().props.disabled, false);
  change(select(app.render(), "ALL_PRODUCTS"), "SPECIFIC_PRODUCTS"); assert.equal(activeBox().props.disabled, true);
  // The server stays authoritative: with no readiness payload the UI fails closed for unverified branches.
  const stale = harness("src/components/rewards/commerce7-brand-rewards.tsx", "Commerce7BrandRewardsPanel"); stale.render(); stale.flush(); stale.requests[0].resolve({ ...brandData, readiness: { backendConfigured: true } }); await settle();
  change(select(stale.render(), "ALL_PRODUCTS"), "SPECIFIC_PRODUCTS"); assert.equal((nodes(stale.render()).find((node) => node.type === "input" && node.props.type === "checkbox" && node.props.disabled === true))?.props.disabled, true);
});

test("a malformed money field is rejected in the form instead of being serialized as null (which would silently drop a minimum)", async () => {
  const app = harness("src/components/rewards/commerce7-brand-rewards.tsx", "Commerce7BrandRewardsPanel"); app.render(); app.flush(); app.requests[0].resolve(brandData); await settle();
  const input = (label: RegExp) => { const found = nodes(app.render()).find((node) => node.type === "label" && label.test(text(node))); assert.ok(found); return nodes(found).find((node) => node.type === "Input")!; };
  const submit = () => (nodes(app.render()).find((node) => node.type === "form")!.props.onSubmit as (event: object) => void)({ preventDefault() {} });
  (input(/Title/).props.onChange as (event: object) => void)({ target: { value: "Reward" } });
  for (const bad of ["1e2", "5,00", "12.345", "-1", "abc"]) {
    (input(/Minimum subtotal/).props.onChange as (event: object) => void)({ target: { value: bad } }); submit(); await settle();
    assert.equal(app.requests.length, 1, `no request for minimum ${bad}`); assert.match(text(app.render()), /minimum subtotal/i);
  }
  (input(/Minimum subtotal/).props.onChange as (event: object) => void)({ target: { value: "49.99" } });
  (input(/^Amount/).props.onChange as (event: object) => void)({ target: { value: "19.99" } }); submit();
  const body = JSON.parse(String(app.requests[1].init?.body)); assert.equal(body.minimumSubtotalCents, 4999); assert.equal(body.discountAmountCents, 1999);
  app.requests[1].reject(new Error("stop")); await settle();
  (input(/^Amount/).props.onChange as (event: object) => void)({ target: { value: "1e2" } }); submit(); await settle(); assert.equal(app.requests.length, 2); assert.match(text(app.render()), /amount/i);
});
