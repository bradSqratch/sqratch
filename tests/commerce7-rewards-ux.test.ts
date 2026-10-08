import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as formatting from "../src/lib/reward-formatting";
import * as contractModule from "../src/lib/commerce7-coupon-contract";
import * as safeRedirect from "../src/lib/safe-redirect";
import * as claimWindow from "../src/lib/reward-claim-window";
type Node = { type: string; props: Record<string, unknown> };
/** `DateImpl` pins "now" for date defaults; timers are fake and advanced explicitly; effects run React-style cleanups. */
function harness(path: string, exportName: string, props = {}, env: { DateImpl?: DateConstructor } = {}) {
  const states: unknown[] = []; const effects: unknown[][] = []; let index = 0; let effectIndex = 0; let effectsToRun: (() => void)[] = [];
  const cleanups: ((() => void) | undefined)[] = []; let unmounted = false;
  let clock = 0; let timerId = 0; const timers = new Map<number, { at: number; run: () => void }>();
  const fakeSetTimeout = (run: () => void, ms = 0) => { const id = ++timerId; timers.set(id, { at: clock + ms, run }); return id; };
  const fakeClearTimeout = (id: number) => { timers.delete(id); };
  const clipboard = { fail: false };
  const requests: { url: string; init?: RequestInit; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const storage = new Map<string, string>(); const copied: string[] = []; let requestKey = 0; const pushed: string[] = []; const location = { pathname: "/x/commerce7-demo-experience/shop", search: "" };
  const exports: Record<string, (props: object) => Node> = {};
  const react = {
    useState(initial: unknown) { const i = index++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial; return [states[i], (value: unknown) => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
    useRef(initial: unknown) { const i = index++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useCallback(value: unknown, deps: unknown[]) { const i = index++; const prior = states[i] as { deps: unknown[]; value: unknown } | undefined; if (!prior || !deps.every((dep, j) => Object.is(dep, prior.deps[j]))) states[i] = { deps, value }; return (states[i] as { value: unknown }).value; },
    useEffect(run: () => unknown, deps: unknown[]) { const i = effectIndex++; if (!effects[i] || !deps.every((dep, j) => Object.is(dep, effects[i][j]))) { effects[i] = deps; effectsToRun.push(() => { cleanups[i]?.(); const cleanup = run(); cleanups[i] = typeof cleanup === "function" ? cleanup as () => void : undefined; }); } },
  };
  const jsx = (type: string, props: object) => ({ type, props });
  runInNewContext(ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, URLSearchParams, Date: env.DateImpl ?? Date, Set, Map, Array, Number, JSON, String, Promise, Math, window: { location }, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, crypto: { randomUUID: () => `synthetic-client-request-key-${++requestKey}` }, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, navigator: { clipboard: { writeText: async (value: string) => { if (clipboard.fail) throw new Error("synthetic clipboard denial"); copied.push(value); } } },
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "next/navigation") return { useRouter: () => ({ refresh() {}, push(url: string) { pushed.push(url); } }) };
      if (name === "@/lib/safe-redirect") return safeRedirect;
      if (name === "@/lib/reward-formatting") return formatting;
      if (name === "@/lib/commerce7-coupon-contract") return contractModule;
      if (name === "@/lib/reward-claim-window") return claimWindow;
      if (name === "lucide-react") return new Proxy({}, { get: (_target, key) => `Icon:${String(key)}` });
      if (name === "@/components/experience/client-utils") return { fetchJson: (url: string, init?: RequestInit) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })), getErrorMessage: (error: Error) => error.message };
      if (name.startsWith("@/components/ui/")) return new Proxy({}, { get: (_target, key) => String(key) });
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return { requests, copied, storage, pushed, clipboard,
    /** Advances the fake clock and fires due timers. */
    advance(ms: number) { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.run(); } },
    pendingTimers: () => timers.size, unmount() { unmounted = true; cleanups.forEach((cleanup) => cleanup?.()); }, isUnmounted: () => unmounted,
    setLocation(pathname: string, search = "") { location.pathname = pathname; location.search = search; }, setProps(value: object) { props = value; }, render() { index = 0; effectIndex = 0; return exports[exportName](props); }, flush() { const work = effectsToRun; effectsToRun = []; work.forEach((run) => run()); } };
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

const brandData = { providers: { COMMERCE7: true, SHOPIFY: false }, connection: { displayName: "Winery", currencyCode: "CAD" }, readiness: { backendConfigured: true, couponContract }, offers: [], claims: [], products: [{ externalId: "wine-id", title: "Rare wine" }, { externalId: "second-wine", title: "Second wine" }], exclusiveProducts: [{ externalId: "wine-id", title: "Rare wine" }, { externalId: "second-wine", title: "Second wine" }] };
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
  change(select(stale.render(), "ANYONE_WITH_CODE"), "CLAIMANT_ONLY"); assert.equal((nodes(stale.render()).find((node) => node.type === "input" && node.props.type === "checkbox" && node.props.disabled === true))?.props.disabled, true);
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

const restricted = (viewerState: "SIGNED_OUT" | "LOCKED") => ({ viewerState, offers: [], claims: [], points: null });
async function mounted(props: object, response: unknown) { const app = harness("src/components/rewards/commerce7-rewards-client.tsx", "Commerce7RewardsClient", props); app.render(); app.flush(); app.requests[0].resolve(response); await settle(); return app; }

test("signed out: the card still renders with a Log in button and no reward, points, claim or coupon information", async () => {
  const app = await mounted({ experienceSlug: "commerce7-demo-experience", campaignId: "camp" }, restricted("SIGNED_OUT"));
  const tree = app.render(); const copy = text(tree);
  assert.match(copy, /Commerce7 rewards/); assert.match(copy, /Sign in to view the rewards available for this experience\./);
  assert.ok(nodes(tree).some((node) => node.type === "Button" && text(node).trim() === "Log in"));
  assert.ok(!nodes(tree).some((node) => node.type === "Button" && /Claim|Copy coupon|Cancel|retry/i.test(text(node))), "no action other than Log in");
  assert.doesNotMatch(copy, /spendable points|claims remaining|points ·|Claim for|coupon/i);
});
test("signed out: Log in returns to the exact current Experience Shop URL through the safe login callback", async () => {
  const app = await mounted({ experienceSlug: "commerce7-demo-experience" }, restricted("SIGNED_OUT"));
  app.setLocation("/x/commerce7-demo-experience/shop"); (button(app.render(), "Log in").props.onClick as () => void)();
  assert.deepEqual(app.pushed, ["/login?callbackUrl=%2Fx%2Fcommerce7-demo-experience%2Fshop"]);
  app.setLocation("/x/commerce7-demo-experience/shop", "?campaign=abc&tab=rewards"); (button(app.render(), "Log in").props.onClick as () => void)();
  assert.equal(app.pushed[1], "/login?callbackUrl=%2Fx%2Fcommerce7-demo-experience%2Fshop%3Fcampaign%3Dabc%26tab%3Drewards");
  assert.equal(decodeURIComponent(app.pushed[1].split("callbackUrl=")[1]), "/x/commerce7-demo-experience/shop?campaign=abc&tab=rewards");
});
test("signed out: a hostile current path can never become an open redirect", async () => {
  const app = await mounted({}, restricted("SIGNED_OUT"));
  for (const hostile of ["//evil.example/shop", "/\\evil.example", "https://evil.example/shop", "javascript:alert(1)"]) { app.setLocation(hostile); (button(app.render(), "Log in").props.onClick as () => void)(); }
  assert.ok(app.pushed.every((url) => url === "/login?callbackUrl=%2Fdashboard"), JSON.stringify(app.pushed));
});
test("locked: the card still renders with the unlock message and no points, offers, claims or actions", async () => {
  const app = await mounted({ experienceSlug: "commerce7-demo-experience", campaignId: "camp" }, restricted("LOCKED"));
  const tree = app.render(); const copy = text(tree);
  assert.match(copy, /Commerce7 rewards/); assert.match(copy, /You have not unlocked this campaign yet\. Scan and unlock this campaign to view its rewards\./);
  assert.ok(!nodes(tree).some((node) => node.type === "Button"), "no Claim, Log in or other button"); assert.doesNotMatch(copy, /spendable points|claims remaining|Claim for/i);
});
test("ready: the existing experience is unchanged, with or without the explicit marker; an empty ready state renders nothing", async () => {
  for (const marker of [{ viewerState: "READY" }, {}]) {
    const app = await mounted({ experienceSlug: "wine" }, { ...marker, offers: [offer], claims: [], points: 500 });
    const tree = app.render(); assert.match(text(tree), /500\s+spendable points/); assert.match(text(tree), /25\s+claims remaining/); assert.ok(button(tree, "Claim for"));
    assert.ok(!nodes(tree).some((node) => node.type === "Button" && text(node).trim() === "Log in"));
  }
  const empty = await mounted({ experienceSlug: "wine" }, { viewerState: "READY", offers: [], claims: [], points: 0 }); assert.equal(empty.render(), null);
});
test("a late response from another Experience/campaign can never render its state in the current context", async () => {
  const app = harness("src/components/rewards/commerce7-rewards-client.tsx", "Commerce7RewardsClient", { experienceSlug: "old", campaignId: "old-campaign" }); app.render(); app.flush();
  app.setProps({ experienceSlug: "new", campaignId: "new-campaign" }); app.render(); app.flush();
  app.requests[1].resolve(restricted("LOCKED")); await settle();
  app.requests[0].resolve({ viewerState: "READY", offers: [{ ...offer, title: "Old campaign offer" }], claims: [], points: 100 }); await settle();
  const tree = app.render(); assert.match(text(tree), /not unlocked this campaign/); assert.doesNotMatch(text(tree), /Old campaign offer/);
  const swapped = harness("src/components/rewards/commerce7-rewards-client.tsx", "Commerce7RewardsClient", { experienceSlug: "a" }); swapped.render(); swapped.flush();
  swapped.setProps({ experienceSlug: "b" }); swapped.render(); swapped.flush();
  swapped.requests[0].resolve(restricted("SIGNED_OUT")); await settle(); assert.equal(swapped.render(), null, "the old context's signed-out card is not shown while the new context loads");
});

test("Brand offer list: an active offer offers Disable, an inactive one offers Enable, and neither needs Edit", async () => {
  const app = harness("src/components/rewards/commerce7-brand-rewards.tsx", "Commerce7BrandRewardsPanel"); app.render(); app.flush();
  const saved = (id: string, isActive: boolean, redemptions: number) => ({ ...offer, id, title: `Offer ${id}`, appliesTo: "ALL_PRODUCTS", rewardMode: "DISCOUNT", isActive, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, totalClaims: redemptions, issuedCount: redemptions, _count: { redemptions }, commerce7Config: { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true }, products: [] });
  app.requests[0].resolve({ ...brandData, offers: [saved("live", true, 3), saved("paused", false, 3)] }); await settle();
  const tree = app.render(); const card = (id: string) => nodes(tree).filter((node) => node.type === "div" && text(node).includes(`Offer ${id}`) && nodes(node).some((child) => child.type === "Button" && /Edit/.test(text(child)))).at(-1)!; // innermost card, not a wrapper
  const labels = (id: string) => nodes(card(id)).filter((node) => node.type === "Button").map((node) => text(node).trim());
  assert.deepEqual(labels("live"), ["Edit", "Disable"]); assert.deepEqual(labels("paused"), ["Edit", "Enable"]);
  const pausedEdit = nodes(card("paused")).find((node) => node.type === "Button" && text(node).trim() === "Edit")!; assert.equal(pausedEdit.props.disabled, true, "offers with redemptions still cannot be edited");
  const enable = nodes(card("paused")).find((node) => node.type === "Button" && text(node).trim() === "Enable")!; assert.equal(enable.props.disabled, false, "a redeemed, disabled offer can be turned back on");
  (enable.props.onClick as () => void)(); (enable.props.onClick as () => void)();
  assert.equal(app.requests.length, 2, "a double click sends one request"); assert.equal(app.requests[1].url, "/api/brand/rewards/offers/paused"); assert.equal(app.requests[1].init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(app.requests[1].init?.body)), { action: "ENABLE" }); assert.equal((app.requests[1].init?.headers as Record<string, string>)["Content-Type"], "application/json");
  app.requests[1].resolve({}); await settle(); app.requests[2].resolve({ ...brandData, offers: [saved("live", true, 3), saved("paused", true, 3)] }); await settle();
  assert.match(text(app.render()), /Offer enabled/); const after = app.render();
  assert.deepEqual(nodes(after).filter((node) => node.type === "Button" && /^(Enable|Disable)$/.test(text(node).trim())).map((node) => text(node).trim()), ["Disable", "Disable"]);
  const disable = nodes(after).filter((node) => node.type === "Button" && text(node).trim() === "Disable")[0]; (disable.props.onClick as () => void)();
  assert.deepEqual(JSON.parse(String(app.requests[3].init?.body)), { action: "DISABLE" });
});

test("a refused Enable shows the server's safe message, leaves the offer inactive and offers no provider detail", async () => {
  const app = harness("src/components/rewards/commerce7-brand-rewards.tsx", "Commerce7BrandRewardsPanel"); app.render(); app.flush();
  const paused = { ...offer, id: "paused", title: "Paused offer", appliesTo: "ALL_PRODUCTS", rewardMode: "DISCOUNT", isActive: false, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, totalClaims: 0, issuedCount: 0, _count: { redemptions: 0 }, commerce7Config: { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: true }, products: [] };
  app.requests[0].resolve({ ...brandData, offers: [paused] }); await settle();
  (button(app.render(), "Enable").props.onClick as () => void)(); app.requests[1].reject(new Error("Claiming-customer-only rewards can be saved as drafts but cannot be activated yet.")); await settle();
  const tree = app.render(); assert.match(text(tree), /cannot be activated yet/); assert.ok(button(tree, "Enable"), "still inactive and re-triable"); assert.doesNotMatch(text(tree), /Offer enabled/);
});

// ── Reward mode transitions: rendered controls and submitted JSON must agree ──
async function brandForm(data: object = brandData) { const app = harness("src/components/rewards/commerce7-brand-rewards.tsx", "Commerce7BrandRewardsPanel"); app.render(); app.flush(); app.requests[0].resolve(data); await settle(); return app; }
const modeSelect = (app: ReturnType<typeof harness>) => nodes(app.render()).find((node) => node.type === "select" && (node.props.value === "DISCOUNT" || node.props.value === "EXCLUSIVE_PRODUCT_ACCESS"))!;
const setMode = (app: ReturnType<typeof harness>, mode: string) => change(modeSelect(app), mode);
const activeBox = (app: ReturnType<typeof harness>) => { const label = nodes(app.render()).find((node) => node.type === "label" && /Active and open for claims/.test(text(node)))!; return nodes(label).find((node) => node.type === "input")!; };
const oneTag = { tagCount: 1, multiTagAccessVerified: false, preselectedTagId: "tag-uuid-1", tags: [{ id: "tag-uuid-1", title: "Rare Wine Members", selectable: true, current: false, reason: null, sharedProductCount: 0, sharedProductTitles: [] }] };
/** Run the tag-options effect for the chosen exclusive product and answer its (latest) request. */
async function resolveTags(app: ReturnType<typeof harness>, value: object = oneTag) {
  app.render(); app.flush();
  const request = app.requests.filter((entry) => entry.url.startsWith("/api/brand/rewards/commerce7/exclusive-tags?")).at(-1); assert.ok(request, "tag options requested");
  request.resolve(value); await settle(); return request;
}
function submitted(app: ReturnType<typeof harness>) { const before = app.requests.length; (nodes(app.render()).find((node) => node.type === "form")!.props.onSubmit as (event: object) => void)({ preventDefault() {} }); assert.equal(app.requests.length, before + 1, "form submitted"); return JSON.parse(String(app.requests[before].init?.body)); }
function assertNormalDiscount(app: ReturnType<typeof harness>) {
  const tree = app.render(); const copy = text(tree);
  assert.equal(modeSelect(app).props.value, "DISCOUNT"); assert.ok(select(tree, "ANYONE_WITH_CODE")); assert.ok(select(tree, "ALL_PRODUCTS"));
  assert.equal(select(tree, "ANYONE_WITH_CODE").props.disabled, false); assert.equal(select(tree, "ALL_PRODUCTS").props.disabled, false);
  assert.equal(nodes(tree).filter((node) => node.type === "Checkbox").length, 0, "no product picker"); assert.doesNotMatch(copy, /exclusive product|Include an optional discount|saved as a draft but cannot be activated/i);
  assert.ok(nodes(tree).some((node) => node.type === "label" && /^Amount/.test(text(node).trim())), "discount amount input is shown");
  assert.equal(activeBox(app).props.disabled, false, "Active follows the verified discount branch again");
  const body = submitted(app);
  assert.deepEqual({ rewardMode: body.rewardMode, eligibilityMode: body.eligibilityMode, appliesTo: body.appliesTo, productIds: body.productIds, discountEnabled: body.discountEnabled, discountType: body.discountType }, { rewardMode: "DISCOUNT", eligibilityMode: "ANYONE_WITH_CODE", appliesTo: "ALL_PRODUCTS", productIds: [], discountEnabled: true, discountType: "FIXED_AMOUNT" });
  assert.equal(typeof body.discountAmountCents, "number");
}

test("entering exclusive access forces claimant-only, selected products, inactive, no products, optional discount, and keeps common fields", async () => {
  const app = await brandForm();
  const title = nodes(app.render()).find((node) => node.type === "label" && /^Title/.test(text(node).trim()))!; (nodes(title).find((node) => node.type === "Input")!.props.onChange as (e: object) => void)({ target: { value: "Rare wine" } });
  (activeBox(app).props.onChange as (e: object) => void)({ target: { checked: true } });
  change(select(app.render(), "ALL_PRODUCTS"), "SPECIFIC_PRODUCTS"); (product(app.render(), "Rare wine").props.onCheckedChange as (v: boolean) => void)(true); (product(app.render(), "Second wine").props.onCheckedChange as (v: boolean) => void)(true);
  setMode(app, "EXCLUSIVE_PRODUCT_ACCESS"); const tree = app.render();
  assert.equal(select(tree, "CLAIMANT_ONLY").props.disabled, true); assert.equal(select(tree, "SPECIFIC_PRODUCTS").props.disabled, true);
  assert.equal(activeBox(app).props.checked, false); assert.equal(activeBox(app).props.disabled, true);
  assert.equal(product(tree, "Rare wine").props.checked, false, "a multi-product discount selection does not leak into exclusive access"); assert.match(text(tree), /Select exactly one exclusive product/);
  (nodes(app.render()).find((node) => node.type === "form")!.props.onSubmit as (event: object) => void)({ preventDefault() {} }); await settle();
  assert.equal(app.requests.length, 1, "exclusive access with no product is refused before any request"); assert.match(text(app.render()), /Select at least one product/);
  (product(app.render(), "Second wine").props.onCheckedChange as (v: boolean) => void)(true); (product(app.render(), "Rare wine").props.onCheckedChange as (v: boolean) => void)(true);
  const tagRequest = await resolveTags(app); assert.match(tagRequest.url, /productId=wine-id/, "the latest product choice wins");
  const body = submitted(app); assert.equal(body.exclusiveTagId, "tag-uuid-1"); assert.equal(body.title, "Rare wine"); assert.equal(body.rewardMode, "EXCLUSIVE_PRODUCT_ACCESS"); assert.equal(body.eligibilityMode, "CLAIMANT_ONLY"); assert.equal(body.appliesTo, "SPECIFIC_PRODUCTS"); assert.equal(body.isActive, false); assert.equal(body.discountEnabled, false); assert.deepEqual(body.productIds, ["wine-id"], "exactly one product: a new choice replaces the previous one");
});

test("EXCLUSIVE -> DISCOUNT resets every exclusive-only state to the normal discount defaults", async () => {
  const app = await brandForm(); setMode(app, "EXCLUSIVE_PRODUCT_ACCESS"); (product(app.render(), "Rare wine").props.onCheckedChange as (v: boolean) => void)(true);
  setMode(app, "DISCOUNT"); assertNormalDiscount(app);
});

test("DISCOUNT -> EXCLUSIVE -> DISCOUNT returns to a clean discount, keeping the common fields", async () => {
  const app = await brandForm();
  const points = nodes(app.render()).find((node) => node.type === "label" && /^Points cost/.test(text(node).trim()))!; (nodes(points).find((node) => node.type === "Input")!.props.onChange as (e: object) => void)({ target: { value: "250" } });
  change(select(app.render(), "ANYONE_WITH_CODE"), "CLAIMANT_ONLY");
  setMode(app, "EXCLUSIVE_PRODUCT_ACCESS"); (product(app.render(), "Second wine").props.onCheckedChange as (v: boolean) => void)(true);
  setMode(app, "DISCOUNT"); assertNormalDiscount(app);
  app.requests[1].reject(new Error("stop")); await settle(); assert.equal(submitted(app).pointsCost, 250);
});

test("a percentage discount type survives a round trip through exclusive access", async () => {
  const app = await brandForm(); change(select(app.render(), "FIXED_AMOUNT"), "PERCENTAGE");
  setMode(app, "EXCLUSIVE_PRODUCT_ACCESS"); setMode(app, "DISCOUNT");
  const body = submitted(app); assert.equal(body.discountType, "PERCENTAGE"); assert.equal(body.discountEnabled, true); assert.equal(body.discountPercentageBasisPoints, 1500); assert.equal(body.discountAmountCents, null);
});

test("editing an existing exclusive draft and switching it to a discount submits a clean discount edit", async () => {
  const draft = { ...offer, id: "draft", title: "Rare wine access", appliesTo: "SPECIFIC_PRODUCTS", rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", isActive: false, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, totalClaims: 0, issuedCount: 0, editable: true, _count: { redemptions: 0 }, commerce7Config: { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: false }, products: [{ externalProductId: "wine-id" }] };
  const app = await brandForm({ ...brandData, offers: [draft] });
  (button(app.render(), "Edit").props.onClick as () => void)(); assert.equal(modeSelect(app).props.value, "EXCLUSIVE_PRODUCT_ACCESS"); assert.equal(product(app.render(), "Rare wine").props.checked, true);
  setMode(app, "DISCOUNT"); assertNormalDiscount(app);
  assert.equal(app.requests[1].url, "/api/brand/rewards/offers/draft"); assert.equal(app.requests[1].init?.method, "PUT"); assert.equal(JSON.parse(String(app.requests[1].init?.body)).title, "Rare wine access");
});

test("rapid repeated mode changes from one stale handler always settle on the last choice with consistent state", async () => {
  const app = await brandForm(); const handler = modeSelect(app).props.onChange as (event: object) => void; // captured once, as a stale render's handler would be
  for (const mode of ["EXCLUSIVE_PRODUCT_ACCESS", "DISCOUNT", "EXCLUSIVE_PRODUCT_ACCESS", "EXCLUSIVE_PRODUCT_ACCESS", "DISCOUNT"]) handler({ target: { value: mode } });
  assertNormalDiscount(app);
  const again = await brandForm(); const stale = modeSelect(again).props.onChange as (event: object) => void;
  for (const mode of ["DISCOUNT", "EXCLUSIVE_PRODUCT_ACCESS", "DISCOUNT", "EXCLUSIVE_PRODUCT_ACCESS"]) stale({ target: { value: mode } });
  (product(again.render(), "Rare wine").props.onCheckedChange as (v: boolean) => void)(true); await resolveTags(again);
  const body = submitted(again); assert.deepEqual(body.productIds, ["wine-id"]); assert.deepEqual([body.rewardMode, body.eligibilityMode, body.appliesTo, body.isActive, body.discountEnabled], ["EXCLUSIVE_PRODUCT_ACCESS", "CLAIMANT_ONLY", "SPECIFIC_PRODUCTS", false, false]);
});

test("Edit follows the server's editability verdict: enabled for provably dead claims, disabled for live ones", async () => {
  const listed = (id: string, editable: boolean | undefined, redemptions: number) => ({ ...offer, id, title: `Offer ${id}`, appliesTo: "ALL_PRODUCTS", rewardMode: "DISCOUNT", isActive: false, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, totalClaims: 0, issuedCount: 0, ...(editable === undefined ? {} : { editable }), _count: { redemptions }, commerce7Config: { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true }, products: [] });
  const app = await brandForm({ ...brandData, offers: [listed("refunded", true, 1), listed("issued", false, 1), listed("legacy-payload", undefined, 1), listed("fresh", undefined, 0)] });
  const tree = app.render(); const editOf = (id: string) => nodes(nodes(tree).filter((node) => node.type === "div" && text(node).includes(`Offer ${id}`) && nodes(node).some((child) => child.type === "Button" && /Edit/.test(text(child)))).at(-1)!).find((node) => node.type === "Button" && text(node).trim() === "Edit")!;
  assert.equal(editOf("refunded").props.disabled, false, "a definitively failed, refunded claim no longer locks the offer");
  assert.equal(editOf("issued").props.disabled, true); assert.equal(editOf("legacy-payload").props.disabled, true, "without a verdict, any history still locks"); assert.equal(editOf("fresh").props.disabled, false);
});

// ── Exclusive Wine Access picker (lower-permission model) ──
const setupNote = "Only Commerce7 products secured to a Customer Tag are shown here. Configure the product's Security in Commerce7 first, then sync products in SQRATCH.";
const noneNote = "No eligible exclusive products found. In Commerce7, secure the product to a Customer Tag, save it, then return to SQRATCH → Products and sync.";
const catalogData = { ...brandData, products: [{ externalId: "rare", title: "Rare - 2015 Chardonnay" }, { externalId: "sample", title: "Sample Public Wine" }], exclusiveProducts: [{ externalId: "rare", title: "Rare - 2015 Chardonnay" }] };
const pickerTitles = (app: ReturnType<typeof harness>) => nodes(app.render()).filter((node) => node.type === "label" && nodes(node).some((child) => child.type === "Checkbox")).map((node) => text(node).trim());

test("Exclusive picker shows only Customer-Tag-secured products, with the setup note; Discount still shows every product", async () => {
  const app = await brandForm(catalogData);
  change(select(app.render(), "ALL_PRODUCTS"), "SPECIFIC_PRODUCTS");
  assert.deepEqual(pickerTitles(app), ["Rare - 2015 Chardonnay", "Sample Public Wine"], "the Discount picker is unchanged");
  assert.ok(!text(app.render()).includes(setupNote));
  setMode(app, "EXCLUSIVE_PRODUCT_ACCESS");
  assert.deepEqual(pickerTitles(app), ["Rare - 2015 Chardonnay"]); assert.ok(text(app.render()).includes(setupNote)); assert.ok(!text(app.render()).includes(noneNote));
  (product(app.render(), "Rare - 2015 Chardonnay").props.onCheckedChange as (v: boolean) => void)(true); await resolveTags(app);
  assert.deepEqual(submitted(app).productIds, ["rare"]);
});

test("with no qualifying product the Exclusive picker explains how to secure one, and never shows public products", async () => {
  for (const data of [{ ...catalogData, exclusiveProducts: [] }, (({ exclusiveProducts: _omit, ...rest }) => { void _omit; return rest; })(catalogData)]) {
    const app = await brandForm(data); setMode(app, "EXCLUSIVE_PRODUCT_ACCESS");
    assert.deepEqual(pickerTitles(app), []); const copy = text(app.render());
    assert.ok(copy.includes(noneNote)); assert.ok(copy.includes(setupNote)); assert.ok(!copy.includes("Sync the Commerce7 catalog."), "the discount empty-state is not shown for exclusive");
  }
});

test("exclusive drafts show their security status in plain words, never a Customer Tag UUID", async () => {
  const draft = (id: string, exclusiveAccessStatus: string) => ({ ...offer, id, title: `Draft ${id}`, appliesTo: "SPECIFIC_PRODUCTS", rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", isActive: false, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, totalClaims: 0, issuedCount: 0, editable: true, exclusiveAccessStatus, _count: { redemptions: 0 }, commerce7Config: { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: false }, products: [{ externalProductId: "rare" }] });
  const app = await brandForm({ ...catalogData, offers: [draft("ok", "CONFIGURED"), draft("changed", "SECURITY_CHANGED"), draft("gone", "PRODUCT_UNAVAILABLE"), draft("multi", "MULTI_TAG_UNVERIFIED"), draft("removed", "TAG_REMOVED")] });
  const copy = text(app.render());
  assert.match(copy, /secured to the selected Customer Tag in Commerce7/); assert.match(copy, /security changed in Commerce7/i); assert.match(copy, /no longer synchronized/i);
  assert.match(copy, /several Customer Tags.*stays a draft/); assert.match(copy, /no longer secures this product/);
  assert.doesNotMatch(copy, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.equal(nodes(app.render()).filter((node) => node.type === "Button" && text(node).trim() === "Enable").length, 5, "the button is shown; the server verifies native state before enabling");
});

// ── Exclusive Wine Access: tag selection, warnings and claim states ──
const tagSelect = (app: ReturnType<typeof harness>) => nodes(app.render()).find((node) => node.type === "select" && node.props["aria-label"] === "Customer Tag SQRATCH grants");
const twoTags = { tagCount: 2, multiTagAccessVerified: false, preselectedTagId: null, tags: [
  { id: "tag-uuid-1", title: "Rare Wine Members", selectable: true, current: false, reason: null, sharedProductCount: 2, sharedProductTitles: ["Library Cabernet", "Old Vine Zin"] },
  { id: "tag-uuid-2", title: "Club Auto Segment", selectable: false, current: false, reason: "NOT_MANUAL", sharedProductCount: 0, sharedProductTitles: [] },
] };

test("a single-tag product preselects its tag, shows titles never UUIDs, and can be activated", async () => {
  const app = await brandForm(catalogData); setMode(app, "EXCLUSIVE_PRODUCT_ACCESS");
  (product(app.render(), "Rare - 2015 Chardonnay").props.onCheckedChange as (v: boolean) => void)(true);
  assert.match(text(app.render()), /Loading this product.s Customer Tags/); assert.equal(activeBox(app).props.disabled, true, "no activation before a tag is chosen");
  await resolveTags(app);
  assert.equal(tagSelect(app)?.props.value, "tag-uuid-1"); const copy = text(app.render());
  assert.match(copy, /Rare Wine Members/); assert.doesNotMatch(copy, /tag-uuid/, "the UUID is only an option value"); assert.match(copy, /same verified email/);
  assert.equal(activeBox(app).props.disabled, false); (activeBox(app).props.onChange as (e: object) => void)({ target: { checked: true } });
  const body = submitted(app); assert.equal(body.exclusiveTagId, "tag-uuid-1"); assert.equal(body.isActive, true);
});

test("several tags require an explicit choice, warn that other tags may grant access and that a shared tag may unlock other products, and stay draft-only", async () => {
  const app = await brandForm(catalogData); setMode(app, "EXCLUSIVE_PRODUCT_ACCESS");
  (product(app.render(), "Rare - 2015 Chardonnay").props.onCheckedChange as (v: boolean) => void)(true); await resolveTags(app, twoTags);
  assert.equal(tagSelect(app)?.props.value, "", "no preselection with several tags");
  const options = nodes(tagSelect(app)!).filter((node) => node.type === "option");
  assert.deepEqual(options.map((node) => [node.props.value, node.props.disabled === true]), [["", false], ["tag-uuid-1", false], ["tag-uuid-2", true]]);
  assert.match(text(options[2]), /Club Auto Segment.*not a Manual tag/);
  let copy = text(app.render()); assert.match(copy, /secured to\s+2\s+Customer Tags/); assert.match(copy, /may not be the only way to access it/); assert.match(copy, /can be saved but not activated/);
  const before = app.requests.length; (nodes(app.render()).find((node) => node.type === "form")!.props.onSubmit as (event: object) => void)({ preventDefault() {} }); await settle();
  assert.equal(app.requests.length, before, "no save without an explicit tag"); assert.match(text(app.render()), /Choose which Customer Tag SQRATCH should grant/);
  change(tagSelect(app)!, "tag-uuid-1"); copy = text(app.render());
  assert.match(copy, /also secures\s+2\s+other product\s*s/); assert.match(copy, /Library Cabernet, Old Vine Zin/); assert.match(copy, /may unlock those products too/);
  assert.equal(activeBox(app).props.disabled, true, "multi-tag access is unverified: draft only");
  const body = submitted(app); assert.equal(body.exclusiveTagId, "tag-uuid-1"); assert.equal(body.isActive, false);
});

test("choosing another exclusive product clears the chosen tag; a failed tag lookup is shown and blocks saving", async () => {
  const app = await brandForm(); setMode(app, "EXCLUSIVE_PRODUCT_ACCESS");
  (product(app.render(), "Rare wine").props.onCheckedChange as (v: boolean) => void)(true); await resolveTags(app);
  assert.equal(tagSelect(app)?.props.value, "tag-uuid-1");
  (product(app.render(), "Second wine").props.onCheckedChange as (v: boolean) => void)(true); app.render(); app.flush();
  assert.equal(tagSelect(app), undefined, "the old product's tags are not offered for the new product");
  app.requests.filter((entry) => entry.url.includes("exclusive-tags")).at(-1)!.reject(new Error("Commerce7 could not complete this reward. Retry or contact the store.")); await settle();
  assert.match(text(app.render()), /Commerce7 could not complete this reward/);
  const before = app.requests.length; (nodes(app.render()).find((node) => node.type === "form")!.props.onSubmit as (event: object) => void)({ preventDefault() {} }); await settle();
  assert.equal(app.requests.length, before);
});

test("Brand claims show exclusive access state and ownership guidance, never the merchant's tag UUID or a revoke action", async () => {
  const claim = (id: string, accessState: string, membershipGuidance: string | null) => ({ id, title: `Claim ${id}`, status: accessState === "ACCESS_GRANTED" ? "ISSUED" : "POINTS_DEBITED", provisioningState: accessState === "MANUAL_REVIEW" ? "MANUAL_REVIEW" : "READY", providerCustomerId: "customer-1", providerTagId: null, tagTitle: null, message: null, ownerActive: false, canRevoke: false, canonicalOrderId: null, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", accessState, membershipGuidance });
  const app = await brandForm({ ...brandData, claims: [claim("granted", "ACCESS_GRANTED", "SQRATCH_GRANTED"), claim("native", "ACCESS_GRANTED", "NOT_SQRATCH_OWNED"), claim("review", "MANUAL_REVIEW", "OWNERSHIP_UNVERIFIED"), claim("shared", "ACCESS_GRANTED", "SHARED_WITH_OTHER_REWARDS")] });
  const copy = text(app.render());
  assert.match(copy, /Access granted/); assert.match(copy, /SQRATCH granted this tag/); assert.match(copy, /already had this tag before the claim/); assert.match(copy, /cannot prove it created it/); assert.match(copy, /another active SQRATCH reward also relies on it/);
  assert.match(copy, /never removes Customer Tags/); assert.match(copy, /removes every copy of a tag/); assert.doesNotMatch(copy, /add the manual tag/, "the per-claim CRM handoff text is for claimant coupons only");
  assert.ok(!nodes(app.render()).some((node) => node.type === "Button" && /Revoke/.test(text(node))));
});

const exclusiveOffer = { ...offer, id: "exclusive", title: "Rare Chardonnay access", rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", accessOnly: true, productTitles: ["Rare - 2015 Chardonnay"], discountAmountCents: null, eligibilityMode: "CLAIMANT_ONLY", minimumSubtotalCents: null };
test("claimant exclusive card explains Commerce7 storefront access; an already-eligible customer sees a no-charge notice and no claim", async () => {
  const app = harness("src/components/rewards/commerce7-rewards-client.tsx", "Commerce7RewardsClient", { experienceSlug: "wine" }); app.render(); app.flush();
  app.requests[0].resolve({ viewerState: "READY", offers: [exclusiveOffer], claims: [], points: 500 }); await settle();
  let copy = text(app.render());
  assert.match(copy, /Exclusive access\s*:\s*Rare - 2015 Chardonnay/); assert.doesNotMatch(copy, /store must approve your Customer tag/, "no manual CRM approval for exclusive access"); assert.match(copy, /Commerce7 customer account with the same verified email/); assert.match(copy, /Log in to the store.s Commerce7 online shop to buy/); assert.match(copy, /already has this access, no points are spent/);
  assert.doesNotMatch(copy, /\$10\.00 off|valid for 30 days|Minimum subtotal/, "an access-only reward shows no coupon terms"); assert.doesNotMatch(copy, /coupon is required|reserve(d)? inventory for you/i);
  (button(app.render(), "Claim access for").props.onClick as () => void)();
  const key = JSON.parse(String(app.requests[1].init?.body)).idempotencyKey;
  app.requests[1].resolve({ alreadyEligible: true, offerId: "exclusive", message: "Your Commerce7 account already has this access. No points were spent." }); await settle();
  app.requests[2].resolve({ viewerState: "READY", offers: [exclusiveOffer], claims: [], points: 500 }); await settle();
  copy = text(app.render()); assert.match(copy, /already has this access. No points were spent/);
  assert.equal(app.storage.get("sqratch:c7-claim:exclusive"), undefined, "the request key is released"); assert.ok(key);
});

test("claimant exclusive claim states: waiting for account, confirmation pending, granted, already eligible, review, closed; the discount code is labelled", async () => {
  const claim = (id: string, accessState: string, extra: object = {}) => ({ id, offerId: "exclusive", title: `Access ${id}`, status: "POINTS_DEBITED", provisioningState: "PROVISIONING", code: null, expiresAt: null, canRetry: true, canCancel: false, message: null, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", accessState, accessGranted: false, ...extra });
  const app = harness("src/components/rewards/commerce7-rewards-client.tsx", "Commerce7RewardsClient"); app.render(); app.flush();
  app.requests[0].resolve({ viewerState: "READY", offers: [], points: 400, claims: [
    claim("wait", "WAITING_FOR_CUSTOMER", { canCancel: true }), claim("pending", "CONFIRMATION_PENDING"), claim("granted", "ACCESS_GRANTED", { status: "ISSUED", canRetry: false, accessGranted: true }),
    claim("native", "ALREADY_ELIGIBLE", { status: "REFUNDED", canRetry: false }), claim("review", "MANUAL_REVIEW", { canRetry: false, accessGranted: true }), claim("closed", "FAILED", { status: "REFUNDED", canRetry: false }),
    claim("discount", "ACCESS_GRANTED", { status: "ISSUED", canRetry: false, accessGranted: true, code: "SQRA-EXCLUSIVE", expiresAt: "2027-01-01T00:00:00.000Z" }),
  ] }); await settle();
  const copy = text(app.render());
  for (const label of ["Waiting for your Commerce7 account", "Waiting for Commerce7 to confirm your access", "Access granted", "Already eligible: no points spent", "Store review needed", "Claim closed"]) assert.ok(copy.includes(label), label);
  assert.match(copy, /verified SQRATCH email, then check again/); assert.match(copy, /will not be requested twice/); assert.match(copy, /Your Commerce7 access is active/, "access granted while the discount is under review");
  assert.match(copy, /SQRA-EXCLUSIVE/); assert.match(copy, /Single-use discount for this wine/); assert.match(copy, /keep it private/);
  assert.equal(nodes(app.render()).filter((node) => node.type === "Button" && /Cancel and return points/.test(text(node))).length, 1, "only the waiting claim, where nothing was written, can be cancelled");
});

// ── B: Copy coupon feedback resets ──
const readyClaim = (id: string, codeValue: string) => ({ id, offerId: `offer-${id}`, title: `Reward ${id}`, status: "ISSUED", provisioningState: "READY", code: codeValue, expiresAt: "2027-01-01T00:00:00.000Z", canRetry: false, canCancel: false, message: null });
async function claimsCard(claims: object[]) { const app = harness("src/components/rewards/commerce7-rewards-client.tsx", "Commerce7RewardsClient"); app.render(); app.flush(); app.requests[0].resolve({ viewerState: "READY", offers: [], claims, points: 100 }); await settle(); return app; }
const copyButtons = (app: ReturnType<typeof harness>) => nodes(app.render()).filter((node) => node.type === "Button" && /^(Copy coupon|Copied)$/.test(text(node).trim()));
const labelsOf = (app: ReturnType<typeof harness>) => copyButtons(app).map((node) => text(node).trim());

test("Copy coupon -> Copied -> Copy coupon after two seconds, with an accessible announcement and no server request", async () => {
  const app = await claimsCard([readyClaim("a", "SQRA-COPY-A")]); const before = app.requests.length;
  (copyButtons(app)[0].props.onClick as () => void)(); await settle();
  assert.deepEqual(labelsOf(app), ["Copied"]); assert.deepEqual(app.copied, ["SQRA-COPY-A"]);
  assert.ok(nodes(app.render()).some((node) => node.props.role === "status" && node.props["aria-live"] === "polite" && /Coupon code copied/.test(text(node))));
  app.advance(1999); assert.deepEqual(labelsOf(app), ["Copied"]);
  app.advance(1); assert.deepEqual(labelsOf(app), ["Copy coupon"]); assert.equal(app.pendingTimers(), 0);
  assert.equal(app.requests.length, before, "copying never calls the server"); assert.match(text(app.render()), /SQRA-COPY-A/, "the code itself is unchanged");
});

test("clicking again restarts the feedback period; several coupons keep independent labels", async () => {
  const app = await claimsCard([readyClaim("a", "SQRA-COPY-A"), readyClaim("b", "SQRA-COPY-B")]);
  (copyButtons(app)[0].props.onClick as () => void)(); await settle(); app.advance(1500);
  (copyButtons(app)[0].props.onClick as () => void)(); await settle(); app.advance(1000);
  assert.deepEqual(labelsOf(app), ["Copied", "Copy coupon"], "restarted: still Copied 2.5s after the first click");
  app.advance(1000); assert.deepEqual(labelsOf(app), ["Copy coupon", "Copy coupon"]);
  (copyButtons(app)[0].props.onClick as () => void)(); await settle(); (copyButtons(app)[1].props.onClick as () => void)(); await settle();
  assert.deepEqual(labelsOf(app), ["Copy coupon", "Copied"], "only the most recently copied coupon shows Copied"); assert.deepEqual(app.copied.slice(-2), ["SQRA-COPY-A", "SQRA-COPY-B"]);
  app.advance(2000); assert.deepEqual(labelsOf(app), ["Copy coupon", "Copy coupon"]); assert.equal(app.pendingTimers(), 0);
});

test("a failed clipboard write never says Copied and explains how to copy manually, on that card only", async () => {
  const app = await claimsCard([readyClaim("a", "SQRA-COPY-A"), readyClaim("b", "SQRA-COPY-B")]); app.clipboard.fail = true;
  (copyButtons(app)[1].props.onClick as () => void)(); await settle();
  assert.deepEqual(labelsOf(app), ["Copy coupon", "Copy coupon"]); assert.equal(app.pendingTimers(), 0);
  const cards = nodes(app.render()).filter((node) => node.type === "article");
  assert.match(text(cards[1]), /Could not copy automatically/); assert.doesNotMatch(text(cards[0]), /Could not copy/);
  app.clipboard.fail = false; (copyButtons(app)[1].props.onClick as () => void)(); await settle();
  assert.deepEqual(labelsOf(app), ["Copy coupon", "Copied"]); assert.doesNotMatch(text(app.render()), /Could not copy/);
});

test("unmounting clears the pending Copied timer", async () => {
  const app = await claimsCard([readyClaim("a", "SQRA-COPY-A")]);
  (copyButtons(app)[0].props.onClick as () => void)(); await settle(); assert.equal(app.pendingTimers(), 1);
  app.unmount(); assert.equal(app.pendingTimers(), 0);
});

// ── C: default claim window ──
function pinnedDate(start: string) {
  const clock = { now: Date.parse(start) };
  class PinnedDate extends Date { constructor(...args: unknown[]) { if (args.length) super(...(args as [string])); else super(clock.now); } static now() { return clock.now; } }
  return { clock, PinnedDate: PinnedDate as unknown as DateConstructor };
}
const dateInput = (app: ReturnType<typeof harness>, label: RegExp) => { const found = nodes(app.render()).find((node) => node.type === "label" && label.test(text(node))); assert.ok(found, String(label)); return nodes(found).find((node) => node.type === "Input")!; };

test("a new reward is prefilled with Now through 30 calendar days later, computed when the form opens", async () => {
  const { clock, PinnedDate } = pinnedDate("2026-10-08T12:13:47.000Z");
  const app = harness("src/components/rewards/commerce7-brand-rewards.tsx", "Commerce7BrandRewardsPanel", {}, { DateImpl: PinnedDate }); app.render(); app.flush();
  app.requests[0].resolve(brandData); await settle();
  const expected = claimWindow.defaultClaimWindow(new Date(clock.now));
  assert.equal(dateInput(app, /Claim starts/).props.value, expected.starts); assert.equal(dateInput(app, /Claim ends/).props.value, expected.ends);
  assert.match(text(app.render()), /Clear a date to leave that side of the claim window open/);
  const body = submitted(app); assert.equal(body.claimStartsAt, claimWindow.claimWindowIso(expected.starts)); assert.equal(body.claimEndsAt, claimWindow.claimWindowIso(expected.ends));
  assert.equal(body.codeValidDays, 30, "coupon validity stays its own field");
  // After a successful save the next new reward uses the clock at that moment, not the first render's.
  clock.now = Date.parse("2026-10-20T15:00:00.000Z");
  app.requests[1].resolve({}); await settle(); app.requests[2].resolve(brandData); await settle();
  assert.equal(dateInput(app, /Claim starts/).props.value, claimWindow.defaultClaimWindow(new Date(clock.now)).starts);
});

test("the operator can override or clear either date; an end before the start is refused before any request", async () => {
  const app = await brandForm();
  (dateInput(app, /Claim ends/).props.onChange as (event: object) => void)({ target: { value: "" } });
  assert.equal(submitted(app).claimEndsAt, null, "a cleared end stays open-ended");
  const second = await brandForm();
  (dateInput(second, /Claim starts/).props.onChange as (event: object) => void)({ target: { value: "2026-12-01T10:00" } });
  (dateInput(second, /Claim ends/).props.onChange as (event: object) => void)({ target: { value: "2026-11-01T10:00" } });
  const before = second.requests.length; (nodes(second.render()).find((node) => node.type === "form")!.props.onSubmit as (event: object) => void)({ preventDefault() {} }); await settle();
  assert.equal(second.requests.length, before); assert.match(text(second.render()), /Claim end must be after claim start/);
});

test("editing an existing open-ended reward keeps it open-ended and never applies the 30-day default", async () => {
  const openEnded = { ...offer, id: "open", title: "Open reward", appliesTo: "ALL_PRODUCTS", rewardMode: "DISCOUNT", isActive: false, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, totalClaims: 0, issuedCount: 0, editable: true, claimStartsAt: null, claimEndsAt: null, _count: { redemptions: 0 }, commerce7Config: { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true }, products: [] };
  const app = await brandForm({ ...brandData, offers: [openEnded] });
  (button(app.render(), "Edit").props.onClick as () => void)();
  assert.equal(dateInput(app, /Claim starts/).props.value, ""); assert.equal(dateInput(app, /Claim ends/).props.value, "");
  const body = submitted(app); assert.equal(body.claimStartsAt, null); assert.equal(body.claimEndsAt, null);
  assert.match(text(app.render()), /Claim window: open/, "the offer card states the window plainly");
});

// ── D: compact removable product chips ──
test("selected products are compact chips with an icon-only, labelled remove button", async () => {
  const app = await brandForm(); change(select(app.render(), "ALL_PRODUCTS"), "SPECIFIC_PRODUCTS");
  (product(app.render(), "Rare wine").props.onCheckedChange as (v: boolean) => void)(true); (product(app.render(), "Second wine").props.onCheckedChange as (v: boolean) => void)(true);
  const tree = app.render(); assert.doesNotMatch(text(tree), /· Remove/, "no 'Remove' word");
  const list = nodes(tree).find((node) => node.type === "ul" && node.props["aria-label"] === "Selected products")!; assert.match(String(list.props.className), /flex-wrap/);
  const remove = nodes(list).filter((node) => node.type === "button");
  assert.deepEqual(remove.map((node) => node.props["aria-label"]), ["Remove Rare wine", "Remove Second wine"]); assert.equal(remove[0].props.type, "button");
  assert.ok(nodes(remove[0]).some((node) => node.type === "Icon:X"), "an X icon"); assert.equal(text(remove[0]).trim(), "", "icon only");
  (remove[0].props.onClick as () => void)();
  assert.deepEqual(submitted(app).productIds, ["second-wine"], "removing a chip unselects only that product");
});

test("removing the exclusive product chip clears the chosen tag, the tag options and Active", async () => {
  const app = await brandForm(); setMode(app, "EXCLUSIVE_PRODUCT_ACCESS");
  (product(app.render(), "Rare wine").props.onCheckedChange as (v: boolean) => void)(true); await resolveTags(app);
  (activeBox(app).props.onChange as (event: object) => void)({ target: { checked: true } }); assert.equal(activeBox(app).props.checked, true);
  const chip = nodes(app.render()).find((node) => node.type === "button" && node.props["aria-label"] === "Remove Rare wine")!; (chip.props.onClick as () => void)();
  app.render(); app.flush();
  assert.equal(tagSelect(app), undefined); assert.equal(activeBox(app).props.checked, false); assert.equal(product(app.render(), "Rare wine").props.checked, false);
  const before = app.requests.length; (nodes(app.render()).find((node) => node.type === "form")!.props.onSubmit as (event: object) => void)({ preventDefault() {} }); await settle();
  assert.equal(app.requests.length, before, "nothing to save without a product and tag");
});

// ── E/F: exclusive picker diagnostics and multi-tag guidance ──
test("when product security has not been read, the picker says so and how to fix it instead of claiming no products exist", async () => {
  const app = await brandForm({ ...catalogData, exclusiveProducts: [], exclusiveDiagnostics: { securityUnknownCount: 10, lastProductSyncAt: "2026-10-07T17:59:14.383Z" } });
  setMode(app, "EXCLUSIVE_PRODUCT_ACCESS"); const copy = text(app.render());
  assert.ok(!copy.includes(noneNote), "not 'No eligible exclusive products found'");
  assert.match(copy, /Product Security has not been read yet for\s+10\s+synchronized product/); assert.match(copy, /Products → Sync/);
  const partial = await brandForm({ ...catalogData, exclusiveDiagnostics: { securityUnknownCount: 3, lastProductSyncAt: null } }); setMode(partial, "EXCLUSIVE_PRODUCT_ACCESS");
  assert.deepEqual(pickerTitles(partial), ["Rare - 2015 Chardonnay"]); assert.match(text(partial.render()), /security has not been read yet for\s+3/i);
  const known = await brandForm({ ...catalogData, exclusiveProducts: [], exclusiveDiagnostics: { securityUnknownCount: 0, lastProductSyncAt: null } }); setMode(known, "EXCLUSIVE_PRODUCT_ACCESS");
  assert.ok(text(known.render()).includes(noneNote), "with every product's security known, the original guidance stands");
});

test("a multi-tag product explains exactly why it is draft-only and what sandbox evidence would enable it", async () => {
  const app = await brandForm(catalogData); setMode(app, "EXCLUSIVE_PRODUCT_ACCESS");
  (product(app.render(), "Rare - 2015 Chardonnay").props.onCheckedChange as (v: boolean) => void)(true); await resolveTags(app, twoTags);
  const copy = text(app.render());
  assert.match(copy, /Why draft only/); assert.match(copy, /holds only one of several security tags/); assert.match(copy, /To verify/); assert.match(copy, /log in to the storefront/);
  assert.equal(activeBox(app).props.disabled, true, "the safety gate is unchanged");
});

// ── H: used coupons ──
test("a used coupon reads 'Coupon used' and never shows a reusable code; the Brand sees purchase-check progress", async () => {
  const app = await claimsCard([{ ...readyClaim("used", "SQRA-SHOULD-NOT-SHOW"), status: "USED", code: null }]);
  const copy = text(app.render()); assert.match(copy, /Coupon used/); assert.doesNotMatch(copy, /SQRA-SHOULD-NOT-SHOW|Copy coupon/);
  const claim = (id: string, diagnostic: string | null, extra: object = {}) => ({ id, title: `Claim ${id}`, status: "ISSUED", provisioningState: "READY", providerCustomerId: null, providerTagId: null, tagTitle: null, message: null, ownerActive: false, canRevoke: true, canonicalOrderId: null, diagnostic, purchaseCheckedAt: "2026-10-08T10:40:01.423Z", rewardMode: "DISCOUNT", ...extra });
  const brand = await brandForm({ ...brandData, claims: [claim("waiting", "PURCHASE_CHECK:NO_MATCHING_ORDER"), claim("shape", "PURCHASE_CHECK:COUPON_IDENTITY_UNCONFIRMED"), claim("done", null, { status: "USED", canonicalOrderId: "order-1006", canRevoke: false })] });
  const brandCopy = text(brand.render());
  assert.match(brandCopy, /No imported Commerce7 order uses this coupon yet/); assert.match(brandCopy, /Custom Range/);
  assert.match(brandCopy, /coupon identity could not be confirmed/); assert.match(brandCopy, /Last checked/); assert.match(brandCopy, /Coupon used/);
});

// ── I: status badges ──
test("offer status is a separate badge with text, green when active and red when inactive", async () => {
  const listed = (id: string, isActive: boolean) => ({ ...offer, id, title: `Offer ${id}`, appliesTo: "ALL_PRODUCTS", rewardMode: "DISCOUNT", isActive, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, totalClaims: 0, issuedCount: 0, _count: { redemptions: 0 }, commerce7Config: { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true }, products: [] });
  const app = await brandForm({ ...brandData, offers: [listed("live", true), listed("paused", false)] });
  const tree = app.render(); const copy = text(tree);
  assert.doesNotMatch(copy, /Offer live · Active|Offer paused · Inactive/);
  const badges = nodes(tree).filter((node) => node.type === "span" && /^(Active|Inactive)$/.test(text(node).trim()));
  assert.deepEqual(badges.map((node) => text(node).trim()), ["Active", "Inactive"]);
  assert.match(String(badges[0].props.className), /rounded-full/); assert.match(String(badges[0].props.className), /emerald/); assert.match(String(badges[1].props.className), /red/);
  assert.ok(nodes(tree).some((node) => /^h3$|^p$/.test(node.type) && text(node).trim() === "Offer live"), "the title stands on its own");
});

// ── A: percentage gate in the editor ──
test("the editor marks Percentage draft-only while Commerce7 percentage units are unverified and turns Active off", async () => {
  const gated = { ...brandData, readiness: { backendConfigured: true, couponContract: { ...couponContract, discount: { FIXED_AMOUNT: true, PERCENTAGE: false } } } };
  const app = await brandForm(gated); (activeBox(app).props.onChange as (e: object) => void)({ target: { checked: true } });
  const discountSelect = select(app.render(), "FIXED_AMOUNT"); assert.match(text(discountSelect), /Percentage\s+\(draft only\)/);
  change(discountSelect, "PERCENTAGE");
  assert.equal(activeBox(app).props.checked, false); assert.equal(activeBox(app).props.disabled, true); assert.match(text(app.render()), /percentage units are verified/);
  const paused = { ...offer, id: "pct", title: "Fifteen Percent", appliesTo: "ALL_PRODUCTS", rewardMode: "DISCOUNT", isActive: true, discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 1500, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, totalClaims: 1, issuedCount: 1, _count: { redemptions: 1 }, commerce7Config: { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true }, products: [] };
  const list = await brandForm({ ...gated, offers: [paused] });
  assert.match(text(list.render()), /15% off/); assert.match(text(list.render()), /New percentage coupons are paused/);
});
