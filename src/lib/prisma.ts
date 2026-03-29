// src/lib/prisma.ts
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  pool?: Pool;
};

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

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
