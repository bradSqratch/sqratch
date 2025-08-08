"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import axios from "axios";
import { debounce } from "lodash";
import { cn } from "@/lib/utils";
import { Check, ChevronsUpDown } from "lucide-react";
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

  // filters & dialogs
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>("all");
  const [editOpen, setEditOpen] = useState(false);
  const [selectedQRCode, setSelectedQRCode] = useState<QRCode | null>(null);

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
      } catch {
        toast.error("Failed to fetch data");
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
  const filteredQRCodes =
    selectedCampaignId === "all"
      ? qrCodes
      : qrCodes.filter((q) => q.campaignId === selectedCampaignId);

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
    } catch {
      toast.error("Delete failed");
    }
  };

  return (
    <div className="min-h-screen p-8">
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
              className="bg-[#0A0E24] text-white hover:bg-[#1c2246]"
            >
              Export CSV
            </Button>
          </div>
        </CardHeader>

        <CardContent className="overflow-x-auto">
          {filteredQRCodes.length === 0 ? (
            <div className="text-center py-10 text-gray-500">
              No QR codes found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Used By</TableHead>
                  <TableHead>Used At</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredQRCodes.map((q) => (
                  <TableRow key={q.id}>
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
