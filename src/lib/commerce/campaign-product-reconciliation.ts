/**
 * Provider-neutral Phase-4 campaign-product reconciliation logic.
 *
 * This module is deliberately dependency-injected so dry runs and every test
 * can use in-memory fakes. The CLI is only a thin argument/parser wrapper.
 * It never reads providerMetadata, connection secrets, or product URLs, and
 * it never deletes or edits LessonProductLink / ExperienceProductLink rows.
 *
 * Repairs are intentionally narrow. Only duplicate active assignments are
 * deterministically repaired: the earliest created row (then id) remains
 * active and the others are deactivated. Missing/cross-brand/ineligible/
 * unavailable references are reported but preserved for audit/history; current
 * authorization must fail closed from their live state.
 */

export type CampaignAssignmentRow = {
  id: string;
  brandId: string;
  campaignId: string;
  brandCommerceProductId: string;
  isActive: boolean;
  createdAt: Date;
  deactivatedAt: Date | null;
  campaign: {
    id: string;
    brandId: string | null;
  } | null;
  brandCommerceProduct: {
    id: string;
    brandId: string;
    isCampaignEligible: boolean;
    connectedProduct: {
      id: string;
      brandId: string;
      isAvailable: boolean;
    } | null;
  } | null;
};

export type CampaignProductReconciliationFilter = {
  brandId?: string;
  campaignId?: string;
  limit?: number;
};

export type CampaignProductReconciliationDeps = {
  listAssignments(filter: CampaignProductReconciliationFilter): Promise<CampaignAssignmentRow[]>;
  /** Reversible repair only. Implementations must not delete an assignment. */
  deactivateAssignment(assignmentId: string, deactivatedAt: Date): Promise<{ updated: boolean }>;
};

export type CampaignProductReconciliationFindingKind =
  | "missing_campaign"
  | "missing_brand_commerce_product"
  | "cross_brand_assignment"
  | "product_wrong_brand"
  | "product_not_campaign_eligible"
  | "product_unavailable"
  | "duplicate_active_assignment";

export type CampaignProductReconciliationFinding = {
  kind: CampaignProductReconciliationFindingKind;
  assignmentId: string;
  brandId: string;
  campaignId: string;
  detail: string;
  repaired: boolean;
};

export type CampaignProductReconciliationTotals = {
  assignmentsScanned: number;
  deactivated: number;
  warnings: number;
  failed: number;
};

export type CampaignProductReconciliationReport = {
  mode: "dry_run" | "apply";
  totals: CampaignProductReconciliationTotals;
  findings: CampaignProductReconciliationFinding[];
  /** Sanitized, bounded diagnostic strings suitable for the CLI. */
  lines: string[];
};

export type CampaignProductReconciliationOptions = CampaignProductReconciliationFilter & {
  /** Defaults to false. No write-shaped dependency is called unless true. */
  apply?: boolean;
};

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

async function defaultListAssignments(
  filter: CampaignProductReconciliationFilter,
): Promise<CampaignAssignmentRow[]> {
  const prisma = await getPrisma();
  const rows = await prisma.campaignCommerceProduct.findMany({
    where: {
      ...(filter.brandId ? { brandId: filter.brandId } : {}),
      ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
    },
    select: {
      id: true,
      brandId: true,
      campaignId: true,
      brandCommerceProductId: true,
      isActive: true,
      createdAt: true,
      deactivatedAt: true,
      campaign: { select: { id: true, brandId: true } },
      brandCommerceProduct: {
        select: {
          id: true,
          brandId: true,
          isCampaignEligible: true,
          connectedProduct: { select: { id: true, brandId: true, isAvailable: true } },
        },
      },
    },
    orderBy: [{ campaignId: "asc" }, { id: "asc" }],
    ...(filter.limit ? { take: filter.limit } : {}),
  });

  return rows;
}

async function defaultDeactivateAssignment(
  assignmentId: string,
  deactivatedAt: Date,
): Promise<{ updated: boolean }> {
  const prisma = await getPrisma();
  await prisma.campaignCommerceProduct.update({
    where: { id: assignmentId },
    data: { isActive: false, deactivatedAt },
  });
  return { updated: true };
}

/** Real Prisma deps for the CLI. Importing this module itself does not connect to a database. */
export function buildProductionCampaignProductReconciliationDeps(): CampaignProductReconciliationDeps {
  return {
    listAssignments: defaultListAssignments,
    deactivateAssignment: defaultDeactivateAssignment,
  };
}

function formatLine(
  level: "INFO" | "WARN" | "ERROR",
  row: Pick<CampaignAssignmentRow, "brandId" | "campaignId" | "id">,
  message: string,
): string {
  return `[${level}] brand=${row.brandId} campaign=${row.campaignId} assignment=${row.id} ${message}`;
}

/** Active duplicate groups keyed by SQRATCH assignment references, never provider ids. */
export function findDuplicateActiveAssignmentGroups(
  rows: readonly CampaignAssignmentRow[],
): CampaignAssignmentRow[][] {
  const groups = new Map<string, CampaignAssignmentRow[]>();
  for (const row of rows) {
    if (!row.isActive) continue;
    const key = `${row.campaignId}\u0000${row.brandCommerceProductId}`;
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function stableDuplicateWinner(rows: readonly CampaignAssignmentRow[]): CampaignAssignmentRow {
  return [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  )[0];
}

function addWarning(
  report: {
    findings: CampaignProductReconciliationFinding[];
    lines: string[];
    totals: CampaignProductReconciliationTotals;
  },
  row: CampaignAssignmentRow,
  kind: Exclude<CampaignProductReconciliationFindingKind, "duplicate_active_assignment">,
  detail: string,
) {
  report.totals.warnings += 1;
  report.lines.push(formatLine("WARN", row, `${kind}: ${detail}; preserved for manual review`));
  report.findings.push({
    kind,
    assignmentId: row.id,
    brandId: row.brandId,
    campaignId: row.campaignId,
    detail,
    repaired: false,
  });
}

/**
 * Detects anomalous campaign assignments and, only with `{ apply: true }`,
 * deterministically deactivates duplicate active rows. This is idempotent:
 * subsequent runs see at most one active assignment in each duplicate group.
 */
export async function reconcileCampaignCommerceProducts(
  deps: CampaignProductReconciliationDeps,
  options: CampaignProductReconciliationOptions = {},
): Promise<CampaignProductReconciliationReport> {
  const apply = options.apply === true;
  const rows = await deps.listAssignments({
    brandId: options.brandId,
    campaignId: options.campaignId,
    limit: options.limit,
  });
  const report: CampaignProductReconciliationReport = {
    mode: apply ? "apply" : "dry_run",
    totals: { assignmentsScanned: rows.length, deactivated: 0, warnings: 0, failed: 0 },
    findings: [],
    lines: [],
  };

  for (const row of rows) {
    if (!row.campaign) {
      addWarning(report, row, "missing_campaign", "Campaign relation is missing");
      continue;
    }
    if (!row.brandCommerceProduct) {
      addWarning(report, row, "missing_brand_commerce_product", "BrandCommerceProduct relation is missing");
      continue;
    }

    if (row.campaign.brandId !== row.brandId || row.brandCommerceProduct.brandId !== row.brandId) {
      addWarning(
        report,
        row,
        "cross_brand_assignment",
        `assignment brandId=${row.brandId} differs from campaign or brand product ownership`,
      );
    }
    if (!row.brandCommerceProduct.connectedProduct) {
      addWarning(report, row, "product_wrong_brand", "ConnectedCommerceProduct relation is missing");
    } else {
      if (row.brandCommerceProduct.connectedProduct.brandId !== row.brandCommerceProduct.brandId) {
        addWarning(
          report,
          row,
          "product_wrong_brand",
          "ConnectedCommerceProduct ownership differs from BrandCommerceProduct ownership",
        );
      }
      if (!row.brandCommerceProduct.connectedProduct.isAvailable) {
        addWarning(report, row, "product_unavailable", "connected product is unavailable");
      }
    }
    if (!row.brandCommerceProduct.isCampaignEligible) {
      addWarning(report, row, "product_not_campaign_eligible", "brand product is not campaign eligible");
    }
  }

  const duplicateGroups = findDuplicateActiveAssignmentGroups(rows);
  for (const group of duplicateGroups) {
    const winner = stableDuplicateWinner(group);
    for (const row of group) {
      if (row.id === winner.id) continue;
      const detail = `duplicate active assignment; keeping assignmentId=${winner.id} and deactivating this row`;
      let repaired = false;
      report.totals.warnings += 1;
      report.lines.push(formatLine("WARN", row, `duplicate_active_assignment: ${detail}`));
      if (apply) {
        try {
          const result = await deps.deactivateAssignment(row.id, new Date());
          repaired = result.updated;
          if (repaired) {
            report.totals.deactivated += 1;
            report.lines.push(formatLine("INFO", row, "repaired: assignment deactivated; no links deleted"));
          }
        } catch (error) {
          report.totals.failed += 1;
          report.lines.push(
            formatLine(
              "ERROR",
              row,
              `failed to deactivate duplicate_active_assignment: ${error instanceof Error ? error.name : "unknown error"}`,
            ),
          );
        }
      } else {
        report.totals.deactivated += 1;
      }
      report.findings.push({
        kind: "duplicate_active_assignment",
        assignmentId: row.id,
        brandId: row.brandId,
        campaignId: row.campaignId,
        detail,
        repaired,
      });
    }
  }

  return report;
}
