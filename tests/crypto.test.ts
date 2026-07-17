import assert from "node:assert/strict";
import { test } from "node:test";

import { decryptSecret, encryptSecret } from "../src/lib/crypto";

const ENV_KEYS = [
  "APP_ENCRYPTION_KEY",
  "NEXTAUTH_SECRET",
  "SHOPIFY_TOKEN_ENCRYPTION_KEY",
] as const;

type EncryptionEnvironment = Partial<Record<(typeof ENV_KEYS)[number], string>>;

function withEncryptionEnvironment(
  values: EncryptionEnvironment,
  callback: () => void,
) {
  const original = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as EncryptionEnvironment;

  try {
    for (const key of ENV_KEYS) {
      const value = values[key];

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    callback();
  } finally {
    for (const key of ENV_KEYS) {
      const value = original[key];

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("Shopify credential encryption uses APP_ENCRYPTION_KEY", () => {
  withEncryptionEnvironment(
    { APP_ENCRYPTION_KEY: "crypto-test-key-one" },
    () => {
      const plaintext = "shpat_sensitive_shopify_access_token";
      const ciphertext = encryptSecret(plaintext);

      assert.notEqual(ciphertext, plaintext);
      assert.equal(decryptSecret(ciphertext), plaintext);
    },
  );
});

test("Shopify credential encryption uses a random IV for every payload", () => {
  withEncryptionEnvironment(
    { APP_ENCRYPTION_KEY: "crypto-test-key-one" },
    () => {
      const plaintext = "shprt_sensitive_shopify_refresh_token";
      const firstCiphertext = encryptSecret(plaintext);
      const secondCiphertext = encryptSecret(plaintext);

      assert.notEqual(firstCiphertext, secondCiphertext);
      assert.equal(decryptSecret(firstCiphertext), plaintext);
      assert.equal(decryptSecret(secondCiphertext), plaintext);
    },
  );
});

test("Shopify credential encryption cannot decrypt with a different key", () => {
  withEncryptionEnvironment(
    { APP_ENCRYPTION_KEY: "crypto-test-key-one" },
    () => {
      const ciphertext = encryptSecret("shopify-token");

      process.env.APP_ENCRYPTION_KEY = "crypto-test-key-two";

      assert.throws(() => decryptSecret(ciphertext));
    },
  );
});

test("missing and blank APP_ENCRYPTION_KEY fail closed without leaking secrets", () => {
  const suppliedSecret = "do-not-leak-this-supplied-secret";

  for (const appEncryptionKey of [undefined, "   "]) {
    withEncryptionEnvironment(
      {
        APP_ENCRYPTION_KEY: appEncryptionKey,
        NEXTAUTH_SECRET: suppliedSecret,
        SHOPIFY_TOKEN_ENCRYPTION_KEY: suppliedSecret,
      },
      () => {
        assert.throws(
          () => encryptSecret("shopify-token"),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /APP_ENCRYPTION_KEY is not configured/);
            assert.doesNotMatch(error.message, new RegExp(suppliedSecret));
            return true;
          },
        );
      },
    );
  }
});

test("NEXTAUTH_SECRET alone does not permit Shopify credential encryption", () => {
  withEncryptionEnvironment(
    { NEXTAUTH_SECRET: "nextauth-session-signing-secret" },
    () => {
      assert.throws(() => encryptSecret("shopify-token"));
    },
  );
});

test("SHOPIFY_TOKEN_ENCRYPTION_KEY alone does not permit Shopify credential encryption", () => {
  withEncryptionEnvironment(
    { SHOPIFY_TOKEN_ENCRYPTION_KEY: "retired-shopify-encryption-secret" },
    () => {
      assert.throws(() => encryptSecret("shopify-token"));
    },
  );
});
