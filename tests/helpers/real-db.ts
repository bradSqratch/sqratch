import { disposableTestDbDecision } from "../../src/lib/disposable-test-db";

export function realDbTest(flagName: string) {
  const decision = disposableTestDbDecision({
    connectionString: process.env.DATABASE_URL ?? "",
    allowRealDatabaseTestsEnv: process.env.ALLOW_REAL_DATABASE_TESTS,
  });
  const enabled = decision.allowed && process.env[flagName] === "true";
  return {
    enabled,
    skipReason: enabled ? undefined : decision.allowed
      ? `requires ${flagName}=true`
      : `requires a disposable local test database (${decision.reason})`,
  };
}
