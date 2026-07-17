import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeInternalRedirectPath } from "../src/lib/safe-redirect";

test("experience tabs preserve their exact return paths", () => {
  const slug = "summer-experience";

  for (const tab of ["posts", "qa", "shop", "learn"] as const) {
    const path = `/x/${slug}/${tab}`;
    assert.equal(normalizeInternalRedirectPath(path), path);
  }

  assert.equal(
    normalizeInternalRedirectPath(`/x/${slug}`),
    `/x/${slug}`,
  );
});

test("missing and unsafe next values use the safe dashboard fallback", () => {
  for (const value of [null, "", "//evil.example/x", "https://evil.example/x", "/\\evil"]) {
    assert.equal(normalizeInternalRedirectPath(value), "/dashboard");
  }
});

test("gated experience callers pass tab-specific return paths", () => {
  const read = (file: string) =>
    readFileSync(new URL(`../src/components/experience/${file}`, import.meta.url), "utf8");
  const shell = read("experience-shell.tsx");

  assert.match(shell, /shop: \(slug\) => `\/x\/\$\{slug\}\/shop`/);
  assert.match(shell, /learn: \(slug\) => `\/x\/\$\{slug\}\/learn`/);
  assert.match(read("posts-client.tsx"), /returnTo=\{`\/x\/\$\{data\.slug\}\/posts`\}/);
  assert.match(read("qa-client.tsx"), /returnTo=\{`\/x\/\$\{data\.slug\}\/qa`\}/);
  assert.match(read("hub-client.tsx"), /returnTo=\{`\/x\/\$\{data\.slug\}\/posts`\}/);
  assert.match(read("hub-client.tsx"), /returnTo=\{`\/x\/\$\{data\.slug\}\/qa`\}/);
});

test("signup, verification, and login retain next", () => {
  const signup = readFileSync(
    new URL("../src/app/(auth)/signup/page.tsx", import.meta.url),
    "utf8",
  );
  const verify = readFileSync(
    new URL("../src/app/(auth)/verify-email/page.tsx", import.meta.url),
    "utf8",
  );
  const login = readFileSync(
    new URL("../src/app/(auth)/login/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(signup, /verify-email\?email=.*&next=/);
  assert.match(signup, /login\?next=\$\{encodeURIComponent\(nextPath\)\}/);
  assert.match(verify, /login\?next=\$\{encodeURIComponent\(nextPath\)\}/);
  assert.match(login, /router\.push\(nextPath\)/);
  assert.match(login, /api\/progress\/merge/);
});
