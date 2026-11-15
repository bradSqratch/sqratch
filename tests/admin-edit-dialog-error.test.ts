import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

type Node = { type: string; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (!value || typeof value !== "object") return String(value ?? "");
  return text((value as Node).props?.children);
}

for (const message of ["You cannot remove your own administrator access.", "The last active administrator cannot be removed.", "Account access is no longer active.", "This account has history."]) {
  test(`edit dialog presents and retains draft on rejection: ${message}`, async () => {
    const states: unknown[] = []; let index = 0; let effectIndex = 0;
    const dependencies: unknown[][] = []; let pending: (() => void)[] = [];
    const user = { id: "admin", name: "Original", email: "admin@example.test", role: "ADMIN", createdAt: "2026-01-01T00:00:00Z", isActive: true, hasCreatorProfile: false, brands: [] };
    const requests: { body: string }[] = [];
    const react = {
      useState(initial: unknown) { const i = index++; if (!(i in states)) states[i] = initial; return [states[i], (next: unknown) => { states[i] = typeof next === "function" ? next(states[i]) : next; }]; },
      useMemo(fn: () => unknown) { return fn(); },
      useEffect(fn: () => void, deps: unknown[]) { const i = effectIndex++; if (!dependencies[i] || !deps.every((dep, j) => Object.is(dep, dependencies[i][j]))) { dependencies[i] = deps; pending.push(fn); } },
    };
    const exports: { default?: () => Node } = {};
    const jsx = (type: string, props: object) => ({ type, props });
    runInNewContext(ts.transpileModule(readFileSync("src/app/(withSidebar)/admin/user-management/page.tsx", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
      exports, URLSearchParams, Date, Intl, Error, window: { setTimeout: () => 1, clearTimeout: () => {} },
      require(name: string) {
        if (name === "react") return react;
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name === "@/lib/email-validation") return { isValidEmail: () => false };
        if (name === "@/components/experience/client-utils") return { fetchJson: async (_url: string, init?: RequestInit) => { if (!init) return [user]; requests.push({ body: String(init.body) }); throw new Error(message); }, getErrorMessage: (error: Error) => error.message };
        if (name.startsWith("@/components/ui/")) return new Proxy({}, { get: (_target, key) => String(key) });
        throw new Error(`Unexpected dependency ${name}`);
      },
    });
    function render() { index = 0; effectIndex = 0; return exports.default!(); }
    function flushEffects() { const effects = pending; pending = []; effects.forEach((fn) => fn()); }
    render(); flushEffects(); await new Promise<void>((resolve) => setImmediate(resolve));
    let tree = render();
    const edit = nodes(tree).find((node) => node.type === "Button" && text(node) === "Edit"); assert.ok(edit);
    (edit.props.onClick as () => void)(); tree = render(); flushEffects(); tree = render();
    const name = nodes(tree).find((node) => node.props.id === "edit-name"); assert.ok(name);
    (name.props.onChange as (event: unknown) => void)({ target: { value: "Unsaved edit" } });
    tree = render();
    const role = nodes(tree).find((node) => node.props.id === "edit-role"); assert.ok(role);
    (role.props.onChange as (event: unknown) => void)({ target: { value: "USER" } });
    tree = render(); const save = nodes(tree).find((node) => node.type === "Button" && text(node) === "Save"); assert.ok(save);
    (save.props.onClick as () => void)(); await new Promise<void>((resolve) => setImmediate(resolve));
    tree = render();
    const dialog = nodes(tree).find((node) => node.type === "Dialog" && node.props.open === true); assert.ok(dialog);
    const alerts = nodes(dialog).filter((node) => node.props.role === "alert");
    assert.equal(alerts.length, 1); assert.equal(text(alerts[0]), message);
    assert.equal(nodes(tree).filter((node) => text(node) === message && node.type === "div").length, 1);
    assert.equal(nodes(dialog).find((node) => node.props.id === "edit-name")?.props.value, "Unsaved edit");
    assert.equal(nodes(dialog).find((node) => node.props.id === "edit-role")?.props.value, "USER");
    assert.equal(JSON.parse(requests[0].body).name, "Unsaved edit");
  });
}
