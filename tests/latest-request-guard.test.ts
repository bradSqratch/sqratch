import { test } from "node:test";
import assert from "node:assert/strict";
import { createLatestRequestGuard } from "../src/hooks/use-latest-request";

test("only the newest request is current and older requests are aborted", () => {
  const guard = createLatestRequestGuard();
  const first = guard.begin();
  assert.equal(first.isCurrent(), true);
  const second = guard.begin();
  assert.equal(first.isCurrent(), false);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.isCurrent(), true);
  assert.equal(second.signal.aborted, false);
});

test("a slow older response cannot overwrite a newer one", async () => {
  const guard = createLatestRequestGuard();
  let shown = "";
  const load = async (label: string, delay: number) => {
    const request = guard.begin();
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (request.isCurrent()) shown = label;
  };
  await Promise.all([load("older (slow)", 30), load("newer (fast)", 1)]);
  assert.equal(shown, "newer (fast)");
});

test("cancel invalidates whatever is in flight", () => {
  const guard = createLatestRequestGuard();
  const request = guard.begin();
  guard.cancel();
  assert.equal(request.isCurrent(), false);
  assert.equal(request.signal.aborted, true);
  assert.equal(guard.begin().isCurrent(), true);
});
