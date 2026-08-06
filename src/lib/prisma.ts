// src/lib/prisma.ts
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { assertDatabaseAccessAllowed, detectTestEnvironment } from "./db-safety";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  pool?: Pool;
};

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

// --- Production-database safety guard ---------------------------------
// Local dev in this repo deliberately points DATABASE_URL at the
// PRODUCTION Supabase database. This call is a complete no-op unless the
// current process is detected as a test run (see detectTestEnvironment in
// ./db-safety) — production and dev behavior are byte-for-byte unchanged.
// It is placed here, BEFORE the Pool and PrismaClient are constructed
// below, so nothing can obtain a client without passing it: both
// constructors are lazy (no socket opens until the first query), so a
// synchronous throw here aborts before any query could ever execute.
assertDatabaseAccessAllowed({
  connectionString: databaseUrl,
  isTestEnvironment: detectTestEnvironment(),
  allowRealDatabaseTestsEnv: process.env.ALLOW_REAL_DATABASE_TESTS,
});
// ------------------------------------------------------------------------

const configuredPoolMax = Number.parseInt(
  process.env.PG_POOL_MAX ?? (process.env.VERCEL ? "1" : "5"),
  10,
);

const poolMax =
  Number.isFinite(configuredPoolMax) && configuredPoolMax > 0
    ? configuredPoolMax
    : 1;

const idleTimeoutMillis = Number.parseInt(
  process.env.PG_IDLE_TIMEOUT_MS ?? "30000",
  10,
);

const connectionTimeoutMillis = Number.parseInt(
  process.env.PG_CONNECT_TIMEOUT_MS ?? "10000",
  10,
);

const ssl =
  process.env.PG_SSL_REJECT_UNAUTHORIZED === "false"
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true };

if (!globalForPrisma.pool) {
  globalForPrisma.pool = new Pool({
    connectionString: databaseUrl,
    max: poolMax,
    idleTimeoutMillis: Number.isFinite(idleTimeoutMillis)
      ? idleTimeoutMillis
      : 30000,
    connectionTimeoutMillis: Number.isFinite(connectionTimeoutMillis)
      ? connectionTimeoutMillis
      : 10000,
    ssl,
  });
}

if (!globalForPrisma.prisma) {
  const adapter = new PrismaPg(globalForPrisma.pool);

  globalForPrisma.prisma = new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development" ? ["query", "error"] : ["error"],
  });
}

const prisma = globalForPrisma.prisma;

export default prisma;
