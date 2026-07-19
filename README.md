# SQRATCH

SQRATCH turns physical QR stickers into a loyalty and content platform: brands print QR codes, shoppers scan them to unlock branded video/community experiences, earn points for participating, and redeem those points for Shopify discount codes.

## Core product flow

```
QR scan → campaign unlock → experience (courses, posts, Q&A) → points earned → Shopify reward redeemed
```

1. A brand prints a QR sticker tied to a **Campaign**.
2. A customer scans it, which unlocks the campaign's **Experience** (video courses, community posts, Q&A) and starts a session (anonymous or signed in).
3. As the customer engages — scanning, completing lessons/courses — they earn SQRATCH **points**, recorded in an immutable ledger.
4. The customer redeems points for a single-use **Shopify discount code**, generated live via the Shopify Admin API against the brand's connected store.

## Technology stack

- **Framework:** Next.js 15 (App Router), React 19, TypeScript
- **Database / ORM:** PostgreSQL via Prisma 7, hosted on Supabase
- **Auth:** next-auth v4 (credentials provider, JWT sessions)
- **Storage:** Supabase Storage (lesson videos, brand assets, avatars)
- **Email:** SMTP (Mailtrap-compatible) with an async queue
- **Commerce integration:** Shopify Admin GraphQL API (embedded app + OAuth)
- **Styling/UI:** Tailwind CSS, Radix UI primitives
- **Testing:** Node.js built-in test runner (`node:test`)
- **Deployment:** Vercel

## Main roles

| Role | Description |
|---|---|
| `USER` | End customer — scans QR codes, consumes experiences, earns and redeems points |
| `CREATOR` | Builds experiences (courses, lessons, posts) |
| `BRAND_ADMIN` | Manages a brand's campaigns, Shopify connection, and reward offers |
| `ADMIN` | SQRATCH internal staff — full platform access |

## Local prerequisites

- Node.js (see `.github/workflows/ci.yml` for the CI-tested version)
- npm (this repository uses npm — no yarn/pnpm/bun lockfile is maintained)
- A PostgreSQL database (a Supabase project, or any local/disposable Postgres for development)

## Installation

```bash
npm install
```

## Local development

```bash
npm run dev        # start the dev server (Turbopack)
npm run build       # production build
npm run start        # run a production build locally
npm run typecheck    # tsc --noEmit
npm run lint          # eslint
npm test               # run the test suite (tests/*.test.ts)
```

## Verification

Before opening a pull request, run the same checks CI runs:

```bash
npx prisma validate
npx prisma generate
npm run typecheck
npm run lint
npm test
npm run build
npm run verify        # convenience script that chains validate → typecheck → lint → test → build
npm audit --omit=dev
```

CI (`.github/workflows/ci.yml`) runs these on every push to `main` and every pull request, using mocked persistence and injected dependencies — no live database or external service is required to run the test suite.

## Environment configuration

Copy `.env.example` to `.env` and fill in real values for local development. Every variable is described — grouped by purpose, marked required/optional, and mapped to the code that reads it — in **[docs/env-vars.md](docs/env-vars.md)**. Never commit a filled-in `.env` file, and never put a server secret in a `NEXT_PUBLIC_*` variable.

## Database and migration safety

This project uses Prisma migrations against a shared Supabase database. **Never run `prisma migrate dev` against production.** Migration history in this repository has diverged from the deployed database before; always verify actual database state with `prisma migrate status` / `prisma migrate diff` rather than assuming the local migration folder list reflects what is deployed. Full procedure, preflight checks, and history notes: **[docs/prisma-migrations.md](docs/prisma-migrations.md)**.

## Shopify integration

SQRATCH connects to a brand's Shopify store (via OAuth or embedded App Bridge token exchange) to read products for display and create single-use discount codes for point redemptions. Scopes are limited to `read_products`, `read_discounts`, `write_discounts` — the app never writes or mutates products. Four Shopify compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled`) are implemented and HMAC-verified. Details: **[docs/shopify-testing.md](docs/shopify-testing.md)** (testing/verification checklists) and **[docs/shopify-data-inventory.md](docs/shopify-data-inventory.md)** (what Shopify-linked data is stored, retained, or erased).

## Points and rewards

Every point award, spend, and refund is written through a single, atomic ledger function. `PointTransaction` is the immutable activity ledger; `UserPointAccount` is the authoritative current-balance aggregate, kept mathematically consistent with the ledger. Full invariants: **[docs/points-ledger.md](docs/points-ledger.md)**.

## Repository structure

```
sqratch/
├── prisma/            # schema.prisma, migrations/, seed.ts
├── src/
│   ├── app/            # Next.js App Router — pages and API routes
│   ├── components/    # React components
│   ├── lib/             # Server-side business logic
│   └── helpers/       # Email templates and sending
├── tests/              # node:test suite
├── docs/                # Architecture, migration, and operational documentation
└── .github/workflows/  # CI pipeline
```

A full route map, API map, and data model map are maintained in **[docs/codebase-map.md](docs/codebase-map.md)**.

## CI and deployment

- **CI:** GitHub Actions runs `prisma generate`/`validate`, typecheck, lint, tests, build, and `npm audit` on every push/PR to `main`.
- **Deployment:** Vercel, using per-environment (Development/Preview/Production) environment variables configured in the Vercel dashboard.

## Documentation index

| Doc | Covers |
|---|---|
| [docs/codebase-map.md](docs/codebase-map.md) | Architecture, routes, API map, data model, auth |
| [docs/agent-context.md](docs/agent-context.md) | Quick-reference for making safe changes |
| [docs/points-ledger.md](docs/points-ledger.md) | Points/rewards ledger invariants |
| [docs/prisma-migrations.md](docs/prisma-migrations.md) | Migration history and deployment runbook |
| [docs/shopify-testing.md](docs/shopify-testing.md) | Shopify integration testing checklists |
| [docs/shopify-data-inventory.md](docs/shopify-data-inventory.md) | Shopify GDPR data inventory |
| [docs/env-vars.md](docs/env-vars.md) | Environment variable reference |

## Secrets and production safety

- Never commit `.env`, real API keys, encryption keys, database URLs, or customer data. `.env.example` contains placeholders only.
- `APP_ENCRYPTION_KEY` encrypts stored Shopify access/refresh tokens; rotating it makes existing encrypted credentials unreadable until stores reconnect.
- `NEXTAUTH_SECRET` signs authentication sessions independently of `APP_ENCRYPTION_KEY` — rotating one does not affect the other.
- Do not run destructive database operations, apply migrations, or change production environment variables without following the procedure in `docs/prisma-migrations.md`.
- Report suspected security issues privately rather than opening a public issue.
