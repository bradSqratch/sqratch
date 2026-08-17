# SQRATCH Agent Rules

These rules apply repository-wide.
Preserve Graphify-generated sections; Graphify maintains them.

## Working Tree Safety

- Inspect `git status` before substantial edits.
- Preserve unrelated and uncommitted work.
- Never reset, revert, clean, stash, or overwrite unrelated changes.
- Re-read a target file before editing when concurrent work may exist.
- Make the smallest coherent change required.

## Codebase Navigation

Follow the generated `## graphify` rules below for initial navigation.
Graphify narrows the search space; current source code is authoritative.

Use targeted source search only when locating an exact symbol/string/path,
Graphify is insufficient or stale, or source verification is required.

## Stack

Next.js App Router, React, TypeScript, Prisma/PostgreSQL, NextAuth, Tailwind.
Prefer existing project abstractions and conventions over new duplicates.

## Verification & Execution Economy

- Run focused tests while developing.
- Run the full verification suite only when explicitly requested or at a final
  security/data-integrity release gate.
- Never suppress Prisma, typecheck, lint, test, or build failures.
- Suppress verbose successful command output; report status/counts and relevant failures.
- Do not restate these repository rules in plans or completion reports.
- The user performs live browser, production, database, and external-provider QA
  unless explicitly requested otherwise.

## Database Safety

- Inspect Prisma schema and migrations before database changes.
- Never reset, drop, truncate, or destructively modify an unknown/shared database.
- Never apply migrations unless explicitly requested.
- Never expose secrets, tokens, passwords, database URLs, or complete environment values.

## Git / Deployment Safety

- Never commit, push, merge, rebase, force-push, publish, or deploy unless explicitly requested.
- Never run `shopify app deploy` unless explicitly requested.
- Before completion inspect the relevant diff and `git status`.

## Commerce Invariants

- `CommerceConnection` and provider-neutral commerce models are canonical.
- Provider-specific API/transport behavior ends at provider modules/adapters.
- Never trust client-supplied Brand, merchant, product, Campaign, Creator, or attribution identity.
- External carts carry only opaque SQRATCH attribution evidence.
- Verify provider webhook authenticity before processing payloads.
- Order creation does not imply payment.
- Refunds/cancellations update current net analytics without erasing historical attribution.
- Do not expose customer PII in Creator commerce analytics.
- Current Campaign ownership must not rewrite historical attribution.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Execution Economy

- Do not restate repository rules from this file in plans or completion reports.
- Use focused tests while developing.
- Run the full verification suite only when explicitly requested or when a
  security/data-integrity final gate requires it.
- Suppress verbose successful command output; report exit status, counts, and
  relevant failures only.
- The user performs live browser, production, and external-provider QA unless
  explicitly requested otherwise.

## Commerce Invariants

- CommerceConnection and provider-neutral commerce models are canonical.
- Provider-specific transport/API behavior stops at provider modules/adapters.
- Never trust client-supplied merchant/product/campaign/creator identity.
- Store only opaque SQRATCH attribution evidence in external carts.
- Verify provider webhook authenticity before parsing/processing.
- Order creation does not mean payment.
- Refunds/cancellations must update current net analytics without destroying
  historical attribution.
- No customer PII belongs in creator commerce analytics.
