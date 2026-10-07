import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { defaultBrandAnalyticsDates, brandAnalyticsDateError } from "../src/lib/commerce/brand-analytics-filters";
import { resolveCommerceClickAnalyticsDateRange } from "../src/lib/commerce/commerce-click-analytics";
import * as conversionHelpers from "../src/lib/commerce/conversion-analytics-client";

const source = readFileSync("src/app/(withSidebar)/dashboard/brand/analytics/page.tsx", "utf8");
type Element = { type: string | ((props: Record<string, unknown>) => unknown); props: Record<string, unknown> };

// Execute the actual page with a tiny deterministic hook scheduler. No DOM or
// network: effects, dependencies, cleanup, handlers and JSX are production code.
function pageHarness() {
  const states: unknown[] = [];
  const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
  let stateIndex = 0;
  let effectIndex = 0;
  let pendingEffects: Array<() => void> = [];
  const requests: Array<{ url: string; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const react = {
    useState(initial: unknown) {
      const i = stateIndex++;
      if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
      return [states[i], (value: unknown) => { states[i] = typeof value === "function" ? value(states[i]) : value; }];
    },
    useRef(initial: unknown) {
      const i = stateIndex++;
      if (!(i in states)) states[i] = { current: initial };
      return states[i];
    },
    useEffect(run: () => (() => void) | undefined, deps: unknown[]) {
      const i = effectIndex++;
      if (effects[i] && deps.every((dep, j) => Object.is(dep, effects[i].deps[j]))) return;
      pendingEffects.push(() => { effects[i]?.cleanup?.(); effects[i] = { deps, cleanup: run() }; });
    },
  };
  const jsx = (type: Element["type"], props: Element["props"]) => ({ type, props });
  const realRequire = createRequire(import.meta.url);
  const exports: { default?: () => Element } = {};
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, {
    exports, URLSearchParams, Date,
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "@/components/experience/client-utils") return {
        fetchJson: (url: string) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
        getErrorMessage: (error: Error) => error.message,
      };
      if (name === "@/lib/commerce/conversion-analytics-client") return conversionHelpers;
      if (name === "@/lib/commerce/brand-analytics-filters") return { defaultBrandAnalyticsDates, brandAnalyticsDateError };
      if (name === "next/link") return { __esModule: true, default: "a" };
      if (name.startsWith("@/components/")) return new Proxy({}, { get: (_target, key) => String(key) });
      return realRequire(name);
    },
  });
  function expand(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(expand);
    if (!value || typeof value !== "object" || !("type" in value)) return value;
    const node = value as Element;
    if (typeof node.type === "function") return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props.children) } };
  }
  return {
    requests,
    render() {
      stateIndex = 0; effectIndex = 0;
      return expand(exports.default!());
    },
    flush() { const runs = pendingEffects; pendingEffects = []; runs.forEach((run) => run()); },
    unmount() { effects.forEach((effect) => effect.cleanup?.()); },
  };
}

function nodes(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("type" in tree)) return [];
  const node = tree as Element;
  return [node, ...nodes(node.props.children)];
}
function textOf(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(textOf).join(" ");
  if (!tree || typeof tree !== "object") return tree == null || typeof tree === "boolean" ? "" : String(tree);
  return textOf((tree as Element).props?.children);
}
function control(tree: unknown, id: string) { return nodes(tree).find((node) => node.props.id === id)!; }
function change(tree: unknown, id: string, value: string) {
  (control(tree, id).props.onChange as (event: unknown) => void)({ target: { value } });
}
const engagement = (scans: number) => ({ campaigns: [{ id: "campaign-1", name: "Campaign One", slug: "one" }], totals: { scans, unlocks: 0, lessonStarts: 0, lessonCompletions: 0, shopClicks: 0 }, byCampaign: [] });
const clicks = { range: { start: "2026-09-07", end: "2026-10-06" }, totals: { clicks: 0, uniqueSessions: { value: 0, truncated: false }, uniqueUsers: { value: 0, truncated: false }, campaignEntryClicks: 0, directEntryClicks: 0 }, timeSeries: [], surfaceBreakdown: {}, providerBreakdown: [], entryCampaignBreakdown: [], productCampaignBreakdown: [], topProducts: [], topExperiences: [], topLessons: [] };
const conversion = (attributed = 0): conversionHelpers.BrandConversionAnalytics => ({
  range: clicks.range, totalIngestedOrders: 1, attributedOrders: attributed, currentlyNetPositivePaidOrders: attributed,
  pendingOrAuthorizedOrders: 0, partiallyRefundedOrders: 0, fullyRefundedOrders: 0,
  grossAttributedRevenueByCurrency: [], refundedRevenueByCurrency: [], netAttributedRevenueByCurrency: [],
  attributedOrdersByProvider: [], attributedOrdersByEntryCampaign: [], attributedOrdersByProductCampaign: [], attributedOrdersByExperience: [], attributedOrdersByCreator: [], attributedOrdersByLesson: [], attributedOrdersByProduct: [], dailyTrend: [],
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("defaults reuse the server's UTC inclusive range, including offset date boundaries", () => {
  for (const now of [new Date("2026-10-06T20:35:00-04:00"), new Date("2026-03-08T00:30:00-05:00")]) {
    const displayed = defaultBrandAnalyticsDates(now);
    const expected = resolveCommerceClickAnalyticsDateRange({ now });
    const actual = resolveCommerceClickAnalyticsDateRange(displayed);
    assert.deepEqual(actual, expected);
  }
  assert.deepEqual(defaultBrandAnalyticsDates(new Date("2026-10-06T20:35:00Z")), { dateFrom: "2026-09-07", dateTo: "2026-10-06" });
  assert.ok(brandAnalyticsDateError("", "2026-10-06"));
  assert.ok(brandAnalyticsDateError("2026-02-30", "2026-10-06"));
  assert.ok(brandAnalyticsDateError("2025-01-01", "2026-10-06"));
});

test("From/To defaults are visible, labels are associated, and all requests use the displayed dates", () => {
  const h = pageHarness(); const tree = h.render(); h.flush();
  for (const id of ["analytics-from", "analytics-to", "analytics-campaign"]) {
    assert.ok(nodes(tree).some((node) => node.type === "label" && node.props.htmlFor === id));
  }
  for (const request of h.requests) {
    const url = new URL(request.url, "https://test");
    assert.equal(url.searchParams.get("dateFrom"), control(tree, "analytics-from").props.value);
    assert.equal(url.searchParams.get("dateTo"), control(tree, "analytics-to").props.value);
  }
  assert.equal(h.requests.length, 3); h.unmount();
});

test("campaign changes reload engagement only and retain the campaign chooser", async () => {
  const h = pageHarness(); let tree = h.render(); h.flush();
  h.requests[0].resolve(engagement(0)); await settle(); tree = h.render();
  change(tree, "analytics-campaign", "campaign-1"); tree = h.render(); h.flush();
  assert.equal(h.requests.length, 4);
  assert.match(h.requests[3].url, /campaignId=campaign-1/);
  assert.ok(textOf(tree).includes("Campaign filters engagement only"));
  h.requests[3].resolve(engagement(0)); await settle(); tree = h.render();
  assert.ok(textOf(control(tree, "analytics-campaign")).includes("Campaign One")); h.unmount();
});

test("date changes reload all panels; stale success and failure cannot replace newer data", async () => {
  const h = pageHarness(); let tree = h.render(); h.flush();
  change(tree, "analytics-from", "2026-08-01"); tree = h.render(); h.flush();
  assert.equal(h.requests.length, 6);
  h.requests[3].resolve(engagement(23)); h.requests[4].resolve(clicks); h.requests[5].resolve(conversion());
  await settle();
  h.requests[0].resolve(engagement(99)); h.requests[1].reject(new Error("stale click error")); h.requests[2].reject(new Error("stale conversion error"));
  await settle(); tree = h.render();
  assert.ok(textOf(tree).includes("23"));
  assert.doesNotMatch(textOf(tree), /99|stale click error|stale conversion error/); h.unmount();
});

test("cleared dates pause requests, invalidate pending responses, and explain the missing range", async () => {
  const h = pageHarness(); let tree = h.render(); h.flush();
  change(tree, "analytics-from", ""); tree = h.render(); h.flush();
  h.requests[0].resolve(engagement(99)); h.requests[1].resolve(clicks); h.requests[2].resolve(conversion());
  await settle(); tree = h.render();
  assert.equal(h.requests.length, 3);
  assert.match(textOf(tree), /Choose both From and To/);
  assert.doesNotMatch(textOf(tree), /99/); h.unmount();
});

test("empty panels are concise; currencies, UNKNOWN, and daily trends stay separate", async () => {
  const h = pageHarness(); h.render(); h.flush();
  h.requests[0].resolve(engagement(0)); h.requests[1].resolve(clicks); h.requests[2].resolve(conversion());
  await settle(); let tree = h.render();
  assert.match(textOf(tree), /No engagement|No product clicks|none in this range have exact SQRATCH/);
  assert.doesNotMatch(textOf(tree), /By provider|By Creator|By Lesson|Gross attributed revenue/);
  change(tree, "analytics-from", "2026-08-01"); h.render(); h.flush();
  const c = conversion(2);
  c.netAttributedRevenueByCurrency = [{ currencyCode: "USD", minor: "4200" }, { currencyCode: "CAD", minor: "9831" }, { currencyCode: "UNKNOWN", minor: "123" }];
  c.dailyTrend = [{ date: "2026-10-06", attributedOrders: 2, currentlyNetPositivePaidOrders: 2, grossRevenueByCurrency: c.netAttributedRevenueByCurrency, refundedRevenueByCurrency: [], netRevenueByCurrency: c.netAttributedRevenueByCurrency }];
  h.requests[3].resolve(engagement(0)); h.requests[4].resolve(clicks); h.requests[5].resolve(c);
  await settle(); tree = h.render();
  assert.match(textOf(tree), /USD 42\.00/); assert.match(textOf(tree), /CAD 98\.31/); assert.match(textOf(tree), /Unknown currency/);
  assert.match(textOf(tree), /Attributed conversions per day/); assert.doesNotMatch(textOf(tree), /140\.31|conversion rate/i); h.unmount();
});
