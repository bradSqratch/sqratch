import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { realDbTest } from "./helpers/real-db";

test("real database helper requires all safety gates and its file flag", () => {
  const old = { DATABASE_URL: process.env.DATABASE_URL, ALLOW_REAL_DATABASE_TESTS: process.env.ALLOW_REAL_DATABASE_TESTS, HELPER_REAL_DB: process.env.HELPER_REAL_DB };
  try {
    process.env.ALLOW_REAL_DATABASE_TESTS = "true";
    process.env.HELPER_REAL_DB = "true";
    for (const target of ["postgresql://dummy:dummy@db.example.test/sqratch_test", "postgresql://dummy:dummy@db.supabase.co/sqratch_test", "postgresql://dummy:dummy@127.0.0.1/sqratch", "postgresql://dummy:dummy@127.0.0.1:1/sqratch_test", "postgresql://dummy:dummy@127.0.0.1/sqratch_test?host=remote.example", "postgresql://dummy:dummy@127.0.0.1/sqratch_test#fragment", "https://dummy:dummy@127.0.0.1/sqratch_test", "postgresql://dummy:dummy@127.0.0.1/sqratch%5ftest", "postgresql://dummy:dummy@127.0.0.1/a/../sqratch_test", "invalid"]) {
      process.env.DATABASE_URL = target;
      assert.equal(realDbTest("HELPER_REAL_DB").enabled, false);
    }
    for (const target of ["postgresql://dummy:dummy@127.0.0.1:55432/sqratch_test", "postgres://dummy:dummy@[::1]:55432/sqratch_test", "postgresql://dummy:p%40ss@localhost/sqratch_test"]) {
      process.env.DATABASE_URL = target;
      assert.equal(realDbTest("HELPER_REAL_DB").enabled, true);
    }
    process.env.HELPER_REAL_DB = "false";
    assert.equal(realDbTest("HELPER_REAL_DB").enabled, false);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("real database runner refuses unsafe targets before importing database clients", () => {
  for (const target of ["postgresql://dummy:dummy@db.supabase.co/sqratch_test", "postgresql://dummy:dummy@127.0.0.1/sqratch", "postgresql://dummy:dummy@127.0.0.1:1/sqratch_test", "postgresql://dummy:dummy@127.0.0.1/sqratch_test?host=remote.example", "postgresql://dummy:dummy@127.0.0.1/sqratch_test?hostaddr=remote.example", "postgresql://dummy:dummy@127.0.0.1/sqratch_test#fragment", "https://dummy:dummy@127.0.0.1/sqratch_test", "postgresql://dummy:dummy@127.0.0.1/sqratch%5ftest", "postgresql://dummy:dummy@127.0.0.1/a/../sqratch_test"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/test-realdb.ts"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: target } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing real-database tests/);
    assert.doesNotMatch(result.stderr, /dummy|supabase.co/);
  }
});

test("constraint initializer rejects an overridden host before opening a connection", () => {
  const target = "postgresql://dummy:dummy@127.0.0.1/sqratch_test?host=remote.example";
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/init-realdb-constraints.ts"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: target, ALLOW_REAL_DATABASE_TESTS: "true", INIT_EMPTY_TEST_DATABASE: "true" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing initialization/);
  assert.doesNotMatch(result.stderr, /dummy|remote.example/);
});
