// Side-effect module: import this FIRST (before any module that transitively
// imports src/lib/prisma) so the prisma singleton finds a DATABASE_URL at import
// time. Not a *.test.ts file, so the test runner never executes it directly.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://dummy:dummy@localhost:5432/dummy";
