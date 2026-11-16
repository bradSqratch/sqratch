import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

type Node = { type: string; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node; return [node, ...nodes(node.props.children)];
}
function content(value: unknown): string {
  if (Array.isArray(value)) return value.map(content).join("");
  if (!value || typeof value !== "object") return String(value ?? "");
  return content((value as Node).props?.children);
}

test("batch eligibility disables deletion and a stale conflict keeps the list visible", async () => {
  const state: unknown[] = []; let position = 0; const effects: Array<() => void> = []; let reads = 0;
  const campaign = { id: "c", name: "Campaign", slug: "campaign" };
  const result = (allowed: boolean) => ({ batches: [{ id: "clean", name: "Clean", quantity: 1, createdAt: "2026-01-01", campaign, canDelete: allowed }, { id: "used", name: "Used", quantity: 1, createdAt: "2026-01-01", campaign, canDelete: false }], qrCodes: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 }, batchPagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 } });
  const react = { useState(initial: unknown) { const i = position++; if (!(i in state)) state[i] = initial; return [state[i], (next: unknown) => { state[i] = typeof next === "function" ? next(state[i]) : next; }]; }, useMemo(fn: () => unknown) { return fn(); }, useCallback(fn: unknown) { return fn; }, useEffect(fn: () => void) { if (effects.length < 8) effects.push(fn); } };
  const exports: { default?: () => Node } = {}; const jsx = (type: string, props: object) => ({ type, props });
  runInNewContext(ts.transpileModule(readFileSync("src/app/(withSidebar)/dashboard/brand/qr-batches/page.tsx", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, Date, Intl, Error, URLSearchParams, String, window: { confirm: () => true, setTimeout: () => 0, clearTimeout: () => {} }, require(name: string) {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "next/link") return { __esModule: true, default: "Link" };
    if (name === "@/hooks/use-latest-request") return { useLatestRequest: () => () => ({ signal: undefined, isCurrent: () => true }) };
    if (name === "@/components/brand/brand-fetch") return { useBrandFetch: () => async () => { throw new Error("QR codes have history."); } };
    if (name === "@/components/experience/client-utils") return { fetchJson: async () => result(reads++ === 0), getErrorMessage: (error: Error) => error.message };
    return new Proxy({}, { get: (_target, key) => String(key) });
  } });
  function render() { position = 0; return exports.default!(); }
  render(); effects.forEach((run) => run()); await new Promise<void>((resolve) => setImmediate(resolve));
  let tree = render(); let buttons = nodes(tree).filter((n) => n.type === "Button" && content(n) === "Delete Batch");
  assert.equal(buttons.length, 2); assert.equal(buttons[0].props.disabled, false); assert.equal(buttons[1].props.disabled, true);
  (buttons[0].props.onClick as (e: object) => void)({ stopPropagation() {} }); await new Promise<void>((resolve) => setImmediate(resolve));
  tree = render(); assert.match(content(tree), /QR codes have history/); assert.match(content(tree), /Clean/); assert.match(content(tree), /Used/);
  buttons = nodes(tree).filter((n) => n.type === "Button" && content(n) === "Delete Batch"); assert.equal(buttons[0].props.disabled, true);
});
