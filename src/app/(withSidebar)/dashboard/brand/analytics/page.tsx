"use client";

import { useEffect, useState } from "react";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";

type BoundedCount = { value: number; truncated: boolean };

/**
 * Mirrors `BrandCommerceAnalyticsData` in
 * `src/app/api/brand/analytics/commerce/route.ts`.
 *
 * The two campaign breakdowns are kept structurally apart here for the same
 * reason they are on the server: `entryCampaignBreakdown` answers HOW visitors
 * arrived, `productCampaignBreakdown` answers WHICH campaign authorized the
 * product they clicked, one click can be in both, and adding them double-counts.
 * They are therefore rendered as two separately-labelled tables and are never
 * summed into a single "Campaign" figure.
 *
 * A non-"OWN" entry row carries a null id and name by construction: the server
 * collapses every other tenant's campaign into one generic bucket, so this
 * client has nothing to redact and no way to reveal a competitor's campaign.
 */
type CommerceEntryCampaignRow =
  | {
      kind: "ENTRY_CAMPAIGN";
      disclosure: "OWN";
      campaignId: string;
      campaignName: string | null;
      clicks: number;
    }
  | {
      kind: "ENTRY_CAMPAIGN";
      disclosure: "OTHER_CAMPAIGN" | "NONE";
      campaignId: null;
      campaignName: null;
      clicks: number;
    };

type CommerceProductCampaignRow =
  | {
      kind: "PRODUCT_CAMPAIGN";
      disclosure: "OWN";
      campaignId: string;
      campaignName: string;
      clicks: number;
    }
  | {
      kind: "PRODUCT_CAMPAIGN";
      disclosure: "OTHER_CAMPAIGN";
      campaignId: null;
      campaignName: null;
      clicks: number;
    };

type CommerceRankedEntity = { id: string; name: string | null; clicks: number };

type CommerceAnalyticsResponse = {
  range: { start: string; end: string };
  limit: number;
  totals: {
    clicks: number;
    uniqueSessions: BoundedCount;
    uniqueUsers: BoundedCount;
    campaignEntryClicks: number;
    directEntryClicks: number;
  };
  timeSeries: Array<{ date: string; clicks: number }>;
  timeSeriesTruncated: boolean;
  surfaceBreakdown: Record<
    "BRAND_STOREFRONT" | "CAMPAIGN_PRODUCT" | "LESSON" | "UNKNOWN",
    number
  >;
  providerBreakdown: Array<{ provider: string; clicks: number }>;
  entryCampaignBreakdown: CommerceEntryCampaignRow[];
  productCampaignBreakdown: CommerceProductCampaignRow[];
  topProducts: CommerceRankedEntity[];
  topExperiences: CommerceRankedEntity[];
  topLessons: CommerceRankedEntity[];
};

const SURFACE_LABELS: Record<
  "BRAND_STOREFRONT" | "CAMPAIGN_PRODUCT" | "LESSON" | "UNKNOWN",
  string
> = {
  BRAND_STOREFRONT: "Brand storefront",
  CAMPAIGN_PRODUCT: "Campaign product",
  LESSON: "Lesson",
  UNKNOWN: "Not recorded",
};

type AnalyticsResponse = {
  campaigns: Array<{
    id: string;
    name: string;
    slug: string;
  }>;
  totals: {
    scans: number;
    unlocks: number;
    lessonStarts: number;
    lessonCompletions: number;
    shopClicks: number;
  };
  byCampaign: Array<{
    id: string;
    name: string;
    slug: string;
    scans: number;
    unlocks: number;
    lessonStarts: number;
    lessonCompletions: number;
    shopClicks: number;
  }>;
};

export default function BrandAnalyticsPage() {
  const [filters, setFilters] = useState({
    campaignId: "",
    dateFrom: "",
    dateTo: "",
  });
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commerce, setCommerce] = useState<CommerceAnalyticsResponse | null>(null);
  const [commerceError, setCommerceError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setError(null);

      try {
        const query = new URLSearchParams();
        if (filters.campaignId) query.set("campaignId", filters.campaignId);
        if (filters.dateFrom) query.set("dateFrom", filters.dateFrom);
        if (filters.dateTo) query.set("dateTo", filters.dateTo);

        const result = await fetchJson<AnalyticsResponse>(
          `/api/brand/analytics?${query.toString()}`,
        );
        setData(result);
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load brand analytics."));
      }
    }

    void load();
  }, [filters]);

  /**
   * Product-click analytics load on their own effect rather than being folded
   * into the one above.
   *
   * They are a SEPARATE ENDPOINT because they answer a different question on a
   * different key: `/api/brand/analytics` reports engagement per campaign the
   * brand owns, while `/api/brand/analytics/commerce` reports every click
   * attributed to the brand however the visitor arrived. Only the date bounds
   * are shared; the campaign filter above deliberately does NOT apply, which the
   * section says out loud rather than leaving a stale-looking panel.
   */
  useEffect(() => {
    async function loadCommerce() {
      setCommerceError(null);

      try {
        const query = new URLSearchParams();
        if (filters.dateFrom) query.set("dateFrom", filters.dateFrom);
        if (filters.dateTo) query.set("dateTo", filters.dateTo);

        const result = await fetchJson<CommerceAnalyticsResponse>(
          `/api/brand/analytics/commerce?${query.toString()}`,
        );
        setCommerce(result);
      } catch (loadError) {
        setCommerce(null);
        setCommerceError(
          getErrorMessage(loadError, "Failed to load product click analytics."),
        );
      }
    }

    void loadCommerce();
  }, [filters.dateFrom, filters.dateTo]);

  return (
    <BrandPageShell
      title="Brand Analytics"
      description="Track scans, unlocks, lesson engagement, and shop clicks across brand-owned campaigns."
    >
      <PageCard>
        <div className="grid gap-4 lg:grid-cols-3">
          <select
            value={filters.campaignId}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                campaignId: event.target.value,
              }))
            }
            className="flex h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
          >
            <option value="">All campaigns</option>
            {data?.campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>

          <input
            type="date"
            value={filters.dateFrom}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                dateFrom: event.target.value,
              }))
            }
            className="flex h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
          />

          <input
            type="date"
            value={filters.dateTo}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                dateTo: event.target.value,
              }))
            }
            className="flex h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
          />
        </div>
      </PageCard>

      {error && (
        <PageCard>
          <p className="text-sm text-red-300">{error}</p>
        </PageCard>
      )}

      {!data ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading analytics...</p>
        </PageCard>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <MetricCard label="Scans" value={data.totals.scans} />
            <MetricCard label="Unlocks" value={data.totals.unlocks} />
            <MetricCard label="Lesson starts" value={data.totals.lessonStarts} />
            <MetricCard
              label="Lesson completions"
              value={data.totals.lessonCompletions}
            />
            <MetricCard label="Shop clicks" value={data.totals.shopClicks} />
          </div>

          <PageCard>
            <h2 className="text-xl font-semibold">By campaign</h2>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-white/55">
                  <tr>
                    <th className="pb-3">Campaign</th>
                    <th className="pb-3">Scans</th>
                    <th className="pb-3">Unlocks</th>
                    <th className="pb-3">Starts</th>
                    <th className="pb-3">Completions</th>
                    <th className="pb-3">Shop clicks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {data.byCampaign.map((row) => (
                    <tr key={row.id}>
                      <td className="py-3">
                        <div>
                          <p className="font-medium">{row.name}</p>
                          <p className="text-xs text-white/45">/{row.slug}</p>
                        </div>
                      </td>
                      <td className="py-3">{row.scans}</td>
                      <td className="py-3">{row.unlocks}</td>
                      <td className="py-3">{row.lessonStarts}</td>
                      <td className="py-3">{row.lessonCompletions}</td>
                      <td className="py-3">{row.shopClicks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PageCard>
        </>
      )}

      <CommerceClickSection data={commerce} error={commerceError} />
    </BrandPageShell>
  );
}

/**
 * Outbound product clicks for the whole brand.
 *
 * Every figure here is a CLICK COUNT. SQRATCH records that a visitor was sent to
 * a merchant page and nothing after that, so this section never presents a
 * post-click outcome, and never fabricates a zero for one.
 */
function CommerceClickSection({
  data,
  error,
}: {
  data: CommerceAnalyticsResponse | null;
  error: string | null;
}) {
  if (error) {
    return (
      <PageCard>
        <h2 className="text-xl font-semibold">Product clicks</h2>
        <p className="mt-3 text-sm text-red-300">{error}</p>
      </PageCard>
    );
  }

  if (!data) {
    return (
      <PageCard>
        <h2 className="text-xl font-semibold">Product clicks</h2>
        <p className="mt-3 text-sm text-white/65">Loading product clicks...</p>
      </PageCard>
    );
  }

  const surfaceKeys = ["BRAND_STOREFRONT", "CAMPAIGN_PRODUCT", "LESSON", "UNKNOWN"] as const;
  const peakDailyClicks = data.timeSeries.reduce(
    (peak, point) => Math.max(peak, point.clicks),
    0,
  );
  const isEmpty = data.totals.clicks === 0;

  return (
    <>
      <PageCard>
        <h2 className="text-xl font-semibold">Product clicks</h2>
        <p className="mt-2 text-sm text-white/65">
          Outbound clicks on your products across every experience, for{" "}
          {formatDay(data.range.start)} to {formatDay(data.range.end)}. Counted for
          your whole brand, so the campaign filter above does not apply here.
        </p>
        <p className="mt-2 text-xs text-white/45">
          Commerce analytics currently measures outbound product clicks. Order and
          revenue attribution are not enabled.
        </p>
      </PageCard>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Product clicks" value={data.totals.clicks} />
        <MetricCard
          label="Clicking sessions"
          value={formatBounded(data.totals.uniqueSessions)}
          hint={data.totals.uniqueSessions.truncated ? "Lower bound" : undefined}
        />
        <MetricCard
          label="Signed-in clickers"
          value={formatBounded(data.totals.uniqueUsers)}
          hint={data.totals.uniqueUsers.truncated ? "Lower bound" : undefined}
        />
        <MetricCard
          label="Campaign-entry clicks"
          value={data.totals.campaignEntryClicks}
        />
        <MetricCard label="Direct-entry clicks" value={data.totals.directEntryClicks} />
      </div>

      {isEmpty ? (
        <PageCard>
          <p className="text-sm text-white/65">
            No product clicks were recorded in this date range.
          </p>
        </PageCard>
      ) : (
        <>
          <PageCard>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-lg font-semibold">Clicks per day</h3>
              {/* The sample is taken OLDEST-FIRST, so a truncated series is
                  complete for the early days of the range and then stops. The
                  later days genuinely read as 0 here even though the headline
                  total counts them, which is exactly what has to be said out
                  loud — "lower bound" alone would let a reader conclude traffic
                  stopped. */}
              {data.timeSeriesTruncated && (
                <p className="text-xs text-amber-300">
                  Incomplete: this range exceeded the sampling limit, so only its
                  earliest clicks are charted. Later days can show 0 here while
                  still being counted in the total above.
                </p>
              )}
            </div>
            <div className="mt-5 max-h-80 overflow-y-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-white/55">
                  <tr>
                    <th className="pb-3">Day (UTC)</th>
                    <th className="pb-3 w-full">Clicks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {data.timeSeries.map((point) => (
                    <tr key={point.date}>
                      <td className="py-2 whitespace-nowrap pr-4">{point.date}</td>
                      <td className="py-2">
                        <div className="flex items-center gap-3">
                          <div
                            className="h-2 rounded-full bg-white/45"
                            style={{
                              width:
                                peakDailyClicks > 0
                                  ? `${Math.round((point.clicks / peakDailyClicks) * 100)}%`
                                  : "0%",
                            }}
                          />
                          <span className="tabular-nums text-white/75">
                            {point.clicks}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PageCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <PageCard>
              <h3 className="text-lg font-semibold">Where the click happened</h3>
              <BreakdownTable
                columnLabel="Surface"
                rows={surfaceKeys.map((key) => ({
                  key,
                  label: SURFACE_LABELS[key],
                  clicks: data.surfaceBreakdown[key],
                }))}
                emptyLabel="No surface data."
              />
              <p className="mt-3 text-xs text-white/45">
                &quot;Not recorded&quot; covers clicks logged before the surface was
                tracked. It is reported as unknown rather than guessed from
                whichever link survived.
              </p>
            </PageCard>

            <PageCard>
              <h3 className="text-lg font-semibold">Commerce platform</h3>
              <BreakdownTable
                columnLabel="Platform"
                rows={data.providerBreakdown.map((row) => ({
                  key: row.provider,
                  label: row.provider === "UNKNOWN" ? "Not recorded" : row.provider,
                  clicks: row.clicks,
                }))}
                emptyLabel="No platform data."
              />
            </PageCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <PageCard>
              <h3 className="text-lg font-semibold">Entry campaign</h3>
              <p className="mt-1 text-xs text-white/45">
                How visitors reached the experience before clicking. Campaigns run
                by other brands are grouped together and never named.
              </p>
              <BreakdownTable
                columnLabel="Acquisition source"
                rows={data.entryCampaignBreakdown.map((row, index) => ({
                  key: row.campaignId ?? `${row.disclosure}-${index}`,
                  label:
                    row.disclosure === "OWN"
                      ? row.campaignName || row.campaignId
                      : row.disclosure === "OTHER_CAMPAIGN"
                        ? "Other brands' campaigns"
                        : "Campaign with no brand owner",
                  clicks: row.clicks,
                }))}
                emptyLabel="No campaign-entry clicks in this range."
              />
            </PageCard>

            <PageCard>
              <h3 className="text-lg font-semibold">Product campaign</h3>
              <p className="mt-1 text-xs text-white/45">
                Which of your campaigns authorized the clicked product. Separate
                from entry campaigns above: one click can appear in both, so the
                two are never added together.
              </p>
              <BreakdownTable
                columnLabel="Authorizing campaign"
                rows={data.productCampaignBreakdown.map((row, index) => ({
                  key: row.campaignId ?? `drifted-${index}`,
                  label:
                    row.disclosure === "OWN"
                      ? row.campaignName
                      : "Campaign no longer owned by you",
                  clicks: row.clicks,
                }))}
                emptyLabel="No product-campaign clicks in this range."
              />
            </PageCard>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <PageCard>
              <h3 className="text-lg font-semibold">Top products</h3>
              <BreakdownTable
                columnLabel="Product"
                rows={data.topProducts.map((row) => ({
                  key: row.id,
                  label: row.name || "Untitled product",
                  clicks: row.clicks,
                }))}
                emptyLabel="No product clicks in this range."
              />
            </PageCard>

            <PageCard>
              <h3 className="text-lg font-semibold">Top experiences</h3>
              <BreakdownTable
                columnLabel="Experience"
                rows={data.topExperiences.map((row) => ({
                  key: row.id,
                  label: row.name || "Untitled experience",
                  clicks: row.clicks,
                }))}
                emptyLabel="No experience clicks in this range."
              />
            </PageCard>

            <PageCard>
              <h3 className="text-lg font-semibold">Top lessons</h3>
              <BreakdownTable
                columnLabel="Lesson"
                rows={data.topLessons.map((row) => ({
                  key: row.id,
                  label: row.name || "Untitled lesson",
                  clicks: row.clicks,
                }))}
                emptyLabel="No lesson clicks in this range."
              />
            </PageCard>
          </div>
        </>
      )}
    </>
  );
}

function BreakdownTable({
  columnLabel,
  rows,
  emptyLabel,
}: {
  columnLabel: string;
  rows: Array<{ key: string; label: string; clicks: number }>;
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <p className="mt-4 text-sm text-white/55">{emptyLabel}</p>;
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-white/55">
          <tr>
            <th className="pb-3">{columnLabel}</th>
            <th className="pb-3 text-right">Clicks</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="py-2 pr-4">{row.label}</td>
              <td className="py-2 text-right tabular-nums">{row.clicks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A truncated distinct count is a LOWER BOUND, never an exact figure — the
 * server stops sampling at a ceiling. Rendering it as "50000+" keeps the claim
 * honest at a glance.
 */
function formatBounded(count: BoundedCount) {
  return count.truncated ? `${count.value}+` : count.value;
}

function formatDay(isoTimestamp: string) {
  return isoTimestamp.slice(0, 10);
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  // Widened from `number` so a bounded count can render as "50000+". Existing
  // callers pass a number and are unaffected.
  value: number | string;
  hint?: string;
}) {
  return (
    <PageCard>
      <p className="text-sm text-white/55">{label}</p>
      <p className="mt-2 text-4xl font-semibold">{value}</p>
      {hint && <p className="mt-1 text-xs text-white/45">{hint}</p>}
    </PageCard>
  );
}
