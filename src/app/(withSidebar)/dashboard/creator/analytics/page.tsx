"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CreatorPageShell } from "@/components/creator/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import {
  formatMoneyRows,
  parseCreatorConversionAnalytics,
  providerLabel,
  type CreatorConversionAnalytics,
  type MoneyRow,
  type NamedBreakdownRow,
  type ProviderBreakdownRow,
} from "@/lib/commerce/conversion-analytics-client";

type AnalyticsResponse = {
  filters: {
    experienceId: string | null;
    dateFrom: string | null;
    dateTo: string | null;
  };
  experiences: Array<{
    id: string;
    title: string;
    slug: string;
  }>;
  totals: {
    views: number;
    lessonStarts: number;
    lessonCompletions: number;
    questions: number;
    completedLessonsFromProgress: number;
  };
  byExperience: Array<{
    id: string;
    title: string;
    slug: string;
    views: number;
    lessonStarts: number;
    lessonCompletions: number;
    questions: number;
  }>;
};

/**
 * Phase 11: the CLICK-ONLY commerce shape returned by
 * `/api/creator/analytics/commerce`.
 *
 * Every field here is a click count. SQRATCH cannot observe anything after a
 * visitor leaves for a merchant page, so this panel reports outbound clicks
 * only and the server-supplied `note` states plainly what is not measured.
 *
 * "Campaign entry" and "Direct entry" describe HOW the visitor arrived. They
 * are never merged with, or relabelled as, the campaign that authorized a
 * clicked product — those are two different questions about one click.
 */
type CommerceAnalyticsResponse = {
  range: { start: string; end: string };
  filters: { experienceId: string | null; limit: number };
  totals: {
    clicks: number;
    uniqueSessions: { value: number; truncated: boolean };
    uniqueUsers: { value: number; truncated: boolean };
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
  topProducts: Array<{ id: string; name: string | null; clicks: number }>;
  topLessons: Array<{ id: string; title: string | null; clicks: number }>;
  topExperiences?: Array<{ id: string; title: string | null; clicks: number }>;
  note: string;
};

const SURFACE_LABELS: Record<string, string> = {
  BRAND_STOREFRONT: "Brand storefront",
  CAMPAIGN_PRODUCT: "Campaign product",
  LESSON: "Lesson",
  UNKNOWN: "Unknown",
};

export default function CreatorAnalyticsPage() {
  const [filters, setFilters] = useState({
    experienceId: "",
    dateFrom: "",
    dateTo: "",
  });
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commerce, setCommerce] = useState<CommerceAnalyticsResponse | null>(
    null,
  );
  const [commerceError, setCommerceError] = useState<string | null>(null);
  const [commerceLoading, setCommerceLoading] = useState(true);

  // PHASE 24 — the conversion/revenue panel is its OWN loading/error/data
  // state: a failure here must never blank the experience or click panels
  // above, and vice versa.
  const [conversion, setConversion] = useState<CreatorConversionAnalytics | null>(null);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const [conversionLoading, setConversionLoading] = useState(true);
  const conversionRequestSeq = useRef(0);

  const load = useCallback(async () => {
    setError(null);

    try {
      const query = new URLSearchParams();

      if (filters.experienceId) {
        query.set("experienceId", filters.experienceId);
      }
      if (filters.dateFrom) {
        query.set("dateFrom", filters.dateFrom);
      }
      if (filters.dateTo) {
        query.set("dateTo", filters.dateTo);
      }

      const result = await fetchJson<AnalyticsResponse>(
        `/api/creator/analytics?${query.toString()}`,
      );
      setData(result);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load analytics."));
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  // A parallel effect rather than an extension of `load`: the commerce panel
  // has its own endpoint, its own failure mode and its own empty state, and a
  // commerce error must not blank out the experience metrics above it.
  const loadCommerce = useCallback(async () => {
    setCommerceError(null);
    setCommerceLoading(true);

    try {
      const query = new URLSearchParams();

      if (filters.experienceId) {
        query.set("experienceId", filters.experienceId);
      }
      if (filters.dateFrom) {
        query.set("dateFrom", filters.dateFrom);
      }
      if (filters.dateTo) {
        query.set("dateTo", filters.dateTo);
      }

      const result = await fetchJson<CommerceAnalyticsResponse>(
        `/api/creator/analytics/commerce?${query.toString()}`,
      );
      setCommerce(result);
    } catch (loadError) {
      setCommerce(null);
      setCommerceError(
        getErrorMessage(loadError, "Failed to load product click analytics."),
      );
    } finally {
      setCommerceLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void loadCommerce();
  }, [loadCommerce]);

  /**
   * Attributed conversions & revenue. Unlike the click panel, this DOES
   * forward `experienceId` — the conversions route validates it against this
   * creator's own owned Experiences server-side (identical ownership check
   * to `/api/creator/analytics/commerce`) before applying it, so an id this
   * creator does not own is rejected rather than silently ignored or
   * silently widening the result.
   */
  const loadConversion = useCallback(async () => {
    const seq = ++conversionRequestSeq.current;
    setConversionLoading(true);
    setConversionError(null);

    try {
      const query = new URLSearchParams();
      if (filters.experienceId) query.set("experienceId", filters.experienceId);
      if (filters.dateFrom) query.set("dateFrom", filters.dateFrom);
      if (filters.dateTo) query.set("dateTo", filters.dateTo);

      const result = await fetchJson<unknown>(
        `/api/creator/analytics/conversions?${query.toString()}`,
      );
      if (seq !== conversionRequestSeq.current) return; // superseded by a newer request

      const parsed = parseCreatorConversionAnalytics(result);
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
  }, [filters]);

  useEffect(() => {
    void loadConversion();
  }, [loadConversion]);

  return (
    <CreatorPageShell
      title="Creator Analytics"
      description="Track experience views, lesson starts and completions, and Q&A volume across your owned experiences."
    >
      <PageCard>
        <div className="grid gap-4 lg:grid-cols-3">
          <select
            value={filters.experienceId}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                experienceId: event.target.value,
              }))
            }
            className="flex h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
          >
            <option value="">All experiences</option>
            {data?.experiences.map((experience) => (
              <option key={experience.id} value={experience.id}>
                {experience.title}
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
            <MetricCard label="Views" value={data.totals.views} />
            <MetricCard label="Lesson starts" value={data.totals.lessonStarts} />
            <MetricCard
              label="Lesson completions"
              value={data.totals.lessonCompletions}
            />
            <MetricCard label="Questions" value={data.totals.questions} />
            <MetricCard
              label="Completed lessons"
              value={data.totals.completedLessonsFromProgress}
            />
          </div>

          <PageCard>
            <h2 className="text-xl font-semibold">By experience</h2>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="text-white/55">
                  <tr>
                    <th className="pb-3">Experience</th>
                    <th className="pb-3">Views</th>
                    <th className="pb-3">Starts</th>
                    <th className="pb-3">Completions</th>
                    <th className="pb-3">Questions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {data.byExperience.map((row) => (
                    <tr key={row.id}>
                      <td className="py-3">
                        <div>
                          <p className="font-medium">{row.title}</p>
                          <p className="text-xs text-white/45">/{row.slug}</p>
                        </div>
                      </td>
                      <td className="py-3">{row.views}</td>
                      <td className="py-3">{row.lessonStarts}</td>
                      <td className="py-3">{row.lessonCompletions}</td>
                      <td className="py-3">{row.questions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PageCard>
        </>
      )}

      <CommerceClickSection
        data={commerce}
        error={commerceError}
        isLoading={commerceLoading}
      />

      <ConversionAnalyticsSection
        data={conversion}
        error={conversionError}
        isLoading={conversionLoading}
      />
    </CreatorPageShell>
  );
}

/**
 * Outbound product clicks for the Experiences this creator owns.
 *
 * Every number below is a CLICK COUNT, because SQRATCH has no visibility past
 * the merchant handoff. The one-line note rendered at the bottom comes from the
 * API and is the single place that spells out what is not measured.
 */
function CommerceClickSection({
  data,
  error,
  isLoading,
}: {
  data: CommerceAnalyticsResponse | null;
  error: string | null;
  isLoading: boolean;
}) {
  if (error) {
    return (
      <PageCard>
        <h2 className="text-xl font-semibold">Product clicks</h2>
        <p className="mt-3 text-sm text-red-300">{error}</p>
      </PageCard>
    );
  }

  if (isLoading || !data) {
    return (
      <PageCard>
        <h2 className="text-xl font-semibold">Product clicks</h2>
        <p className="mt-3 text-sm text-white/65">
          Loading product click analytics...
        </p>
      </PageCard>
    );
  }

  const surfaceRows = (
    ["BRAND_STOREFRONT", "CAMPAIGN_PRODUCT", "LESSON", "UNKNOWN"] as const
  ).map((bucket) => ({
    bucket,
    label: SURFACE_LABELS[bucket] ?? bucket,
    clicks: data.surfaceBreakdown[bucket],
  }));

  const peakClicks = data.timeSeries.reduce(
    (peak, point) => Math.max(peak, point.clicks),
    0,
  );

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Total product clicks" value={data.totals.clicks} />
        <MetricCard
          label="Unique clicking sessions"
          value={data.totals.uniqueSessions.value}
          hint={data.totals.uniqueSessions.truncated ? "at least" : undefined}
        />
        <MetricCard
          label="Logged-in users who clicked"
          value={data.totals.uniqueUsers.value}
          hint={data.totals.uniqueUsers.truncated ? "at least" : undefined}
        />
        {/* "Entry" is how the visitor ARRIVED. It is never the campaign that
            authorized the product they clicked, so it is never labelled with a
            bare "Campaign". */}
        <MetricCard
          label="Campaign-entry clicks"
          value={data.totals.campaignEntryClicks}
        />
        <MetricCard
          label="Direct-entry clicks"
          value={data.totals.directEntryClicks}
        />
      </div>

      <PageCard>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-semibold">Product clicks per day</h2>
          <p className="text-xs text-white/45">
            {data.range.start.slice(0, 10)} to {data.range.end.slice(0, 10)} (UTC)
          </p>
        </div>

        {/* The timestamp sample is read OLDEST-FIRST, so truncation drops the
            LATEST days rather than thinning every day evenly. Saying only "at
            least" would let a creator read the trailing zeroes as a collapse in
            traffic, so the shape of the gap is named explicitly. */}
        {data.timeSeriesTruncated && (
          <p className="mt-3 text-xs text-amber-300">
            This series is incomplete: the click sample hit its ceiling, so only
            the earliest clicks in this range are charted. Later days can show 0
            here while still being counted in the total above.
          </p>
        )}

        {peakClicks === 0 ? (
          <p className="mt-4 text-sm text-white/65">
            No product clicks recorded in this range.
          </p>
        ) : (
          <div className="mt-5 flex h-32 items-end gap-1 overflow-x-auto">
            {data.timeSeries.map((point) => (
              <div
                key={point.date}
                title={`${point.date}: ${point.clicks} clicks`}
                className="flex min-w-[6px] flex-1 flex-col justify-end"
              >
                <div
                  className="rounded-t bg-white/45"
                  style={{
                    height: `${Math.round((point.clicks / peakClicks) * 100)}%`,
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </PageCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <PageCard>
          <h2 className="text-xl font-semibold">Clicks by surface</h2>
          <p className="mt-1 text-xs text-white/45">
            &quot;Unknown&quot; covers clicks recorded before the surface was
            captured; it is never guessed.
          </p>
          <ul className="mt-4 space-y-2 text-sm">
            {surfaceRows.map((row) => (
              <li key={row.bucket} className="flex justify-between gap-4">
                <span className="text-white/70">{row.label}</span>
                <span className="font-medium">{row.clicks}</span>
              </li>
            ))}
          </ul>
        </PageCard>

        <PageCard>
          <h2 className="text-xl font-semibold">Clicks by provider</h2>
          {data.providerBreakdown.length === 0 ? (
            <p className="mt-4 text-sm text-white/65">No clicks in this range.</p>
          ) : (
            <ul className="mt-4 space-y-2 text-sm">
              {data.providerBreakdown.map((row) => (
                <li key={row.provider} className="flex justify-between gap-4">
                  <span className="text-white/70">{row.provider}</span>
                  <span className="font-medium">{row.clicks}</span>
                </li>
              ))}
            </ul>
          )}
        </PageCard>
      </div>

      <ClickRankCard
        title="Top products by clicks"
        rows={data.topProducts.map((row) => ({
          id: row.id,
          label: row.name,
          clicks: row.clicks,
        }))}
      />

      <ClickRankCard
        title="Top lessons by clicks"
        rows={data.topLessons.map((row) => ({
          id: row.id,
          label: row.title,
          clicks: row.clicks,
        }))}
      />

      {data.topExperiences && (
        <ClickRankCard
          title="Clicks by experience"
          rows={data.topExperiences.map((row) => ({
            id: row.id,
            label: row.title,
            clicks: row.clicks,
          }))}
        />
      )}

      <PageCard>
        <p className="text-xs text-white/45">{data.note}</p>
      </PageCard>
    </>
  );
}

/**
 * Attributed conversions & revenue — PHASE 24.
 *
 * A separate measurement from product clicks above, for the same reason the
 * Brand-side sibling section names explicitly: a click is evidence a visitor
 * was sent to a merchant page, while every figure below requires a
 * persisted `CommerceOrder` with EXACT SQRATCH attribution. Click analytics
 * are scoped by CLICK time and conversion analytics by ORDER time, so no
 * "attributed orders / clicks" conversion-rate percentage is computed or
 * shown anywhere in this file — dividing the two would put an invalid
 * denominator behind an attractive-looking number.
 *
 * PRIVACY BOUNDARY (see the conversions route's own header): no campaign id
 * or name of any kind is ever rendered here — a creator's Experience can be
 * commerce-sponsored, and the sponsoring brand's campaigns are the brand's
 * private inventory, not the creator's. The server-side breakdown is always
 * empty for both campaign dimensions, and this component has no UI section
 * for them at all, so an empty array can never be mistaken for "0 campaign
 * performance."
 *
 * "Orders ingested" is deliberately NOT shown as its own card: the
 * conversions route only ever selects orders already scoped to THIS
 * creator's own attribution (`attribution.creatorProfileId`), so every
 * order in scope is already attributed by construction — the two counts are
 * always equal, and showing both would misleadingly imply the creator can
 * see a merchant's full, unattributed order volume.
 */
const CREATOR_CONVERSION_COUNT_CARDS: Array<{
  key:
    | "attributedOrders"
    | "currentlyNetPositivePaidOrders"
    | "pendingOrAuthorizedOrders"
    | "partiallyRefundedOrders"
    | "fullyRefundedOrders";
  label: string;
  subtext: string;
}> = [
  {
    key: "attributedOrders",
    label: "Attributed orders",
    subtext: "Orders matched to an exact SQRATCH commerce click you drove.",
  },
  {
    key: "currentlyNetPositivePaidOrders",
    label: "Current paid conversions",
    subtext:
      "Attributed orders that currently retain positive net revenue. Evidence of attribution, not a claim that you caused the sale.",
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
  isLoading,
}: {
  data: CreatorConversionAnalytics | null;
  error: string | null;
  isLoading: boolean;
}) {
  if (error) {
    return (
      <PageCard>
        <h2 className="text-xl font-semibold">Attributed conversions &amp; revenue</h2>
        <p className="mt-3 text-sm text-red-300">{error}</p>
      </PageCard>
    );
  }

  if (isLoading || !data) {
    return (
      <PageCard>
        <h2 className="text-xl font-semibold">Attributed conversions &amp; revenue</h2>
        <p className="mt-3 text-sm text-white/65">Loading conversion analytics...</p>
      </PageCard>
    );
  }

  const noOrders = data.attributedOrders === 0;

  return (
    <>
      <PageCard>
        <h2 className="text-xl font-semibold">Attributed conversions &amp; revenue</h2>
        <p className="mt-2 text-sm text-white/65">
          Orders and revenue for {data.range.start.slice(0, 10)} to{" "}
          {data.range.end.slice(0, 10)}, counted only when SQRATCH has exact
          attribution evidence linking an order to your click.
          {data.filters.experienceId
            ? " Filtered to the selected experience."
            : " Across all your experiences."}
        </p>
      </PageCard>

      {noOrders ? (
        <PageCard>
          <p className="text-sm text-white/65">
            No attributed orders in this range. This can also mean orders exist for
            the merchant but none have exact SQRATCH attribution yet.
          </p>
        </PageCard>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {CREATOR_CONVERSION_COUNT_CARDS.map((card) => (
              <ConversionMetricCard
                key={card.key}
                label={card.label}
                subtext={card.subtext}
                value={data[card.key]}
              />
            ))}
          </div>

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

            {!data.filters.experienceId && (
              <PageCard>
                <h3 className="text-lg font-semibold">By Experience</h3>
                <NamedBreakdownTable
                  columnLabel="Experience"
                  rows={data.attributedOrdersByExperience}
                  emptyLabel="No attributed orders in this range."
                />
              </PageCard>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <PageCard>
              <h3 className="text-lg font-semibold">By Lesson</h3>
              <NamedBreakdownTable
                columnLabel="Lesson"
                rows={data.attributedOrdersByLesson}
                emptyLabel="No attributed orders in this range."
              />
            </PageCard>

            <PageCard>
              <h3 className="text-lg font-semibold">By promoted product</h3>
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

/** See the Brand-side sibling of the same name — identical rendering contract. */
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

function ClickRankCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ id: string; label: string | null; clicks: number }>;
}) {
  return (
    <PageCard>
      <h2 className="text-xl font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-white/65">No clicks in this range.</p>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead className="text-white/55">
              <tr>
                <th className="pb-3">Name</th>
                <th className="pb-3">Clicks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="py-3">{row.label ?? "Unavailable"}</td>
                  <td className="py-3">{row.clicks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageCard>
  );
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  /**
   * Optional qualifier rendered before the number. Used for bounded counts,
   * where the value is a LOWER bound ("at least 100000") because the distinct
   * sample hit its ceiling and must not be shown as an exact figure.
   */
  hint?: string;
}) {
  return (
    <PageCard>
      <p className="text-sm text-white/55">{label}</p>
      <p className="mt-2 text-4xl font-semibold">
        {hint && <span className="mr-1 text-base text-white/55">{hint}</span>}
        {value}
      </p>
    </PageCard>
  );
}
