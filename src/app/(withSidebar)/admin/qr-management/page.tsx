"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import axios from "axios";
import { debounce } from "lodash";
import { cn } from "@/lib/utils";
import { Check, ChevronsUpDown, Trash } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";
import Papa from "papaparse";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

type QRCode = {
  id: string;
  campaignId: string;
  campaignName: string;
  code: string;
  status: "used" | "unused" | "NEW" | "REDEEMED";
  usedBy?: string;
  usedAt?: string;
  imageUrl: string;
  email?: string;
};

type Campaign = {
  id: string;
  name: string;
};

export default function QRManagementPage() {
  const searchParams = useSearchParams();

  // page data
  const [qrCodes, setQrCodes] = useState<QRCode[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  // pagination state
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(100);

  // filters & dialogs
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>("all");
  const [editOpen, setEditOpen] = useState(false);
  const [selectedQRCode, setSelectedQRCode] = useState<QRCode | null>(null);

  // selection state for bulk operations
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteLoading, setBulkDeleteLoading] = useState(false);

  // user-search combobox
  const [userOptions, setUserOptions] = useState<string[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [userSearchLoading, setUserSearchLoading] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);

  const campaignParam = searchParams.get("campaignId");
  useEffect(() => {
    setSelectedCampaignId(campaignParam || "all");
  }, [campaignParam]);

  // initial fetch
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [qrRes, campaignsRes] = await Promise.all([
          axios.get<{ data: QRCode[] }>("/api/qr/get-all-qrcodes"),
          axios.get<{ data: Campaign[] }>("/api/admin/get-all-campaigns"),
        ]);
        setQrCodes(qrRes.data.data);
        setCampaigns(campaignsRes.data.data);
        // Default selection: if no campaignId in URL, select the first campaign (not 'All') when available
        if (!campaignParam && campaignsRes.data.data.length > 0) {
          setSelectedCampaignId(campaignsRes.data.data[0].id);
        }
      } catch {
        toast.error("Failed to fetch data");
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const exportFilteredQRCodes = () => {
    const exportData = filteredQRCodes.map((qr) => ({
      Code: qr.code,
      Campaign: qr.campaignName,
      Status: qr.status,
      UsedBy: qr.usedBy || "",
      UsedAt: qr.usedAt ? new Date(qr.usedAt).toLocaleString() : "",
      ImageURL: qr.imageUrl,
    }));

    const csv = Papa.unparse(exportData);

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    const filename =
      selectedCampaignId === "all"
        ? "all_qrcodes.csv"
        : `campaign_${selectedCampaignId}_qrcodes.csv`;

    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // fetch user emails
  const fetchUserEmails = async (query: string) => {
    setUserSearchLoading(true);
    try {
      const res = await axios.get<{ data: string[] }>(
        `/api/admin/user-management/get-user-emails?query=${encodeURIComponent(
          query
        )}`
      );
      setUserOptions(res.data.data);
    } catch {
      setUserOptions([]);
    }
    setUserSearchLoading(false);
  };
  const debouncedFetch = useCallback(
    debounce((q: string) => fetchUserEmails(q), 300),
    []
  );

  // filtered list
  const filteredQRCodes = useMemo(() => {
    const data =
      selectedCampaignId === "all"
        ? qrCodes
        : qrCodes.filter((q) => q.campaignId === selectedCampaignId);
    return data;
  }, [qrCodes, selectedCampaignId]);

  // derived: paged data
  const total = filteredQRCodes.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedQRCodes = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredQRCodes.slice(start, start + pageSize);
  }, [filteredQRCodes, currentPage, pageSize]);

  // reset to page 1 when filters/pageSize change
  useEffect(() => {
    setPage(1);
  }, [selectedCampaignId, pageSize]);

  // Selection helpers
  const allFilteredSelected =
    filteredQRCodes.length > 0 &&
    filteredQRCodes.every((q) => selectedIds.has(q.id));
  const someFilteredSelected = filteredQRCodes.some((q) =>
    selectedIds.has(q.id)
  );

  const toggleSelectAllFiltered = (checked: boolean | "indeterminate") => {
    const next = new Set(selectedIds);
    if (checked) {
      filteredQRCodes.forEach((q) => next.add(q.id));
    } else {
      filteredQRCodes.forEach((q) => next.delete(q.id));
    }
    setSelectedIds(next);
  };

  const toggleRow = (id: string, checked: boolean | "indeterminate") => {
    const next = new Set(selectedIds);
    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
    setSelectedIds(next);
  };

  // update and delete handlers
  const handleUpdateQRCode = async () => {
    if (!selectedQRCode) return;

    const isRedeemed = selectedQRCode.status === "REDEEMED";
    if (isRedeemed && !selectedQRCode.usedBy) {
      toast.error("Used By is required when marking as redeemed");
      return;
    }

    const payload: any = {
      campaignId: selectedQRCode.campaignId,
      status: isRedeemed ? "USED" : "NEW",
      usedBy: isRedeemed ? selectedQRCode.usedBy : null,
      usedAt: isRedeemed ? new Date().toISOString() : null,
      email: isRedeemed ? selectedQRCode.usedBy : null,
    };

    try {
      await axios.patch(`/api/qr/update-qrcode/${selectedQRCode.id}`, payload);
      toast.success("QR Code updated");
      setEditOpen(false);
      setSelectedQRCode(null);
      const qrRes = await axios.get<{ data: QRCode[] }>(
        "/api/qr/get-all-qrcodes"
      );
      setQrCodes(qrRes.data.data);
    } catch {
      toast.error("Update failed");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this QR code?")) return;
    try {
      await axios.delete(`/api/qr/delete-qrcode/${id}`);
      toast.success("QR Code deleted");
      const qrRes = await axios.get<{ data: QRCode[] }>(
        "/api/qr/get-all-qrcodes"
      );
      setQrCodes(qrRes.data.data);
      // Clear selection if deleted item was selected
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch {
      toast.error("Delete failed");
    }
  };

  // Handle Bulk Delete
  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) {
      toast.error("No QR codes selected");
      return;
    }

    if (
      !confirm(
        `Are you sure you want to delete ${selectedIds.size} selected QR code(s)?`
      )
    ) {
      return;
    }

    setBulkDeleteLoading(true);

    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          axios.delete(`/api/qr/delete-qrcode/${id}`)
        )
      );
      toast.success(`${selectedIds.size} QR code(s) deleted successfully`);

      // Refresh data and clear selection
      const qrRes = await axios.get<{ data: QRCode[] }>(
        "/api/qr/get-all-qrcodes"
      );
      setQrCodes(qrRes.data.data);
      setSelectedIds(new Set());
    } catch {
      toast.error("Failed to delete selected QR codes");
    } finally {
      setBulkDeleteLoading(false);
    }
  };

  return (
    <div className="min-h-screen p-8">
      {/* Full screen loader overlay */}
      {bulkDeleteLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="flex flex-col items-center space-y-4 rounded-lg bg-white p-6 shadow-xl">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-blue-600"></div>
            <p className="text-lg font-medium text-gray-900">
              Deleting {selectedIds.size} QR code
              {selectedIds.size !== 1 ? "s" : ""}...
            </p>
            <p className="text-sm text-gray-500">Please wait</p>
          </div>
        </div>
      )}

      <Card className="mx-auto max-w-6xl">
        <CardHeader className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <CardTitle>QR Code Management</CardTitle>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
            <div className="flex items-center gap-2">
              <Label htmlFor="campaign-filter">Filter by Campaign:</Label>
              <Select
                value={selectedCampaignId}
                onValueChange={(val) => setSelectedCampaignId(val)}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Select Campaign" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {campaigns.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              onClick={exportFilteredQRCodes}
              className="bg-[#3b639a] text-white"
            >
              Export CSV
            </Button>

            <Button
              onClick={handleBulkDelete}
              variant="destructive"
              disabled={selectedIds.size === 0 || bulkDeleteLoading}
              className="flex items-center gap-2"
            >
              <Trash size={16} />
              {bulkDeleteLoading
                ? "Deleting..."
                : `Delete Selected (${selectedIds.size})`}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="overflow-x-auto">
          {loading ? (
            <div className="text-center py-10 text-gray-500">Loading...</div>
          ) : filteredQRCodes.length === 0 ? (
            <div className="text-center py-10 text-gray-500">
              No QR codes found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={
                        allFilteredSelected
                          ? true
                          : someFilteredSelected
                          ? "indeterminate"
                          : false
                      }
                      onCheckedChange={toggleSelectAllFiltered}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Used By</TableHead>
                  <TableHead>Used At</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedQRCodes.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell>
                      <Checkbox
                        checked={selectedIds.has(q.id)}
                        onCheckedChange={(checked) => toggleRow(q.id, checked)}
                        aria-label={`Select row`}
                      />
                    </TableCell>
                    <TableCell>{q.code}</TableCell>
                    <TableCell>{q.campaignName}</TableCell>
                    <TableCell>{q.status}</TableCell>
                    <TableCell>{q.usedBy || "—"}</TableCell>
                    <TableCell>
                      {q.usedAt ? new Date(q.usedAt).toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="space-x-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          setSelectedQRCode({
                            ...q,
                            status:
                              q.status === "used" || q.status === "REDEEMED"
                                ? "REDEEMED"
                                : "NEW",
                          });
                          setEditOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleDelete(q.id)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination Controls */}
      {!loading && filteredQRCodes.length > 0 && (
        <div className="mx-auto mt-4 flex max-w-6xl items-center justify-between px-2">
          <div className="text-sm text-muted-foreground">
            Showing {(currentPage - 1) * pageSize + 1}–
            {Math.min(currentPage * pageSize, total)} of {total}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Label>Rows:</Label>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => setPageSize(Number(v))}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Rows per page" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="100">100</SelectItem>
                  <SelectItem value="500">500</SelectItem>
                  <SelectItem value="1000">1000</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      setPage((p) => Math.max(1, p - 1));
                    }}
                    className={cn(
                      currentPage === 1 && "pointer-events-none opacity-50"
                    )}
                  />
                </PaginationItem>

                {/* Page numbers: show up to 7 buttons with ellipsis */}
                {(() => {
                  const items: React.ReactNode[] = [];
                  const maxToShow = 7;
                  const createLink = (p: number) => (
                    <PaginationItem key={p}>
                      <PaginationLink
                        href="#"
                        isActive={p === currentPage}
                        onClick={(e) => {
                          e.preventDefault();
                          setPage(p);
                        }}
                      >
                        {p}
                      </PaginationLink>
                    </PaginationItem>
                  );

                  if (totalPages <= maxToShow) {
                    for (let p = 1; p <= totalPages; p++)
                      items.push(createLink(p));
                  } else {
                    const left = Math.max(2, currentPage - 1);
                    const right = Math.min(totalPages - 1, currentPage + 1);
                    items.push(createLink(1));
                    if (left > 2) {
                      items.push(
                        <PaginationItem key="start-ellipsis">
                          <PaginationEllipsis />
                        </PaginationItem>
                      );
                    }
                    for (let p = left; p <= right; p++)
                      items.push(createLink(p));
                    if (right < totalPages - 1) {
                      items.push(
                        <PaginationItem key="end-ellipsis">
                          <PaginationEllipsis />
                        </PaginationItem>
                      );
                    }
                    items.push(createLink(totalPages));
                  }
                  return items;
                })()}

                <PaginationItem>
                  <PaginationNext
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      setPage((p) => Math.min(totalPages, p + 1));
                    }}
                    className={cn(
                      currentPage === totalPages &&
                        "pointer-events-none opacity-50"
                    )}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </div>
      )}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit QR Code</DialogTitle>
            <DialogDescription>Update the QR code details.</DialogDescription>
          </DialogHeader>

          {selectedQRCode && (
            <div className="space-y-3">
              <div className="flex justify-center">
                <img
                  src={selectedQRCode.imageUrl}
                  alt="QR"
                  className="w-40 h-40 object-contain border rounded"
                />
              </div>

              <div>
                <Label>QR Code</Label>
                <Input disabled value={selectedQRCode.code} />
              </div>

              <div>
                <Label>Status</Label>
                <Select
                  value={
                    selectedQRCode.status === "REDEEMED" ||
                    selectedQRCode.status === "used"
                      ? "REDEEMED"
                      : "NEW"
                  }
                  onValueChange={(val) => {
                    setSelectedQRCode((prev) => {
                      if (!prev) return prev;
                      const updated = { ...prev };
                      if (val === "NEW") {
                        updated.status = "NEW";
                        updated.usedBy = "";
                        updated.usedAt = undefined;
                        updated.email = "";
                      } else {
                        updated.status = "REDEEMED";
                      }
                      return updated;
                    });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NEW">NEW</SelectItem>
                    <SelectItem value="REDEEMED">REDEEMED</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Used By</Label>
                {selectedQRCode.status === "REDEEMED" ? (
                  <Popover
                    open={userDropdownOpen}
                    onOpenChange={(open) => {
                      setUserDropdownOpen(open);
                      if (open) fetchUserEmails("");
                    }}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={userDropdownOpen}
                        className="w-full justify-between"
                      >
                        {selectedQRCode.usedBy || "Search or select user"}
                        <ChevronsUpDown className="ml-2 h-4 w-4 opacity-50" />
                      </Button>
                    </PopoverTrigger>

                    <PopoverContent className="w-full p-0">
                      <Command>
                        <CommandInput
                          placeholder="Type to search users..."
                          value={userSearch}
                          onValueChange={(val) => {
                            setUserSearch(val);
                            debouncedFetch(val);
                          }}
                          className="h-9"
                          autoFocus
                        />
                        <CommandEmpty>No users found.</CommandEmpty>
                        <CommandGroup>
                          {userOptions.map((email) => (
                            <CommandItem
                              key={email}
                              value={email}
                              onSelect={(val) => {
                                setSelectedQRCode((prev) =>
                                  prev ? { ...prev, usedBy: val } : prev
                                );
                                setUserSearch("");
                                setUserDropdownOpen(false);
                              }}
                            >
                              {email}
                              <Check
                                className={cn(
                                  "ml-auto",
                                  selectedQRCode.usedBy === email
                                    ? "opacity-100"
                                    : "opacity-0"
                                )}
                              />
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </Command>
                    </PopoverContent>
                  </Popover>
                ) : (
                  <Input disabled placeholder="Not applicable" />
                )}
              </div>

              <div>
                <Label>Used At</Label>
                <Input
                  disabled
                  value={
                    selectedQRCode.usedAt
                      ? new Date(selectedQRCode.usedAt).toLocaleString()
                      : "—"
                  }
                />
              </div>

              <div>
                <Label>Campaign</Label>
                <Select
                  value={selectedQRCode.campaignId}
                  onValueChange={(val) =>
                    setSelectedQRCode((prev) =>
                      prev ? { ...prev, campaignId: val } : prev
                    )
                  }
                >
                  <SelectTrigger className="w-full max-w-full truncate">
                    <SelectValue placeholder="Select Campaign" />
                  </SelectTrigger>
                  <SelectContent className="max-h-60 overflow-auto">
                    {campaigns.map((c) => (
                      <SelectItem key={c.id} value={c.id} title={c.name}>
                        <span className="block max-w-[250px] truncate">
                          {c.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button
                className="w-full"
                onClick={handleUpdateQRCode}
                disabled={!selectedQRCode}
              >
                Save Changes
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
