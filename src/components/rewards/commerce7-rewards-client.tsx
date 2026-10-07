"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { formatRewardMoney } from "@/lib/reward-formatting";
type Offer = { claimStartsAt?: string | null; unavailableReason?: string | null; productTitles?: string[]; storefrontUrl?: string | null; id: string; title: string; description: string | null; brandName: string; pointsCost: number; discountType: string; discountAmountCents: number | null; discountPercentageBasisPoints: number | null; currencyCode: string; minimumSubtotalCents: number | null; codeValidDays: number; claimEndsAt: string | null; remaining: number; claimable: boolean };
type Claim = { storefrontUrl?: string | null; id: string; offerId: string; title: string; status: string; provisioningState: string; pointsCost: number; code: string | null; expiresAt: string | null; canRetry: boolean; canCancel: boolean; message: string | null };
const stateLabels: Record<string, string> = {
  AWAITING_CUSTOMER: "Waiting for your Commerce7 account", AWAITING_ELIGIBILITY: "Waiting for store approval",
  PROVISIONING: "Checking your reward", READY: "Ready to use", FAILED_RETRYABLE: "Needs another check",
  MANUAL_REVIEW: "Store review needed", FAILED_FINAL: "Claim closed", REVOKED: "Revoked by the store",
};
type Rewards = { offers: Offer[]; claims: Claim[]; points: number };
export function Commerce7RewardsClient({ experienceSlug, campaignId, showErrors = false }: { experienceSlug?: string; campaignId?: string; showErrors?: boolean }) {
  const contextKey = JSON.stringify([experienceSlug ?? null, campaignId ?? null]);
  const contextRef = useRef(contextKey); contextRef.current = contextKey;
  const [loaded, setLoaded] = useState<{ contextKey: string; value: Rewards } | null>(null);
  const data = loaded?.contextKey === contextKey ? loaded.value : null;
  const requestSequence = useRef(0); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [copied, setCopied] = useState<string | null>(null);
  const running = useRef(false); const keys = useRef(new Map<string, string>()); const router = useRouter();
  const load = useCallback(async () => {
    const query = new URLSearchParams(); if (experienceSlug) query.set("experienceSlug", experienceSlug); if (campaignId) query.set("campaignId", campaignId);
    const sequence = ++requestSequence.current;
    const value = await fetchJson<Rewards>(`/api/rewards/commerce7?${query}`);
    if (contextRef.current === contextKey && sequence === requestSequence.current) setLoaded({ contextKey, value });
  }, [experienceSlug, campaignId, contextKey]);
  const invalidateLoad = useCallback(() => { requestSequence.current++; }, []);
  useEffect(() => { setError(null); void load().catch((error) => { if (showErrors && contextRef.current === contextKey) setError(getErrorMessage(error, "Could not load Commerce7 rewards.")); }); return invalidateLoad; }, [load, showErrors, contextKey, invalidateLoad]);
  async function action(work: () => Promise<unknown>) {
    if (running.current) return; running.current = true; setBusy(true); setError(null);
    try { await work(); await load(); router.refresh(); }
    catch (e) { setError(getErrorMessage(e, "Could not process this reward. You can retry the same request.")); }
    finally { running.current = false; setBusy(false); }
  }
  function completeRequest(result: Claim) {
    if (!["ISSUED", "USED", "EXPIRED", "REFUNDED", "CANCELLED"].includes(result.status)) return;
    keys.current.delete(result.offerId);
    try { sessionStorage.removeItem(`sqratch:c7-claim:${result.offerId}`); } catch {}
  }
  function claim(offerId: string) {
    void action(async () => {
      let key = keys.current.get(offerId);
      if (!key) { try { key = sessionStorage.getItem(`sqratch:c7-claim:${offerId}`) ?? undefined; } catch {} }
      if (!key) key = crypto.randomUUID(); keys.current.set(offerId, key);
      try { sessionStorage.setItem(`sqratch:c7-claim:${offerId}`, key); } catch {}
      const result = await fetchJson<Claim>("/api/rewards/commerce7/claims", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offerId, idempotencyKey: key, experienceSlug, campaignId }) });
      completeRequest(result);
    });
  }
  if (!data) return error ? <p role="alert" className="text-destructive">{error}</p> : null;
  if (!data.offers.length && !data.claims.length) return null;
  return <section className="rounded-2xl border p-5 space-y-4">
    <h2 className="text-xl font-semibold">Commerce7 rewards</h2><p className="text-sm">{data.points} spendable points. Use the same verified email in SQRATCH and Commerce7. Each coupon needs the store to approve your Customer tag before it is ready.</p><p className="text-sm text-muted-foreground">Points are reserved when you claim. You can cancel and recover them before coupon issuance begins. A claim does not purchase wine or reserve inventory.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="grid gap-3 md:grid-cols-2">{data.offers.map((offer) => <article key={offer.id} className="rounded-xl border p-4 space-y-2 break-words"><p className="text-sm text-muted-foreground">{offer.brandName}</p><h3 className="font-semibold">{offer.title}</h3><p>{offer.discountType === "PERCENTAGE" ? `${(offer.discountPercentageBasisPoints ?? 0) / 100}% off` : `${formatRewardMoney(offer.discountAmountCents, offer.currencyCode)} off`}</p>{offer.description && <p className="text-sm">{offer.description}</p>}{!!offer.productTitles?.length && <p className="text-sm">Applies to {offer.productTitles.join(", ")}</p>}<p className="text-sm">{offer.pointsCost} points · {offer.remaining} claims remaining · valid for {offer.codeValidDays} days after claim</p>{offer.minimumSubtotalCents && <p className="text-sm">Minimum subtotal {formatRewardMoney(offer.minimumSubtotalCents, offer.currencyCode)}</p>}{offer.claimStartsAt && <p className="text-sm">Claims open {new Date(offer.claimStartsAt).toLocaleString()}</p>}{!offer.claimable && offer.unavailableReason && <p className="text-sm">{offer.unavailableReason}</p>}{offer.claimEndsAt && <p className="text-sm">Claim by {new Date(offer.claimEndsAt).toLocaleString()}</p>}<Button disabled={busy || !offer.claimable || data.points < offer.pointsCost} onClick={() => claim(offer.id)}>{data.points < offer.pointsCost ? "More points needed" : offer.claimable ? `Claim for ${offer.pointsCost} points` : "Claim unavailable"}</Button></article>)}</div>
    {data.claims.length > 0 && <h3 className="font-semibold">Your Commerce7 claims</h3>}{data.claims.map((reward) => <article key={reward.id} className="rounded-xl border p-4 space-y-2 break-words"><p className="font-medium">{reward.title} · {reward.status === "REFUNDED" ? "Points returned" : reward.status === "USED" ? "Purchase recorded" : reward.status === "EXPIRED" ? "Expired" : stateLabels[reward.provisioningState] ?? reward.status}</p>{reward.message && <p className="text-sm">{reward.message}</p>}{reward.code && <div className="flex flex-wrap gap-2 items-center"><code className="break-all rounded bg-muted p-2 text-sm">{reward.code}</code><Button variant="outline" onClick={() => { void navigator.clipboard.writeText(reward.code!).then(() => setCopied(reward.id)).catch(() => setError("Copy the coupon code shown above.")); }}>{copied === reward.id ? "Copied" : "Copy coupon"}</Button></div>}{reward.code && <p className="text-sm">Log in with your verified SQRATCH email and enter the coupon at Commerce7 checkout. {reward.storefrontUrl && <a className="underline" href={reward.storefrontUrl} target="_blank" rel="noopener noreferrer">Open the store</a>}</p>}{reward.expiresAt && <p className="text-sm">Expires {new Date(reward.expiresAt).toLocaleString()}</p>}<div className="flex flex-wrap gap-2">{reward.canRetry && <Button variant="outline" disabled={busy} onClick={() => void action(async () => completeRequest(await fetchJson<Claim>(`/api/rewards/commerce7/claims/${reward.id}`, { method: "POST" })))}>Check eligibility / retry</Button>}{reward.canCancel && <Button variant="outline" disabled={busy} onClick={() => void action(async () => completeRequest(await fetchJson<Claim>(`/api/rewards/commerce7/claims/${reward.id}`, { method: "DELETE" })))}>Cancel and return points</Button>}</div></article>)}
  </section>;
}
