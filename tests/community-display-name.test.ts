import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { publicDisplayName } from "../src/lib/display-name";

test("public names trim names and use a neutral fallback without email", () => {
  assert.equal(publicDisplayName({ name: "  Alex  " }), "Alex");
  for (const name of [undefined, null, "", "   "]) {
    const result = publicDisplayName({ name });
    assert.equal(result, "SQRATCH member");
    assert.equal(result.includes("@"), false);
  }
});

test("community APIs never select email or serialize an email fallback", () => {
  function check(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) check(path);
      else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(path, "utf8");
        assert.doesNotMatch(source, /\bemail\s*:\s*true|\.email\b/, path);
      }
    }
  }
  check("src/app/api/posts");
  check("src/app/api/questions");
});
