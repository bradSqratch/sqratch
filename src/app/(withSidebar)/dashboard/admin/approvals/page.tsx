"use client";

import { useEffect, useState } from "react";
import { AdminPageShell } from "@/components/admin/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type ApprovalUser = {
  id: string;
  name: string | null;
  email: string;
  role: "USER" | "CREATOR" | "BRAND_ADMIN" | "ADMIN" | "EXTERNAL";
  isEmailVerified: boolean;
  createdAt: string;
};

type CreatorRequest = {
  id: string;
  status: "PENDING";
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  user: ApprovalUser;
};

type BrandRequest = {
  id: string;
  status: "PENDING";
  reason: string | null;
  proposedBrandName: string | null;
  proposedStoreUrl: string | null;
  createdAt: string;
  updatedAt: string;
  user: ApprovalUser;
};

type ApprovalHistoryItem = {
  id: string;
  requestType: "CREATOR" | "BRAND";
  status: "APPROVED" | "REJECTED";
  createdAt: string;
  updatedAt: string;
  proposedBrandName: string | null;
  reviewedBy: {
    id: string;
    name: string | null;
    email: string;
  } | null;
  user: ApprovalUser;
};

type ApprovalsResponse = {
  creatorRequests: CreatorRequest[];
  brandRequests: BrandRequest[];
  approvalHistory: ApprovalHistoryItem[];
};

function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
}

function getDecisionClasses(status: ApprovalHistoryItem["status"]) {
  return status === "APPROVED"
    ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
    : "border-rose-400/25 bg-rose-400/10 text-rose-200";
}

export default function AdminApprovalsPage() {
  const [data, setData] = useState<ApprovalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processingKey, setProcessingKey] = useState<string | null>(null);

  useEffect(() => {
    void loadApprovals();
  }, []);

  async function loadApprovals() {
    setLoading(true);
    setError(null);

    try {
      const result = await fetchJson<ApprovalsResponse>("/api/admin/approvals");
      setData(result);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load approvals."));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreatorAction(
    requestId: string,
    action: "approve" | "reject",
  ) {
    const key = `creator:${requestId}:${action}`;
    setProcessingKey(key);
    setError(null);

    try {
      await fetchJson(`/api/admin/approvals/creator/${requestId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
      });
      await loadApprovals();
    } catch (requestError) {
      setError(
        getErrorMessage(requestError, "Failed to process creator request."),
      );
    } finally {
      setProcessingKey(null);
    }
  }

  async function handleBrandAction(
    requestId: string,
    action: "approve" | "reject",
  ) {
    const key = `brand:${requestId}:${action}`;
    setProcessingKey(key);
    setError(null);

    try {
      await fetchJson(`/api/admin/approvals/brand/${requestId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
      });
      await loadApprovals();
    } catch (requestError) {
      setError(
        getErrorMessage(requestError, "Failed to process brand request."),
      );
    } finally {
      setProcessingKey(null);
    }
  }

  const creatorCount = data?.creatorRequests.length || 0;
  const brandCount = data?.brandRequests.length || 0;
  const approvalHistory = data?.approvalHistory || [];

  return (
    <AdminPageShell
      title="Approvals"
      description="Review pending creator and brand applications, approve the account role change, and bootstrap the required profile records from one queue."
    >
      {error && (
        <PageCard>
          <p className="text-sm text-red-300">{error}</p>
        </PageCard>
      )}

      {loading ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading approvals...</p>
        </PageCard>
      ) : (
        <div className="space-y-6">
          <Tabs defaultValue="creator" className="space-y-5">
            <TabsList
              variant="line"
              className="rounded-full border border-white/10 bg-white/6 p-1"
            >
              <TabsTrigger
                value="creator"
                className="rounded-full px-5 data-[state=active]:bg-white data-[state=active]:text-black"
              >
                Creator Applications ({creatorCount})
              </TabsTrigger>
              <TabsTrigger
                value="brand"
                className="rounded-full px-5 data-[state=active]:bg-white data-[state=active]:text-black"
              >
                Brand Applications ({brandCount})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="creator" className="space-y-5">
              {creatorCount === 0 ? (
                <PageCard>
                  <p className="text-sm text-white/65">
                    No pending creator applications.
                  </p>
                </PageCard>
              ) : (
                data?.creatorRequests.map((request) => (
                  <PageCard key={request.id}>
                    <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-3">
                          <h2 className="text-2xl font-semibold">
                            {request.user.name || request.user.email}
                          </h2>
                          <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">
                            {request.user.role}
                          </span>
                          <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">
                            {request.user.isEmailVerified
                              ? "Email verified"
                              : "Email pending"}
                          </span>
                        </div>
                        <p className="text-sm text-white/60">
                          {request.user.email}
                        </p>
                        <p className="text-sm text-white/55">
                          Applied {formatDateTime(request.createdAt)}
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-3">
                        <Button
                          type="button"
                          disabled={
                            processingKey === `creator:${request.id}:approve`
                          }
                          onClick={() =>
                            void handleCreatorAction(request.id, "approve")
                          }
                          className="rounded-full border border-white bg-white text-black"
                        >
                          {processingKey === `creator:${request.id}:approve`
                            ? "Approving..."
                            : "Approve"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            processingKey === `creator:${request.id}:reject`
                          }
                          onClick={() =>
                            void handleCreatorAction(request.id, "reject")
                          }
                          className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                        >
                          {processingKey === `creator:${request.id}:reject`
                            ? "Rejecting..."
                            : "Reject"}
                        </Button>
                      </div>
                    </div>
                  </PageCard>
                ))
              )}
            </TabsContent>

            <TabsContent value="brand" className="space-y-5">
              {brandCount === 0 ? (
                <PageCard>
                  <p className="text-sm text-white/65">
                    No pending brand applications.
                  </p>
                </PageCard>
              ) : (
                data?.brandRequests.map((request) => (
                  <PageCard key={request.id}>
                    <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-3">
                          <h2 className="text-2xl font-semibold">
                            {request.proposedBrandName ||
                              request.user.name ||
                              request.user.email}
                          </h2>
                          <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">
                            {request.user.isEmailVerified
                              ? "Email verified"
                              : "Email pending"}
                          </span>
                        </div>
                        <p className="text-sm text-white/60">
                          {request.user.email}
                        </p>
                        {request.proposedStoreUrl && (
                          <p className="text-sm text-white/55">
                            Store URL: {request.proposedStoreUrl}
                          </p>
                        )}
                        <p className="text-sm text-white/55">
                          Applied {formatDateTime(request.createdAt)}
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-3">
                        <Button
                          type="button"
                          disabled={
                            processingKey === `brand:${request.id}:approve`
                          }
                          onClick={() =>
                            void handleBrandAction(request.id, "approve")
                          }
                          className="rounded-full border border-white bg-white text-black"
                        >
                          {processingKey === `brand:${request.id}:approve`
                            ? "Approving..."
                            : "Approve"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            processingKey === `brand:${request.id}:reject`
                          }
                          onClick={() =>
                            void handleBrandAction(request.id, "reject")
                          }
                          className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                        >
                          {processingKey === `brand:${request.id}:reject`
                            ? "Rejecting..."
                            : "Reject"}
                        </Button>
                      </div>
                    </div>
                  </PageCard>
                ))
              )}
            </TabsContent>
          </Tabs>

          <PageCard className="overflow-hidden p-0">
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-5">
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold">Past Approvals</h2>
                <p className="text-sm text-white/60">
                  Processed creator and brand requests, ordered by latest
                  decision.
                </p>
              </div>
              <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/60">
                {approvalHistory.length} total
              </span>
            </div>

            {approvalHistory.length === 0 ? (
              <div className="px-6 py-8">
                <p className="text-sm text-white/65">
                  No approvals have been processed yet.
                </p>
              </div>
            ) : (
              <Table className="min-w-[880px] text-white">
                <TableHeader className="[&_tr]:border-white/10">
                  <TableRow className="border-white/10 hover:bg-transparent">
                    <TableHead className="px-6 py-4 text-xs uppercase tracking-[0.18em] text-white/50">
                      Name
                    </TableHead>
                    <TableHead className="py-4 text-xs uppercase tracking-[0.18em] text-white/50">
                      Email
                    </TableHead>
                    <TableHead className="py-4 text-xs uppercase tracking-[0.18em] text-white/50">
                      Type
                    </TableHead>
                    <TableHead className="py-4 text-xs uppercase tracking-[0.18em] text-white/50">
                      Status
                    </TableHead>
                    <TableHead className="py-4 text-xs uppercase tracking-[0.18em] text-white/50">
                      Role
                    </TableHead>
                    <TableHead className="py-4 text-xs uppercase tracking-[0.18em] text-white/50">
                      Reviewed At
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="[&_tr:last-child]:border-b-0">
                  {approvalHistory.map((item) => (
                    <TableRow
                      key={`${item.requestType}:${item.id}`}
                      className="border-white/10 text-white/88 hover:bg-white/[0.03]"
                    >
                      <TableCell className="px-6 py-4 font-medium text-white">
                        <div className="flex flex-col gap-1">
                          <span>
                            {item.proposedBrandName ||
                              item.user.name ||
                              item.user.email}
                          </span>
                          <span className="text-xs text-white/45">
                            Applied {formatDateTime(item.createdAt)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="py-4 text-white/72">
                        {item.user.email}
                      </TableCell>
                      <TableCell className="py-4 text-white/72">
                        {item.requestType === "CREATOR"
                          ? "Creator"
                          : "Brand"}
                      </TableCell>
                      <TableCell className="py-4">
                        <span
                          className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium ${getDecisionClasses(item.status)}`}
                        >
                          {item.status}
                        </span>
                      </TableCell>
                      <TableCell className="py-4 text-white/72">
                        {item.user.role}
                      </TableCell>
                      <TableCell className="py-4 text-white/72">
                        <div className="flex flex-col gap-1">
                          <span>{formatDateTime(item.updatedAt)}</span>
                          {item.reviewedBy && (
                            <span className="text-xs text-white/45">
                              by{" "}
                              {item.reviewedBy.name || item.reviewedBy.email}
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </PageCard>
        </div>
      )}
    </AdminPageShell>
  );
}
