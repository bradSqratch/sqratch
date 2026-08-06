// Side-effect module: import this FIRST (before any module that transitively
// imports src/lib/prisma) so the prisma singleton finds a DATABASE_URL at import
// time. Not a *.test.ts file, so the test runner never executes it directly.
//
// Unconditional assignment (never `??`/`||=`): a pre-set shell DATABASE_URL
// (e.g. an exported production Supabase URL, which local dev in this repo
// deliberately uses) must never leak into a test process. The value below
// is deliberately unreachable (port 1 on loopback) so even a stray, unmocked
// query cannot land on a real database. See src/lib/db-safety.ts for the
// guard that also enforces this at the src/lib/prisma.ts chokepoint.
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
