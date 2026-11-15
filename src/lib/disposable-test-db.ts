import { canUseRealDatabaseUnderTest, classifyDbTarget, type RealDbAccessInputs, type RealDbAccessDecision } from "./db-safety";

/** Additional fail-closed URL checks for code that actually uses a disposable database. */
export function disposableTestDbDecision(input: RealDbAccessInputs): RealDbAccessDecision {
  const value = input.connectionString;
  // Reject query and fragment parameters, URL normalization of the database
  // path, encoded database names, and malformed percent escapes. pg accepts
  // query overrides such as ?host=, so hostname classification alone is unsafe.
  if (!/^postgres(?:ql)?:\/\/[^/?#\\\s]+\/[A-Za-z0-9_]+_test$/.test(value) || /%(?![0-9a-f]{2})/i.test(value)) {
    return { allowed: false, reason: "target must be a plain PostgreSQL test URL without query or fragment" };
  }
  const decision = canUseRealDatabaseUnderTest(input);
  if (!decision.allowed) return decision;
  if (classifyDbTarget(value).classification !== "loopback-local") {
    return { allowed: false, reason: "target must be a disposable loopback database" };
  }
  return decision;
}
