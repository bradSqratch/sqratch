// src/lib/db-safety.ts
//
// Production-database safety guard.
//
// Local dev in this repo deliberately points DATABASE_URL at the PRODUCTION
// Supabase database (see src/lib/prisma.ts). Automated tests must NEVER be
// able to reach or mutate it. This module provides the pure decision logic
// used to enforce that; src/lib/prisma.ts is the single chokepoint that
// calls it before constructing a Pool/PrismaClient.
//
// Design notes:
//   - The classifier below takes a connection-string ARGUMENT. It never
//     reads process.env itself, so it is trivially unit-testable with
//     synthetic strings (see tests/db-safety.test.ts) and cannot be
//     accidentally influenced by import order or module caching.
//   - It extracts ONLY `hostname` and the database name portion of
//     `pathname` via Node's built-in `URL`. It never reads, returns, or logs
//     `username`, `password`, `search`, or the connection string itself.
//   - Error/reason strings report a coarse classification tag, never the
//     raw hostname, database name, or URL. A hostname on its own is usually
//     harmless, but nothing here depends on that judgment call: reporting
//     only the classification is strictly safer and costs nothing, since
//     the classification tag alone is enough for a developer to know what
//     went wrong (e.g. "production-supabase" vs "unparseable").
//   - Test-mode detection (isTestEnvironment/detectTestEnvironment) is a
//     separate concern from classification: it reads live process signals
//     because that is inherently what it must do, but it is still exposed
//     as a pure function (`isTestEnvironment`) over an explicit signals
//     object, with a thin `detectTestEnvironment()` wrapper that reads
//     process.env/process.execArgv at call time. Because it is evaluated at
//     call time (inside src/lib/prisma.ts's module body, not cached at
//     import of this file), it cannot be bypassed by import order.
//
// Test-database marker mechanism (primary, and only, mechanism):
//   The target database's name (the path segment of the connection string,
//   e.g. "sqratch_test" in ".../sqratch_test") must end with the literal
//   suffix "_test". This was chosen over a companion env var because it is
//   self-documenting at the point of use (anyone reading a DATABASE_URL
//   value in a shell or CI log can see the safety marker), requires no
//   second variable to keep in sync, and cannot be forgotten independently
//   of the URL it's meant to describe.

/** Coarse classification of a database host. Never carries credentials. */
export type DbHostClassification =
  | "production-supabase"
  | "production-other"
  | "loopback-local"
  | "blocked-placeholder"
  | "unparseable";

export interface ParsedDbTarget {
  classification: DbHostClassification;
  /** Database name (path segment) with no leading slash, or null if absent/unparseable. */
  databaseName: string | null;
}

const SUPABASE_HOST_SUFFIXES = [".supabase.co", ".supabase.com"];
// Supabase's pgbouncer pooler hosts (e.g. aws-0-us-east-1.pooler.supabase.com)
// already end in ".supabase.com" above; listed again explicitly per the
// audit requirement to cover the pooler pattern by name, not only by
// incidental suffix overlap.
const SUPABASE_POOLER_SUFFIX = ".pooler.supabase.com";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// The deliberately-unreachable placeholder used throughout tests/ in place
// of any real connection string (port 1 is never a live Postgres listener).
const BLOCKED_PLACEHOLDER_HOSTNAME = "127.0.0.1";
const BLOCKED_PLACEHOLDER_PORT = "1";

export const TEST_DATABASE_NAME_SUFFIX = "_test";

/**
 * Parse a Postgres connection string and classify its host. Fails CLOSED:
 * any string that `URL` cannot parse, or that has no hostname, classifies
 * as "unparseable" — callers must treat that as unsafe, not safe.
 */
export function classifyDbTarget(connectionString: string): ParsedDbTarget {
  if (!connectionString) {
    return { classification: "unparseable", databaseName: null };
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { classification: "unparseable", databaseName: null };
  }

  const hostname = url.hostname.toLowerCase();
  const databaseName = url.pathname.replace(/^\//, "") || null;

  if (!hostname) {
    return { classification: "unparseable", databaseName };
  }

  if (
    hostname === BLOCKED_PLACEHOLDER_HOSTNAME &&
    url.port === BLOCKED_PLACEHOLDER_PORT
  ) {
    return { classification: "blocked-placeholder", databaseName };
  }

  if (LOOPBACK_HOSTNAMES.has(hostname)) {
    return { classification: "loopback-local", databaseName };
  }

  const isSupabase =
    SUPABASE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    hostname.endsWith(SUPABASE_POOLER_SUFFIX);

  if (isSupabase) {
    return { classification: "production-supabase", databaseName };
  }

  // Conservative fail-closed default: any hostname that is not recognized
  // as loopback/local (or our own blocked placeholder) is treated as
  // production-like, even if it isn't actually Supabase. Real database
  // access under test is only ever permitted against a loopback host (see
  // canUseRealDatabaseUnderTest below), matching the documented workflow in
  // tests/point-account-concurrency.test.ts (a disposable Postgres on
  // 127.0.0.1).
  return { classification: "production-other", databaseName };
}

/** True for classifications that must never be reached from a test process. */
export function isProductionClassification(
  classification: DbHostClassification,
): boolean {
  return (
    classification === "production-supabase" ||
    classification === "production-other" ||
    classification === "unparseable"
  );
}

/** True for classifications that are known-safe to construct a client against. */
export function isKnownSafeLocalClassification(
  classification: DbHostClassification,
): boolean {
  return (
    classification === "loopback-local" ||
    classification === "blocked-placeholder"
  );
}

export interface RealDbAccessDecision {
  allowed: boolean;
  /** Coarse, credential-free explanation. Never contains a hostname, database name, or URL. */
  reason: string;
}

export interface RealDbAccessInputs {
  connectionString: string;
  /** Raw value of process.env.ALLOW_REAL_DATABASE_TESTS, passed in explicitly. */
  allowRealDatabaseTestsEnv: string | undefined;
}

/**
 * Decide whether REAL (non-mocked) database access is permitted. Requires
 * ALL THREE conditions, evaluated UNCONDITIONALLY:
 *   (a) allowRealDatabaseTestsEnv === "true"
 *   (b) the target host classifies as loopback/local (never production-*
 *       or unparseable)
 *   (c) the target database name ends with "_test"
 *
 * This function is total and pure over its inputs and deliberately does NOT
 * take (or consider) test-mode detection as an input: it is a standalone,
 * fail-closed backstop against real database writes, independent of whether
 * the calling process happens to be detected as "under test". A caller that
 * gates real writes (e.g. tests/point-account-concurrency.test.ts) must gate
 * on this decision alone — if test detection is ever wrong or bypassed
 * (e.g. the file is run directly with `npx tsx` instead of `npx tsx --test`),
 * this function still refuses production and non-test-marked databases.
 *
 * Contrast with assertDatabaseAccessAllowed below, which DOES take
 * isTestEnvironment and is a deliberate no-op outside test mode — that one
 * is the production-runtime chokepoint and must stay detection-gated so
 * dev/production behavior is unaffected. This function has no such
 * exemption: it is meant to be safe to call and trust regardless of
 * detection state.
 */
export function canUseRealDatabaseUnderTest(
  inputs: RealDbAccessInputs,
): RealDbAccessDecision {
  const { classification, databaseName } = classifyDbTarget(
    inputs.connectionString,
  );

  // Condition (b): host must be loopback/local. Checked first because it is
  // the safety-critical property — a production-classified host is refused
  // regardless of the other two conditions.
  if (!isKnownSafeLocalClassification(classification)) {
    return {
      allowed: false,
      reason:
        classification === "production-supabase"
          ? "condition (b) failed: target host classifies as production-supabase"
          : classification === "unparseable"
            ? "condition (b) failed: target connection string is unparseable (fails closed as unsafe)"
            : "condition (b) failed: target host does not classify as loopback/local",
    };
  }

  // Condition (a): explicit opt-in flag.
  if (inputs.allowRealDatabaseTestsEnv !== "true") {
    return {
      allowed: false,
      reason: 'condition (a) failed: ALLOW_REAL_DATABASE_TESTS is not set to "true"',
    };
  }

  // Condition (c): database name carries the explicit test marker.
  const hasTestMarker =
    databaseName !== null && databaseName.endsWith(TEST_DATABASE_NAME_SUFFIX);
  if (!hasTestMarker) {
    return {
      allowed: false,
      reason: `condition (c) failed: target database name does not end with "${TEST_DATABASE_NAME_SUFFIX}"`,
    };
  }

  return {
    allowed: true,
    reason:
      "all three conditions satisfied: ALLOW_REAL_DATABASE_TESTS=true, loopback/local host, test-marked database",
  };
}

/**
 * Test-mode detection signals, taken as an explicit argument so the
 * decision logic (isTestEnvironment) is itself a pure, unit-testable
 * function. detectTestEnvironment() below is the only place that actually
 * reads process.env/process.execArgv, and it does so at call time.
 *
 * Empirically observed (see scratchpad probe, run under both
 * `npx tsx --test` and plain `node --test`):
 *   - process.env.NODE_TEST_CONTEXT === "child-v8" in the test worker
 *     process, in both cases. Not set otherwise.
 *   - process.execArgv contains multiple flags starting with "--test"
 *     (e.g. "--test-isolation=process", "--test-concurrency=0") in the test
 *     worker process, in both cases. Not set otherwise.
 *   - process.argv does NOT reliably contain the literal "--test" flag
 *     under `tsx --test` (tsx's own CLI parsing consumes it before the
 *     script sees argv), so it is not used as a signal here.
 */
export interface TestEnvironmentSignals {
  nodeEnv: string | undefined;
  nodeTestContext: string | undefined;
  execArgv: readonly string[];
}

export function isTestEnvironment(signals: TestEnvironmentSignals): boolean {
  if (signals.nodeEnv === "test") {
    return true;
  }
  if (signals.nodeTestContext !== undefined && signals.nodeTestContext !== "") {
    return true;
  }
  if (signals.execArgv.some((arg) => arg.startsWith("--test"))) {
    return true;
  }
  return false;
}

/** Reads live process signals and applies isTestEnvironment. Call-time only. */
export function detectTestEnvironment(): boolean {
  return isTestEnvironment({
    nodeEnv: process.env.NODE_ENV,
    nodeTestContext: process.env.NODE_TEST_CONTEXT,
    execArgv: process.execArgv,
  });
}

export interface AssertDatabaseAccessAllowedInputs {
  connectionString: string;
  isTestEnvironment: boolean;
  allowRealDatabaseTestsEnv: string | undefined;
}

/**
 * The single enforcement chokepoint, called from src/lib/prisma.ts before a
 * Pool/PrismaClient is constructed.
 *
 *   - Not under test: complete no-op. Production/dev behavior unchanged.
 *   - Under test + production-classified (or unparseable) host: THROW
 *     immediately, fail closed, before any query could execute.
 *   - Under test + loopback/local host + full 3-part opt-in satisfied:
 *     allow (real DB access, e.g. tests/point-account-concurrency.test.ts).
 *   - Under test + loopback/local host + opt-in NOT satisfied: allow
 *     anyway. This is required so the rest of the suite (which sets
 *     DATABASE_URL to the blocked placeholder or a bare loopback dummy
 *     purely so src/lib/prisma.ts's module-load check passes) can still
 *     construct a client whose delegate methods get replaced by per-test
 *     mocks before any query would reach a socket. The safety property this
 *     preserves is host-based, not opt-in-based: a loopback address can
 *     never resolve to the production Supabase database, so allowing
 *     construction here cannot leak a write to production.
 *   - Under test + production-classified host: never allowed, regardless of
 *     opt-in flags (see canUseRealDatabaseUnderTest's condition (b) check).
 */
export function assertDatabaseAccessAllowed(
  inputs: AssertDatabaseAccessAllowedInputs,
): void {
  if (!inputs.isTestEnvironment) {
    return;
  }

  const { classification } = classifyDbTarget(inputs.connectionString);

  if (isProductionClassification(classification)) {
    throw new Error(
      "Refusing to initialize a database client under test: target host " +
        `classifies as "${classification}". Automated tests must never ` +
        "connect to a production database. See src/lib/db-safety.ts.",
    );
  }

  // classification is now guaranteed loopback-local or blocked-placeholder.
  if (isKnownSafeLocalClassification(classification)) {
    return;
  }

  // Unreachable in practice (isProductionClassification and
  // isKnownSafeLocalClassification are exhaustive complements over all
  // DbHostClassification values), kept only to fail closed if that
  // invariant is ever broken by a future edit.
  throw new Error(
    "Refusing to initialize a database client under test: target host " +
      `classification "${classification}" is not recognized as safe.`,
  );
}
