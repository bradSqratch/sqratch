import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  readTransferStatus,
  requestAnonymousTransfer,
  TRANSFER_REQUEST_TIMEOUT_MS,
  withTransferPending,
  withoutTransferPending,
} from "../src/lib/anonymous-transfer-client";

const json = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("transfer status reads both response shapes and defaults to retry_required", () => {
  assert.equal(readTransferStatus({ data: { status: "complete" } }), "complete");
  assert.equal(readTransferStatus({ transfer: { status: "complete" } }), "complete");
  assert.equal(readTransferStatus({ data: { status: "retry_required" } }), "retry_required");
  assert.equal(readTransferStatus({ data: {} }), "retry_required");
  assert.equal(readTransferStatus(null), "retry_required");
});

test("requestAnonymousTransfer never throws and distinguishes complete from incomplete", async () => {
  assert.equal(await requestAnonymousTransfer(json({ data: { status: "complete" } })), "complete");
  assert.equal(await requestAnonymousTransfer(json({ data: { status: "retry_required" } })), "retry_required");
  assert.equal(await requestAnonymousTransfer(json({ error: "x" }, 500)), "retry_required");
  assert.equal(await requestAnonymousTransfer(json({ error: "Unauthorized." }, 401)), "retry_required");
  assert.equal(await requestAnonymousTransfer((async () => { throw new TypeError("network"); }) as unknown as typeof fetch), "retry_required");
  assert.equal(await requestAnonymousTransfer((async () => new Response("not json", { status: 200 })) as unknown as typeof fetch), "retry_required");
});

test("the pending flag keeps the destination path, query and hash", () => {
  assert.equal(withTransferPending("/dashboard"), "/dashboard?transfer=pending");
  assert.equal(withTransferPending("/x/demo?tab=learn#top"), "/x/demo?tab=learn&transfer=pending#top");
  assert.equal(withTransferPending("/x/demo?transfer=pending"), "/x/demo?transfer=pending");
  assert.equal(withoutTransferPending("/x/demo?tab=learn&transfer=pending#top"), "/x/demo?tab=learn#top");
  assert.equal(withoutTransferPending("/dashboard?transfer=pending"), "/dashboard");
  assert.equal(withoutTransferPending("/dashboard"), "/dashboard");
});

test("sign-in no longer waits on a timer and reports transfer separately from authentication", () => {
  const login = readFileSync("src/app/(auth)/login/page.tsx", "utf8");
  assert.doesNotMatch(login, /setTimeout\(\(\) => \{\s*router\.push/);
  assert.doesNotMatch(login, /,\s*600\s*\)/);
  assert.match(login, /requestAnonymousTransfer\(\)/);
  assert.match(login, /transferStatus === "complete" \? nextPath : withTransferPending\(nextPath\)/);
  // The approval-pending and email-verification branches stay ahead of the transfer.
  assert.ok(login.indexOf("isEmailVerified") < login.indexOf("requestAnonymousTransfer()"));
});

test("verification never reports a spent code as a failure when only the transfer is pending", () => {
  const page = readFileSync("src/app/(auth)/verify-email/page.tsx", "utf8");
  assert.match(page, /transfer\?\.status === "retry_required"/);
  const notice = readFileSync("src/components/auth/transfer-pending-notice.tsx", "utf8");
  assert.match(notice, /inFlight\.current/);
  assert.match(notice, /disabled=\{state === "retrying"\}/);
  // One notice in the shared sidebar layout covers the dashboard and every page under it; experience pages have their own shell.
  assert.match(readFileSync("src/app/(withSidebar)/layout.tsx", "utf8"), /<TransferPendingNotice/);
  assert.doesNotMatch(readFileSync("src/app/(withSidebar)/dashboard/page.tsx", "utf8"), /TransferPendingNotice/);
  assert.match(readFileSync("src/components/experience/experience-shell.tsx", "utf8"), /<TransferPendingNotice/);
});

test("the merge request has a bounded wait so sign-in can never hang on it", async () => {
  let seenSignal: AbortSignal | undefined;
  const fetchStub = (async (_url: string, init?: RequestInit) => {
    seenSignal = init?.signal ?? undefined;
    return new Response(JSON.stringify({ data: { status: "complete" } }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await requestAnonymousTransfer(fetchStub), "complete");
  assert.ok(seenSignal, "a timeout signal is attached");
  assert.equal(TRANSFER_REQUEST_TIMEOUT_MS, 8000);
});
