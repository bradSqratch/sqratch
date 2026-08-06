import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertDatabaseAccessAllowed,
  canUseRealDatabaseUnderTest,
  classifyDbTarget,
  isTestEnvironment,
} from "../src/lib/db-safety";

// All connection strings in this file are synthetic — none is a real
// credential, host, or database. Never import or reference a real
// DATABASE_URL here.

describe("classifyDbTarget", () => {
  test("a production Supabase host is detected", () => {
    const result = classifyDbTarget(
      "postgres://u:p@db.abcdefghij.supabase.co:5432/postgres",
    );
    assert.equal(result.classification, "production-supabase");
  });

  test("a Supabase pooler host is detected", () => {
    const result = classifyDbTarget(
      "postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    );
    assert.equal(result.classification, "production-supabase");
  });

  test("a .supabase.com host (non-pooler) is also detected", () => {
    const result = classifyDbTarget(
      "postgres://u:p@db.project-ref.supabase.com:5432/postgres",
    );
    assert.equal(result.classification, "production-supabase");
  });

  test("127.0.0.1 is classified loopback-local", () => {
    const result = classifyDbTarget("postgresql://u:p@127.0.0.1:5547/mydb_test");
    assert.equal(result.classification, "loopback-local");
  });

  test("localhost is classified loopback-local", () => {
    const result = classifyDbTarget("postgresql://u:p@localhost:5432/mydb");
    assert.equal(result.classification, "loopback-local");
  });

  test("the blocked placeholder classifies as safe-but-unreachable", () => {
    const result = classifyDbTarget(
      "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked",
    );
    assert.equal(result.classification, "blocked-placeholder");
  });

  test("127.0.0.1 on a different port is loopback-local, not the blocked placeholder", () => {
    const result = classifyDbTarget("postgresql://u:p@127.0.0.1:5432/db");
    assert.equal(result.classification, "loopback-local");
  });

  test("an unrecognized remote host fails closed as production-other", () => {
    const result = classifyDbTarget("postgresql://u:p@some-random-host.example.com:5432/db");
    assert.equal(result.classification, "production-other");
  });

  test("an empty string fails closed as unparseable", () => {
    const result = classifyDbTarget("");
    assert.equal(result.classification, "unparseable");
  });

  test("a malformed string fails closed as unparseable", () => {
    const result = classifyDbTarget("not a valid url at all");
    assert.equal(result.classification, "unparseable");
  });

  test("a URL with no hostname fails closed as unparseable", () => {
    const result = classifyDbTarget("postgres:///onlypath");
    assert.equal(result.classification, "unparseable");
  });

  test("the database name is extracted without the leading slash", () => {
    const result = classifyDbTarget("postgresql://u:p@127.0.0.1:5547/sqratch_test");
    assert.equal(result.databaseName, "sqratch_test");
  });
});

describe("canUseRealDatabaseUnderTest — three-part opt-in, evaluated unconditionally", () => {
  const validLoopbackTestUrl = "postgresql://u:p@127.0.0.1:5547/sqratch_test";

  test("all three conditions satisfied -> allowed", () => {
    const decision = canUseRealDatabaseUnderTest({
      connectionString: validLoopbackTestUrl,
      allowRealDatabaseTestsEnv: "true",
    });
    assert.equal(decision.allowed, true);
  });

  test("condition (a) missing (flag unset) -> refused, names condition (a)", () => {
    const decision = canUseRealDatabaseUnderTest({
      connectionString: validLoopbackTestUrl,
      allowRealDatabaseTestsEnv: undefined,
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /condition \(a\)/);
  });

  test('condition (a) missing (flag "false") -> refused, names condition (a)', () => {
    const decision = canUseRealDatabaseUnderTest({
      connectionString: validLoopbackTestUrl,
      allowRealDatabaseTestsEnv: "false",
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /condition \(a\)/);
  });

  test("condition (b) missing (production Supabase host) -> refused, names condition (b)", () => {
    const decision = canUseRealDatabaseUnderTest({
      connectionString: "postgres://u:p@db.abcdefghij.supabase.co:5432/sqratch_test",
      allowRealDatabaseTestsEnv: "true",
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /condition \(b\)/);
  });

  test("condition (b) missing (unrecognized remote host) -> refused, names condition (b)", () => {
    const decision = canUseRealDatabaseUnderTest({
      connectionString: "postgresql://u:p@some-cloud-host.example.com:5432/sqratch_test",
      allowRealDatabaseTestsEnv: "true",
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /condition \(b\)/);
  });

  test("condition (c) missing (database name has no _test marker) -> refused, names condition (c)", () => {
    const decision = canUseRealDatabaseUnderTest({
      connectionString: "postgresql://u:p@127.0.0.1:5547/sqratch",
      allowRealDatabaseTestsEnv: "true",
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /condition \(c\)/);
  });

  test("a non-production (loopback) host without the test-database marker is refused", () => {
    const decision = canUseRealDatabaseUnderTest({
      connectionString: "postgresql://u:p@localhost:5432/plain_dev_db",
      allowRealDatabaseTestsEnv: "true",
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /condition \(c\)/);
  });

  test("an unparseable connection string is refused and named as condition (b)", () => {
    const decision = canUseRealDatabaseUnderTest({
      connectionString: "not a valid url",
      allowRealDatabaseTestsEnv: "true",
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /condition \(b\)/);
  });

  test("REGRESSION: a production Supabase host is refused even with the opt-in flag set (this function takes no test-mode-detection input at all — the prior bug returned {allowed:true} unconditionally whenever detection failed)", () => {
    const decision = canUseRealDatabaseUnderTest({
      connectionString: "postgres://u:p@db.abcdefghij.supabase.co:5432/postgres",
      allowRealDatabaseTestsEnv: "true",
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /condition \(b\)/);
  });
});

describe("canUseRealDatabaseUnderTest is independent of test-mode detection (the exact regression this fix closes)", () => {
  // Before the fix, canUseRealDatabaseUnderTest began with
  // `if (!inputs.isTestEnvironment) return { allowed: true, ... }`, so
  // whenever test-mode detection failed (e.g. this repo's
  // tests/point-account-concurrency.test.ts run directly via
  // `npx tsx tests/point-account-concurrency.test.ts`, without `--test`),
  // ALL THREE opt-in conditions were skipped and a production Supabase
  // DATABASE_URL would be reported as "allowed". The fix removes
  // isTestEnvironment as an input to this function entirely, so its
  // decision cannot vary with detection state. These tests prove that
  // invariant by exercising the function under signals that would have
  // computed isTestEnvironment(...) === true and === false respectively via
  // src/lib/db-safety.ts's own isTestEnvironment, and confirming the
  // decision is identical (and correctly fail-closed) either way.
  const detectionScenarios: Array<{ label: string; detected: boolean }> = [
    {
      label: "detection TRUE (e.g. NODE_ENV=test)",
      detected: isTestEnvironment({
        nodeEnv: "test",
        nodeTestContext: undefined,
        execArgv: [],
      }),
    },
    {
      label: "detection FALSE (no test signals present — the reachable-in-practice case)",
      detected: isTestEnvironment({
        nodeEnv: undefined,
        nodeTestContext: undefined,
        execArgv: [],
      }),
    },
  ];

  for (const scenario of detectionScenarios) {
    describe(scenario.label, () => {
      test(`sanity: isTestEnvironment resolves as expected for this scenario`, () => {
        assert.equal(scenario.detected, scenario.label.startsWith("detection TRUE"));
      });

      test("a production Supabase URL with the opt-in flag set is REFUSED regardless of detection state", () => {
        const decision = canUseRealDatabaseUnderTest({
          connectionString: "postgresql://synthetic:synthetic@db.notarealproject.supabase.co:5432/postgres",
          allowRealDatabaseTestsEnv: "true",
        });
        assert.equal(decision.allowed, false);
        assert.match(decision.reason, /condition \(b\)/);
      });

      test("a loopback _test URL with the opt-in flag set is ALLOWED regardless of detection state (legitimate disposable-DB case still works)", () => {
        const decision = canUseRealDatabaseUnderTest({
          connectionString: "postgresql://u:p@127.0.0.1:5547/sqratch_test",
          allowRealDatabaseTestsEnv: "true",
        });
        assert.equal(decision.allowed, true);
      });

      test("condition (a) missing is refused regardless of detection state", () => {
        const decision = canUseRealDatabaseUnderTest({
          connectionString: "postgresql://u:p@127.0.0.1:5547/sqratch_test",
          allowRealDatabaseTestsEnv: undefined,
        });
        assert.equal(decision.allowed, false);
        assert.match(decision.reason, /condition \(a\)/);
      });

      test("condition (b) missing is refused regardless of detection state", () => {
        const decision = canUseRealDatabaseUnderTest({
          connectionString: "postgres://u:p@db.abcdefghij.supabase.co:5432/sqratch_test",
          allowRealDatabaseTestsEnv: "true",
        });
        assert.equal(decision.allowed, false);
        assert.match(decision.reason, /condition \(b\)/);
      });

      test("condition (c) missing is refused regardless of detection state", () => {
        const decision = canUseRealDatabaseUnderTest({
          connectionString: "postgresql://u:p@127.0.0.1:5547/sqratch",
          allowRealDatabaseTestsEnv: "true",
        });
        assert.equal(decision.allowed, false);
        assert.match(decision.reason, /condition \(c\)/);
      });
    });
  }
});

describe("assertDatabaseAccessAllowed — chokepoint guard (KEEPS its isTestEnvironment gate; production/dev no-op is preserved by design)", () => {
  // This is the production-runtime chokepoint (called from src/lib/prisma.ts
  // before a Pool/PrismaClient is constructed) and it deliberately stays
  // gated on isTestEnvironment so production/dev behavior is byte-for-byte
  // unchanged. This is the opposite design choice from
  // canUseRealDatabaseUnderTest above, which was fixed to NOT take
  // isTestEnvironment at all. The two functions serve different concerns:
  // this one must no-op outside test mode (or every production request
  // would be evaluated against test-only logic); canUseRealDatabaseUnderTest
  // must never no-op based on detection, because it is the backstop invoked
  // directly by real-write test files. Locking in both halves of that
  // separation is the point of this test file.
  test("is a no-op when not under test, even for a production Supabase URL (production behavior preserved)", () => {
    assert.doesNotThrow(() => {
      assertDatabaseAccessAllowed({
        connectionString: "postgres://u:p@db.abcdefghij.supabase.co:5432/postgres",
        isTestEnvironment: false,
        allowRealDatabaseTestsEnv: undefined,
      });
    });
  });

  test("throws under test when the host is a production Supabase host", () => {
    assert.throws(() => {
      assertDatabaseAccessAllowed({
        connectionString: "postgres://u:p@db.abcdefghij.supabase.co:5432/postgres",
        isTestEnvironment: true,
        allowRealDatabaseTestsEnv: undefined,
      });
    }, /production-supabase/);
  });

  test("throws under test when the host is the Supabase pooler", () => {
    assert.throws(() => {
      assertDatabaseAccessAllowed({
        connectionString: "postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
        isTestEnvironment: true,
        allowRealDatabaseTestsEnv: "true",
      });
    }, /production-supabase/);
  });

  test("throws under test when the connection string is unparseable (fails closed)", () => {
    assert.throws(() => {
      assertDatabaseAccessAllowed({
        connectionString: "not a valid url",
        isTestEnvironment: true,
        allowRealDatabaseTestsEnv: undefined,
      });
    }, /unparseable/);
  });

  test("throws under test when the host is an unrecognized remote (conservative fail-closed)", () => {
    assert.throws(() => {
      assertDatabaseAccessAllowed({
        connectionString: "postgresql://u:p@some-cloud-host.example.com:5432/db",
        isTestEnvironment: true,
        allowRealDatabaseTestsEnv: undefined,
      });
    }, /production-other/);
  });

  test("allows the blocked placeholder under test with no opt-in (mocked-test passthrough)", () => {
    assert.doesNotThrow(() => {
      assertDatabaseAccessAllowed({
        connectionString: "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked",
        isTestEnvironment: true,
        allowRealDatabaseTestsEnv: undefined,
      });
    });
  });

  test("allows a plain loopback URL under test with no opt-in (mocked-test passthrough)", () => {
    assert.doesNotThrow(() => {
      assertDatabaseAccessAllowed({
        connectionString: "postgresql://test:test@localhost:5432/test",
        isTestEnvironment: true,
        allowRealDatabaseTestsEnv: undefined,
      });
    });
  });

  test("allows a loopback URL under test with the full three-part opt-in satisfied", () => {
    assert.doesNotThrow(() => {
      assertDatabaseAccessAllowed({
        connectionString: "postgresql://u:p@127.0.0.1:5547/sqratch_test",
        isTestEnvironment: true,
        allowRealDatabaseTestsEnv: "true",
      });
    });
  });
});

describe("isTestEnvironment — test-mode detection signals", () => {
  test("NODE_ENV=test alone is sufficient", () => {
    assert.equal(
      isTestEnvironment({ nodeEnv: "test", nodeTestContext: undefined, execArgv: [] }),
      true,
    );
  });

  test("NODE_TEST_CONTEXT alone is sufficient (matches empirically observed tsx --test / node --test behavior)", () => {
    assert.equal(
      isTestEnvironment({ nodeEnv: undefined, nodeTestContext: "child-v8", execArgv: [] }),
      true,
    );
  });

  test("a --test* execArgv flag alone is sufficient", () => {
    assert.equal(
      isTestEnvironment({
        nodeEnv: undefined,
        nodeTestContext: undefined,
        execArgv: ["--test-isolation=process"],
      }),
      true,
    );
  });

  test("no signals present -> not under test", () => {
    assert.equal(
      isTestEnvironment({ nodeEnv: undefined, nodeTestContext: undefined, execArgv: [] }),
      false,
    );
  });

  test("an unrelated NODE_ENV value alone does not trigger test mode", () => {
    assert.equal(
      isTestEnvironment({ nodeEnv: "production", nodeTestContext: undefined, execArgv: [] }),
      false,
    );
  });

  test("an unrelated execArgv flag alone does not trigger test mode", () => {
    assert.equal(
      isTestEnvironment({
        nodeEnv: undefined,
        nodeTestContext: undefined,
        execArgv: ["--inspect"],
      }),
      false,
    );
  });
});

describe("no secret ever leaks through this module's outputs", () => {
  const secretPassword = "Sup3rSecretPassw0rd_DoNotLeak";
  const fullUrlWithSecret = `postgres://someuser:${secretPassword}@db.abcdefghij.supabase.co:5432/postgres`;

  test("classifyDbTarget's result contains neither the password nor the full URL", () => {
    const result = classifyDbTarget(fullUrlWithSecret);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secretPassword), false);
    assert.equal(serialized.includes(fullUrlWithSecret), false);
  });

  test("canUseRealDatabaseUnderTest's decision contains neither the password nor the full URL", () => {
    const decision = canUseRealDatabaseUnderTest({
      connectionString: fullUrlWithSecret,
      allowRealDatabaseTestsEnv: "true",
    });
    const serialized = JSON.stringify(decision);
    assert.equal(serialized.includes(secretPassword), false);
    assert.equal(serialized.includes(fullUrlWithSecret), false);
  });

  test("assertDatabaseAccessAllowed's thrown message contains neither the password nor the full URL", () => {
    assert.throws(
      () => {
        assertDatabaseAccessAllowed({
          connectionString: fullUrlWithSecret,
          isTestEnvironment: true,
          allowRealDatabaseTestsEnv: undefined,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message.includes(secretPassword), false);
        assert.equal(err.message.includes(fullUrlWithSecret), false);
        return true;
      },
    );
  });
});
