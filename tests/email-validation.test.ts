import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isValidEmail, normalizeEmail } from "../src/lib/email-validation";

describe("isValidEmail", () => {
  test("accepts ordinary and edge-but-valid addresses", () => {
    for (const email of [
      "name@company.com",
      "first.last@sub.example.co.uk",
      "plus+tag@example.org",
      "o'brien@example.com",
      "a_b-c@ex-ample.io",
      "1234567890@example.com",
      "x@xn--p1ai.xn--p1ai",
      "  padded@example.com  ",
      `${"a".repeat(64)}@example.com`,
    ]) {
      assert.equal(isValidEmail(email), true, email);
    }
  });

  test("rejects incomplete and malformed addresses", () => {
    for (const email of [
      "",
      "   ",
      "asdacsd",
      "a@b",
      "a@b.c",
      "a@.com",
      "a@com.",
      "@example.com",
      "name@",
      "name@@example.com",
      "na@me@example.com",
      "name@example..com",
      "name..x@example.com",
      ".name@example.com",
      "name.@example.com",
      "na me@example.com",
      "name@exa mple.com",
      "name@-example.com",
      "name@example-.com",
      "name@example.c0m",
      "name@example.123",
      "name@[127.0.0.1]",
      "name@localhost",
      '"quoted"@example.com',
      "naïve@example.com",
      "name@exämple.com",
    ]) {
      assert.equal(isValidEmail(email), false, JSON.stringify(email));
    }
  });

  test("enforces length limits", () => {
    assert.equal(isValidEmail(`${"a".repeat(65)}@example.com`), false);
    assert.equal(isValidEmail(`a@${"b".repeat(64)}.com`), false);
    assert.equal(isValidEmail(`a@${"b".repeat(250)}.com`), false);
  });

  test("rejects non-strings", () => {
    for (const value of [null, undefined, 42, {}, ["a@b.com"]]) {
      assert.equal(isValidEmail(value), false);
    }
  });
});

describe("normalizeEmail", () => {
  test("trims and lowercases valid addresses", () => {
    assert.equal(normalizeEmail("  Client@Example.COM "), "client@example.com");
  });
  test("returns null for invalid input", () => {
    assert.equal(normalizeEmail("asdacsd"), null);
    assert.equal(normalizeEmail(undefined), null);
  });
});
