"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import {
  formatMoneyRows,
  parseBrandConversionAnalytics,
  providerLabel,
  type BrandConversionAnalytics,
  type MoneyRow,
  type NamedBreakdownRow,
  type ProviderBreakdownRow,
} from "@/lib/commerce/conversion-analytics-client";

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

  // PHASE 24 — the conversion/revenue panel is its OWN loading/error/data
  // state, isolated from engagement and click analytics above: a failure
  // here must never blank scans/unlocks/lesson data or click analytics, and
  // vice versa (see PART 19 of the task brief).
  const [conversion, setConversion] = useState<BrandConversionAnalytics | null>(null);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const [conversionLoading, setConversionLoading] = useState(true);
  // Guards against a slow, superseded request landing after a newer one when
  // the date filters change quickly — same pattern as
  // `BrandProductsClient.tsx`'s `requestSeq`.
  const conversionRequestSeq = useRef(0);

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

  /**
   * Attributed conversions & revenue — a THIRD, independent endpoint and
   * effect. Like product clicks above, this is whole-brand and keyed only on
   * the date range: the campaign dropdown does not apply (see PART 7 of the
   * task brief and the section's own copy below), so it is deliberately
   * absent from this effect's dependency array.
   */
  useEffect(() => {
    const seq = ++conversionRequestSeq.current;

    async function loadConversion() {
      setConversionLoading(true);
      setConversionError(null);

      try {
        const query = new URLSearchParams();
        if (filters.dateFrom) query.set("dateFrom", filters.dateFrom);
        if (filters.dateTo) query.set("dateTo", filters.dateTo);

        const result = await fetchJson<unknown>(
          `/api/brand/analytics/conversions?${query.toString()}`,
        );
        if (seq !== conversionRequestSeq.current) return; // superseded by a newer request

        const parsed = parseBrandConversionAnalytics(result);
        if (!parsed) {
          setConversion(null);
          setConversionError("Conversion analytics came back in an unexpected format.");
          return;
        }
        setConversion(parsed);
      } catch (loadError) {
        if (seq !== conversionRequestSeq.current) return;
        setConversion(null);
        setConversionError(
          getErrorMessage(loadError, "Failed to load conversion and revenue analytics."),
        );
      } finally {
        if (seq === conversionRequestSeq.current) setConversionLoading(false);
      }
    }

    void loadConversion();
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

      <ConversionAnalyticsSection
        data={conversion}
        error={conversionError}
        loading={conversionLoading}
      />
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
          Product clicks record outbound traffic separately from attributed
          conversions. Orders and revenue are counted only when SQRATCH has
          exact attribution evidence from the commerce integration — see
          &quot;Attributed conversions &amp; revenue&quot; below.
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

/**
 * Attributed conversions & revenue — PHASE 24.
 *
 * A separate measurement from product clicks above: a click is evidence a
 * visitor was sent to a merchant page, while everything below requires a
 * persisted `CommerceOrder` with EXACT SQRATCH attribution (the established
 * token mechanism — see `order-analytics.ts`). This section deliberately
 * never divides one by the other: click analytics are scoped by CLICK time
 * and conversion analytics are scoped by ORDER time, so an order can land in
 * a different date window than the click that produced it. A naive
 * "attributed orders / clicks" percentage would therefore be analytically
 * invalid, not merely imprecise, so no conversion-rate figure is computed or
 * shown anywhere in this file.
 *
 * Whole-brand and date-scoped only, exactly like the click section above:
 * the campaign dropdown does not apply here (this endpoint has no campaign
 * filter parameter), which the section says explicitly rather than leaving a
 * filter control that silently does nothing.
 */
const CONVERSION_COUNT_CARDS: Array<{
  key:
    | "totalIngestedOrders"
    | "attributedOrders"
    | "currentlyNetPositivePaidOrders"
    | "pendingOrAuthorizedOrders"
    | "partiallyRefundedOrders"
    | "fullyRefundedOrders";
  label: string;
  subtext: string;
}> = [
  {
    key: "totalIngestedOrders",
    label: "Orders ingested",
    subtext:
      "Orders SQRATCH received for this brand in the selected period, whether attributed or not.",
  },
  {
    key: "attributedOrders",
    label: "Attributed orders",
    subtext: "Orders matched to an exact SQRATCH commerce click.",
  },
  {
    key: "currentlyNetPositivePaidOrders",
    label: "Current paid conversions",
    subtext:
      "Attributed orders that currently retain positive net revenue. Evidence of attribution, not a claim that SQRATCH caused the sale.",
  },
  {
    key: "pendingOrAuthorizedOrders",
    label: "Pending / authorized",
    subtext: "Attributed orders whose payment has not yet settled.",
  },
  {
    key: "partiallyRefundedOrders",
    label: "Partially refunded",
    subtext: "Attributed orders with a partial refund on record.",
  },
  {
    key: "fullyRefundedOrders",
    label: "Fully refunded",
    subtext:
      "Attributed orders refunded in full — never counted as a current paid conversion above.",
  },
];

function ConversionAnalyticsSection({
  data,
  error,
  loading,
}: {
  data: BrandConversionAnalytics | null;
  error: string | null;
  loading: boolean;
}) {
  if (error) {
    return (
      <PageCard>
        <h2 className="text-xl font-semibold">Attributed conversions &amp; revenue</h2>
        <p className="mt-3 text-sm text-red-300">{error}</p>
      </PageCard>
    );
  }

  if (loading || !data) {
    return (
      <PageCard>
        <h2 className="text-xl font-semibold">Attributed conversions &amp; revenue</h2>
        <p className="mt-3 text-sm text-white/65">Loading conversion analytics...</p>
      </PageCard>
    );
  }

  const noOrders = data.totalIngestedOrders === 0;
  const noAttributionYet = !noOrders && data.attributedOrders === 0;

  return (
    <>
      <PageCard>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Attributed conversions &amp; revenue</h2>
            <p className="mt-2 text-sm text-white/65">
              Orders and revenue for {formatDay(data.range.start)} to{" "}
              {formatDay(data.range.end)}, counted only when SQRATCH has exact
              attribution evidence from the commerce integration. Counted for your
              whole brand, so the campaign filter above does not apply here.
            </p>
          </div>
          <Button
            asChild
            variant="outline"
            className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
          >
            <Link href="/dashboard/brand/commerce/orders">View order operations</Link>
          </Button>
        </div>
      </PageCard>

      {noOrders ? (
        <PageCard>
          <p className="text-sm text-white/65">
            No commerce orders were recorded in this date range.
          </p>
        </PageCard>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {CONVERSION_COUNT_CARDS.map((card) => (
              <ConversionMetricCard
                key={card.key}
                label={card.label}
                subtext={card.subtext}
                value={data[card.key]}
              />
            ))}
          </div>

          {noAttributionYet && (
            <PageCard>
              <p className="text-sm text-white/65">
                Orders have been ingested, but none in this range have exact SQRATCH
                attribution yet.
              </p>
            </PageCard>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            <MoneyRowsCard title="Gross attributed revenue" rows={data.grossAttributedRevenueByCurrency} />
            <MoneyRowsCard title="Refunded attributed revenue" rows={data.refundedRevenueByCurrency} />
            <MoneyRowsCard title="Net attributed revenue" rows={data.netAttributedRevenueByCurrency} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <PageCard>
              <h3 className="text-lg font-semibold">By provider</h3>
              <ProviderBreakdownTable
                rows={data.attributedOrdersByProvider}
                emptyLabel="No attributed orders in this range."
              />
            </PageCard>

            <PageCard>
              <h3 className="text-lg font-semibold">By Experience</h3>
              <NamedBreakdownTable
                columnLabel="Experience"
                rows={data.attributedOrdersByExperience}
                emptyLabel="No attributed orders in this range."
              />
            </PageCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <PageCard>
              <h3 className="text-lg font-semibold">By entry campaign</h3>
              <p className="mt-1 text-xs text-white/45">
                Acquisition context — how the visitor arrived. Shows only campaigns
                your brand owns; an order attributed through another brand&apos;s
                acquisition campaign still counts above but has nothing to name
                here.
              </p>
              <NamedBreakdownTable
                columnLabel="Entry campaign"
                rows={data.attributedOrdersByEntryCampaign}
                emptyLabel="No attributed orders in this range."
              />
            </PageCard>

            <PageCard>
              <h3 className="text-lg font-semibold">By product campaign</h3>
              <p className="mt-1 text-xs text-white/45">
                Product-authorization context — which campaign authorized the
                purchased product. Separate from entry campaign above: one order
                can appear in both, so the two are never added together.
              </p>
              <NamedBreakdownTable
                columnLabel="Product campaign"
                rows={data.attributedOrdersByProductCampaign}
                emptyLabel="No attributed orders in this range."
              />
            </PageCard>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <PageCard>
              <h3 className="text-lg font-semibold">By Creator</h3>
              <NamedBreakdownTable
                columnLabel="Creator"
                rows={data.attributedOrdersByCreator}
                emptyLabel="No attributed orders in this range."
              />
            </PageCard>

            <PageCard>
              <h3 className="text-lg font-semibold">By Lesson</h3>
              <NamedBreakdownTable
                columnLabel="Lesson"
                rows={data.attributedOrdersByLesson}
                emptyLabel="No attributed orders in this range."
              />
            </PageCard>

            <PageCard>
              <h3 className="text-lg font-semibold">By Product</h3>
              <NamedBreakdownTable
                columnLabel="Product"
                rows={data.attributedOrdersByProduct}
                emptyLabel="No attributed orders in this range."
              />
            </PageCard>
          </div>
        </>
      )}
    </>
  );
}

function ConversionMetricCard({
  label,
  subtext,
  value,
}: {
  label: string;
  subtext: string;
  value: number;
}) {
  return (
    <PageCard>
      <p className="text-sm text-white/55">{label}</p>
      <p className="mt-2 text-4xl font-semibold">{value}</p>
      <p className="mt-2 text-xs text-white/45">{subtext}</p>
    </PageCard>
  );
}

/**
 * Renders a `MoneyRow[]` as one independently-labelled line per currency —
 * see `formatMoneyRows`'s own header for why these are never summed. An
 * empty array renders an explicit "no revenue" sentence rather than a
 * fabricated `$0.00`, since an empty array is not evidence of a known
 * currency at zero.
 */
function MoneyRowsCard({ title, rows }: { title: string; rows: MoneyRow[] }) {
  const lines = formatMoneyRows(rows);
  return (
    <PageCard>
      <h3 className="text-lg font-semibold">{title}</h3>
      {lines.length === 0 ? (
        <p className="mt-3 text-sm text-white/65">No attributed revenue in this range.</p>
      ) : (
        <ul className="mt-3 space-y-1 text-sm">
          {lines.map((line) => (
            <li key={line} className="tabular-nums text-white/85">
              {line}
            </li>
          ))}
        </ul>
      )}
    </PageCard>
  );
}

function ProviderBreakdownTable({
  rows,
  emptyLabel,
}: {
  rows: ProviderBreakdownRow[];
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
            <th className="pb-3">Platform</th>
            <th className="pb-3 text-right">Orders</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="py-2 pr-4">{providerLabel(row.id)}</td>
              <td className="py-2 text-right tabular-nums">{row.orders}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Reasonable footprint for a breakdown that could otherwise grow unbounded. */
const CONVERSION_BREAKDOWN_DISPLAY_LIMIT = 10;

function NamedBreakdownTable({
  columnLabel,
  rows,
  emptyLabel,
}: {
  columnLabel: string;
  rows: NamedBreakdownRow[];
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <p className="mt-4 text-sm text-white/55">{emptyLabel}</p>;
  }
  const visible = rows.slice(0, CONVERSION_BREAKDOWN_DISPLAY_LIMIT);
  const hiddenCount = rows.length - visible.length;
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-white/55">
          <tr>
            <th className="pb-3">{columnLabel}</th>
            <th className="pb-3 text-right">Orders</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {visible.map((row) => (
            <tr key={row.id}>
              <td className="py-2 pr-4">{row.name ?? "Unavailable"}</td>
              <td className="py-2 text-right tabular-nums">{row.orders}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hiddenCount > 0 && (
        <p className="mt-2 text-xs text-white/45">+{hiddenCount} more not shown.</p>
      )}
    </div>
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
