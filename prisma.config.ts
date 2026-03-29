// prisma/prisma.config.ts
import { defineConfig } from "prisma/config";
import "dotenv/config";

export default defineConfig({
  schema: "prisma/schema.prisma",

  migrations: {
    path: "prisma/migrations",
  },

  datasource: {
    // Use a direct Supabase connection for Prisma CLI workflows when available.
    url: process.env.DIRECT_URL || process.env.DATABASE_URL!,
  },
});
