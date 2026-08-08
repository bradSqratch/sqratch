# SQRATCH Agent Rules

These rules apply repository-wide. Preserve Graphify-generated sections below; they are maintained by Graphify.

## Working Tree Safety

Other AI agents or the user may be modifying this repository concurrently.

- Inspect the current working tree before substantial edits.
- Preserve unrelated and uncommitted changes.
- Never reset, revert, clean, stash, or overwrite unrelated work.
- Re-read a target file immediately before modifying it if concurrent work may be occurring.
- Make the smallest coherent change required for the task.

## Codebase Navigation

Use Graphify as the first orientation layer for architecture, dependencies, call flows, and file relationships.

Before stating factual conclusions about current runtime behavior, data ownership, persistence, authentication, security, or architectural authority, verify the relevant current source files identified by Graphify.

Graphify is not the source of truth. After Graphify identifies relevant files, inspect the current source before modifying code.

Targeted `rg`, `grep`, file search, or direct reads are allowed when:
- locating an exact symbol, string, route, environment variable, or error;
- Graphify returns insufficient information;
- the graph may be stale;
- source-level verification is required.

Avoid broad recursive repository scanning when Graphify can narrow the search first.

## Graph Maintenance

For normal code changes, do not perform a full Graphify rebuild.

After completing code modifications, run one:

`graphify update .`

Do not run multiple Graphify update/build processes concurrently.

If multiple coding agents are actively modifying the same working tree, defer the final Graphify update until concurrent work is complete.

Never manually edit files inside `graphify-out/`.

## SQRATCH Stack

Follow existing SQRATCH conventions before introducing new abstractions.

Primary stack:
- Next.js App Router
- React
- TypeScript
- Prisma
- PostgreSQL
- NextAuth
- Tailwind CSS

Prefer existing utilities, components, services, and patterns over duplicate implementations.

## Verification

Run focused tests while developing.

For substantial changes, run:

`npm run verify`

when the environment permits.

Do not suppress lint, type, Prisma, test, or build failures. Clearly distinguish pre-existing failures from failures caused by the current change.

## Database Safety

Inspect the existing Prisma schema and migrations before database changes.

Never reset, drop, truncate, or destructively modify an unknown, shared, or production database.

Do not expose secrets, API keys, tokens, passwords, connection strings, or complete environment variable values.

## Git

Do not commit, push, merge, rebase, force-push, or publish changes unless explicitly requested.

Before reporting completion, inspect the relevant diff and current `git status`.


## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
