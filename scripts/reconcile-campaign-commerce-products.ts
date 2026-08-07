/**
 * Phase-4 provider-neutral campaign assignment reconciliation CLI.
 *
 * Dry run is the default. `--apply` only performs deterministic, reversible
 * duplicate-assignment deactivations; it never deletes LessonProductLink or
 * ExperienceProductLink records, enables curation, or creates assignments.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const HELP_TEXT = `Usage:
  npx tsx scripts/reconcile-campaign-commerce-products.ts [options]

Detect campaign catalog assignment inconsistencies. DRY RUN by default.

Options:
  --apply                 Deactivate only deterministic duplicate active rows.
  --brand-id=<id>         Restrict to one brand.
  --campaign-id=<id>      Restrict to one campaign.
  --limit=N               Scan at most N rows, ordered by campaign then id.
  --help, -h              Print this help.

The tool reports missing/cross-brand/ineligible/unavailable assignments but
preserves them for audit. It never logs secrets, provider metadata, URLs, or
credentials, and never deletes or modifies Lesson/Experience product links.`;

function getArg(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function formatUnhandledError(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }
  const limitArg = getArg("limit");
  const limit = limitArg ? Number.parseInt(limitArg, 10) : undefined;
  if (limitArg && (!Number.isFinite(limit) || (limit as number) <= 0)) {
    console.error(`Invalid --limit value: "${limitArg}". Must be a positive integer.`);
    process.exitCode = 2;
    return;
  }

  const apply = process.argv.includes("--apply");
  const brandId = getArg("brand-id") ?? undefined;
  const campaignId = getArg("campaign-id") ?? undefined;
  const { default: prisma } = await import("../src/lib/prisma");
  const {
    buildProductionCampaignProductReconciliationDeps,
    reconcileCampaignCommerceProducts,
  } = await import("../src/lib/commerce/campaign-product-reconciliation");

  try {
    console.log("Mode:", apply ? "APPLY" : "DRY RUN");
    if (brandId) console.log("Brand filter:", brandId);
    if (campaignId) console.log("Campaign filter:", campaignId);
    if (limit) console.log("Limit:", limit);
    const report = await reconcileCampaignCommerceProducts(
      buildProductionCampaignProductReconciliationDeps(),
      { apply, brandId, campaignId, limit },
    );
    for (const line of report.lines) console.log(line);
    console.log("Reconciliation complete.");
    console.log("Assignments scanned:", report.totals.assignmentsScanned);
    console.log("Would deactivate / deactivated:", report.totals.deactivated);
    console.log("Warnings:", report.totals.warnings);
    console.log("Failed:", report.totals.failed);
    if (!apply) console.log("Dry run complete. No DB changes made. Pass --apply to write.");
    process.exitCode = report.totals.failed > 0 ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Unhandled error:", formatUnhandledError(error));
  process.exitCode = 1;
});
