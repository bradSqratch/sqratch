"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { formatRewardMoney } from "@/lib/reward-formatting";
import { buildLoginPathWithCallback } from "@/lib/safe-redirect";
type Offer = { rewardMode?: "DISCOUNT" | "EXCLUSIVE_PRODUCT_ACCESS"; accessOnly?: boolean; eligibilityMode?: "ANYONE_WITH_CODE" | "CLAIMANT_ONLY"; claimStartsAt?: string | null; unavailableReason?: string | null; productTitles?: string[]; storefrontUrl?: string | null; id: string; title: string; description: string | null; brandName: string; pointsCost: number; discountType: string; discountAmountCents: number | null; discountPercentageBasisPoints: number | null; currencyCode: string; minimumSubtotalCents: number | null; codeValidDays: number; claimEndsAt: string | null; remaining: number; claimable: boolean };
type AccessState = "ACCESS_GRANTED" | "ALREADY_ELIGIBLE" | "WAITING_FOR_CUSTOMER" | "CONFIRMATION_PENDING" | "PROCESSING" | "MANUAL_REVIEW" | "FAILED";
type Claim = { rewardMode?: "DISCOUNT" | "EXCLUSIVE_PRODUCT_ACCESS"; accessState?: AccessState | null; accessGranted?: boolean; eligibilityMode?: "ANYONE_WITH_CODE" | "CLAIMANT_ONLY"; storefrontUrl?: string | null; id: string; offerId: string; title: string; status: string; provisioningState: string; pointsCost: number; code: string | null; expiresAt: string | null; canRetry: boolean; canCancel: boolean; message: string | null };
const stateLabels: Record<string, string> = {
  AWAITING_CUSTOMER: "Waiting for your Commerce7 account", AWAITING_ELIGIBILITY: "Waiting for store approval",
  PROVISIONING: "Checking your reward", READY: "Ready to use", FAILED_RETRYABLE: "Needs another check",
  MANUAL_REVIEW: "Store review needed", FAILED_FINAL: "Claim closed", REVOKED: "Revoked by the store",
};
/** Exclusive Wine Access states: Commerce7 storefront access, never a purchase or an inventory hold. */
const accessLabels: Record<AccessState, string> = {
  ACCESS_GRANTED: "Access granted", ALREADY_ELIGIBLE: "Already eligible: no points spent", WAITING_FOR_CUSTOMER: "Waiting for your Commerce7 account",
  CONFIRMATION_PENDING: "Waiting for Commerce7 to confirm your access", PROCESSING: "Checking your access", MANUAL_REVIEW: "Store review needed", FAILED: "Claim closed",
};
const accessHelp: Partial<Record<AccessState, string>> = {
  ACCESS_GRANTED: "Log in to the Commerce7 store with your verified SQRATCH email to see and buy this wine online.",
  WAITING_FOR_CUSTOMER: "Create or log in to a Commerce7 account with your verified SQRATCH email, then check again. You can cancel to get your points back.",
  CONFIRMATION_PENDING: "Commerce7 accepted the request. Check again shortly; your access will not be requested twice.",
};
/** SIGNED_OUT and LOCKED carry no private data. A response without a marker predates viewer states and is READY. */
/** How long the "Copied" feedback stays before the button reads "Copy coupon" again. */
const COPY_FEEDBACK_MS = 2000;
type Rewards = { viewerState?: "SIGNED_OUT" | "LOCKED" | "READY"; offers: Offer[]; claims: Claim[]; points: number | null };
/** The claim endpoint's no-charge outcome: the customer already holds the access in Commerce7, so no claim was created. */
type AlreadyEligible = { alreadyEligible: true; offerId: string; message: string };
export function Commerce7RewardsClient({ experienceSlug, campaignId, showErrors = false }: { experienceSlug?: string; campaignId?: string; showErrors?: boolean }) {
  const contextKey = JSON.stringify([experienceSlug ?? null, campaignId ?? null]);
  const contextRef = useRef(contextKey); contextRef.current = contextKey;
  const [loaded, setLoaded] = useState<{ contextKey: string; value: Rewards } | null>(null);
  const data = loaded?.contextKey === contextKey ? loaded.value : null;
  const requestSequence = useRef(0); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [copied, setCopied] = useState<string | null>(null);
  const running = useRef(false); const keys = useRef(new Map<string, string>()); const router = useRouter();
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null); const mounted = useRef(true);
  // The Copied feedback lasts two seconds; a pending reset never outlives the card.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (copyTimer.current) clearTimeout(copyTimer.current); copyTimer.current = null; }; }, []);
  function copyCode(claimId: string, value: string) {
    const write = typeof navigator !== "undefined" && navigator.clipboard?.writeText ? navigator.clipboard.writeText(value) : Promise.reject(new Error("Clipboard unavailable"));
    void write.then(() => {
      if (!mounted.current) return;
      if (copyTimer.current) clearTimeout(copyTimer.current);
      setCopyFailed(null); setCopied(claimId);
      copyTimer.current = setTimeout(() => { copyTimer.current = null; if (mounted.current) setCopied(null); }, COPY_FEEDBACK_MS);
    }).catch(() => {
      if (!mounted.current) return;
      if (copyTimer.current) { clearTimeout(copyTimer.current); copyTimer.current = null; }
      setCopied(null); setCopyFailed(claimId);
    });
  }
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
    try { await work(); if (contextRef.current === contextKey) { await load(); router.refresh(); } }
    catch (e) { if (contextRef.current === contextKey) setError(getErrorMessage(e, "Could not process this reward. You can retry the same request.")); }
    finally { running.current = false; setBusy(false); }
  }
  function completeRequest(result: Claim | AlreadyEligible) {
    if ("alreadyEligible" in result) { setNotices((current) => ({ ...current, [result.offerId]: result.message })); }
    else if (!["ISSUED", "USED", "EXPIRED", "REFUNDED", "CANCELLED"].includes(result.status)) return;
    keys.current.delete(result.offerId);
    try { sessionStorage.removeItem(`sqratch:c7-claim:${result.offerId}`); } catch {}
  }
  function claim(offerId: string) {
    void action(async () => {
      let key = keys.current.get(offerId);
      if (!key) { try { key = sessionStorage.getItem(`sqratch:c7-claim:${offerId}`) ?? undefined; } catch {} }
      if (!key) key = crypto.randomUUID(); keys.current.set(offerId, key);
      try { sessionStorage.setItem(`sqratch:c7-claim:${offerId}`, key); } catch {}
      const result = await fetchJson<Claim | AlreadyEligible>("/api/rewards/commerce7/claims", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offerId, idempotencyKey: key, experienceSlug, campaignId }) });
      completeRequest(result);
    });
  }
  if (!data) return error ? <p role="alert" className="text-destructive">{error}</p> : null;
  if (data.viewerState === "SIGNED_OUT" || data.viewerState === "LOCKED") {
    // Return to exactly this page after login. The path is read when clicked and re-validated as an internal path.
    const login = () => router.push(buildLoginPathWithCallback(`${window.location.pathname}${window.location.search}`));
    return <section className="rounded-2xl border p-5 space-y-3"><h2 className="text-xl font-semibold">Commerce7 rewards</h2>{data.viewerState === "SIGNED_OUT" ? <><p className="text-sm">Sign in to view the rewards available for this experience.</p><Button onClick={login}>Log in</Button></> : <p className="text-sm">You have not unlocked this campaign yet. Scan and unlock this campaign to view its rewards.</p>}</section>;
  }
  if (!data.offers.length && !data.claims.length) return null;
  const points = data.points ?? 0; // READY always carries a number; SIGNED_OUT/LOCKED returned above.
  const hasExclusive = data.offers.some((offer) => offer.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS");
  return <section className="rounded-2xl border p-5 space-y-4">
    <h2 className="text-xl font-semibold">Commerce7 rewards</h2><p className="text-sm">{points} spendable points. {hasExclusive ? "Rewards provide a unique, single-use coupon or access in the store's Commerce7 online shop." : "Each reward provides a unique, single-use coupon."}</p><p className="text-sm text-muted-foreground">Points are reserved when you claim. You can cancel and recover them before coupon issuance or access begins. A claim does not purchase wine or reserve inventory.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="grid gap-3 md:grid-cols-2">{data.offers.map((offer) => <article key={offer.id} className="rounded-xl border p-4 space-y-2 break-words"><p className="text-sm text-muted-foreground">{offer.brandName}</p><h3 className="font-semibold">{offer.title}</h3>{offer.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS" ? <><p>Exclusive access{offer.productTitles?.length ? `: ${offer.productTitles.join(", ")}` : ""}</p><p className="text-sm">Access is added to your Commerce7 customer account with the same verified email you use in SQRATCH. Log in to the store&apos;s Commerce7 online shop to buy. If your account already has this access, no points are spent.</p>{!offer.accessOnly && <p className="text-sm">Also includes a single-use {offer.discountType === "PERCENTAGE" ? `${(offer.discountPercentageBasisPoints ?? 0) / 100}%` : formatRewardMoney(offer.discountAmountCents, offer.currencyCode)} off code for this wine. Keep it private; it is not needed to buy the wine.</p>}</> : <><p>{offer.discountType === "PERCENTAGE" ? `${(offer.discountPercentageBasisPoints ?? 0) / 100}% off` : `${formatRewardMoney(offer.discountAmountCents, offer.currencyCode)} off`}</p>{offer.eligibilityMode === "ANYONE_WITH_CODE" ? <p className="text-sm">Anyone with the code can redeem it once. No matching Commerce7 email or store approval is required.</p> : <p className="text-sm">Use the same verified email in SQRATCH and Commerce7. The store must approve your Customer tag before issuance.</p>}</>}{notices[offer.id] && <p className="text-sm" role="status">{notices[offer.id]}</p>}{offer.description && <p className="text-sm">{offer.description}</p>}{!!offer.productTitles?.length && offer.rewardMode !== "EXCLUSIVE_PRODUCT_ACCESS" && <p className="text-sm">Applies to {offer.productTitles.join(", ")}</p>}<p className="text-sm">{offer.pointsCost} points · {offer.remaining} claims remaining{offer.accessOnly ? "" : ` · valid for ${offer.codeValidDays} days after claim`}</p>{offer.minimumSubtotalCents && !offer.accessOnly && <p className="text-sm">Minimum subtotal {formatRewardMoney(offer.minimumSubtotalCents, offer.currencyCode)}</p>}{offer.claimStartsAt && <p className="text-sm">Claims open {new Date(offer.claimStartsAt).toLocaleString()}</p>}{!offer.claimable && offer.unavailableReason && <p className="text-sm">{offer.unavailableReason}</p>}{offer.claimEndsAt && <p className="text-sm">Claim by {new Date(offer.claimEndsAt).toLocaleString()}</p>}<Button disabled={busy || !offer.claimable || points < offer.pointsCost} onClick={() => claim(offer.id)}>{points < offer.pointsCost ? "More points needed" : offer.claimable ? `${offer.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS" ? "Claim access" : "Claim"} for ${offer.pointsCost} points` : "Claim unavailable"}</Button></article>)}</div>
    {data.claims.length > 0 && <h3 className="font-semibold">Your Commerce7 claims</h3>}{data.claims.map((reward) => <article key={reward.id} className="rounded-xl border p-4 space-y-2 break-words"><p className="font-medium">{reward.title} · {reward.accessState ? accessLabels[reward.accessState] : reward.status === "REFUNDED" ? "Points returned" : reward.status === "USED" ? "Coupon used" : reward.status === "EXPIRED" ? "Expired" : stateLabels[reward.provisioningState] ?? reward.status}</p>{reward.accessState && accessHelp[reward.accessState] && <p className="text-sm">{accessHelp[reward.accessState]}</p>}{reward.accessState && reward.accessState !== "ACCESS_GRANTED" && reward.accessGranted && <p className="text-sm">Your Commerce7 access is active.</p>}{reward.message && <p className="text-sm">{reward.message}</p>}{reward.code && <div className="flex flex-wrap gap-2 items-center"><code className="break-all rounded bg-muted p-2 text-sm">{reward.code}</code><Button variant="outline" aria-describedby={`copy-status-${reward.id}`} onClick={() => copyCode(reward.id, reward.code!)}>{copied === reward.id ? "Copied" : "Copy coupon"}</Button><span id={`copy-status-${reward.id}`} role="status" aria-live="polite" className="sr-only">{copied === reward.id ? "Coupon code copied" : ""}</span></div>}{reward.code && copyFailed === reward.id && <p className="text-sm text-destructive" role="alert">Could not copy automatically. Select the code above and copy it manually.</p>}{reward.status === "USED" && <p className="text-sm">This single-use code has been redeemed at the store.</p>}{reward.code && <p className="text-sm">{reward.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS" ? "Single-use discount for this wine. Enter it at Commerce7 checkout while logged in; keep it private." : reward.eligibilityMode === "ANYONE_WITH_CODE" ? "Enter this single-use coupon at Commerce7 checkout. Anyone with the code can redeem it." : "Log in with your verified SQRATCH email and enter the coupon at Commerce7 checkout."} {reward.storefrontUrl && <a className="underline" href={reward.storefrontUrl} target="_blank" rel="noopener noreferrer">Open the store</a>}</p>}{reward.expiresAt && <p className="text-sm">Expires {new Date(reward.expiresAt).toLocaleString()}</p>}<div className="flex flex-wrap gap-2">{reward.canRetry && <Button variant="outline" disabled={busy} onClick={() => void action(async () => completeRequest(await fetchJson<Claim>(`/api/rewards/commerce7/claims/${reward.id}`, { method: "POST" })))}>Check reward / retry</Button>}{reward.canCancel && <Button variant="outline" disabled={busy} onClick={() => void action(async () => completeRequest(await fetchJson<Claim>(`/api/rewards/commerce7/claims/${reward.id}`, { method: "DELETE" })))}>Cancel and return points</Button>}</div></article>)}
  </section>;
}
