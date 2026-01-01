// app/print-qr/page.tsx
"use client";

import React, { useEffect, useState } from "react";
import axios from "axios";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { CalendarIcon } from "lucide-react";
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
import { format } from "date-fns";
import { toast } from "sonner";
import { DateRange } from "react-day-picker";
import ExcelJS from "exceljs";

interface QRCode {
  id: string;
  code: string;
  campaignId: string;
  campaignName: string;
  imageUrl: string;
  status: string;
  createdAt: string;
  usedAt?: string;
  usedBy?: string;
}

interface DateRangePickerProps {
  dateRange: DateRange | undefined;
  setDateRange: (range: DateRange | undefined) => void;
}

interface Campaign {
  id: string;
  name: string;
}

function DateRangePicker({ dateRange, setDateRange }: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="w-64 justify-start text-left font-normal"
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {dateRange?.from ? (
            dateRange.to ? (
              <>
                {format(dateRange.from, "LLL dd, y")} -{" "}
                {format(dateRange.to, "LLL dd, y")}
              </>
            ) : (
              format(dateRange.from, "LLL dd, y")
            )
          ) : (
            <span>Pick a date range</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          initialFocus
          mode="range"
          defaultMonth={dateRange?.from}
          selected={dateRange}
          onSelect={setDateRange}
          numberOfMonths={2}
        />
      </PopoverContent>
    </Popover>
  );
}

export default function PrintQRPage() {
  const [qrs, setQrs] = useState<QRCode[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [selectedQRIds, setSelectedQRIds] = useState<Set<string>>(new Set());
  const [dateRange, setDateRange] = useState<DateRange | undefined>();

  useEffect(() => {
    async function fetchData() {
      try {
        const [qrRes, campaignRes] = await Promise.all([
          axios.get("/api/qr/get-all-qrcodes"),
          axios.get("/api/admin/get-all-campaigns"),
        ]);
        setQrs(qrRes.data.data);
        setCampaigns(campaignRes.data.data);
      } catch {
        toast.error("Failed to load data");
      }
    }
    fetchData();
  }, []);

  const filteredQRCodes = qrs.filter((q) => {
    const matchesCampaign =
      selectedCampaign === "all" || q.campaignId === selectedCampaign;
    const matchesStatus = status === "all" || q.status === status;
    const matchesDate =
      !dateRange ||
      (new Date(q.createdAt) >= dateRange.from! &&
        new Date(q.createdAt) <= dateRange.to!);
    return matchesCampaign && matchesStatus && matchesDate;
  });

  const selectedOrAll = Array.from(selectedQRIds).length
    ? filteredQRCodes.filter((qr) => selectedQRIds.has(qr.id))
    : filteredQRCodes;

  const handlePrint = () => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    const html = `
      <html>
        <head>
          <style>
            .grid {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
              gap: 20px;
              padding: 20px;
            }
            .card {
              width: 250px;
              height: 300px;
              padding: 12px;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              border: 1px solid #ccc;
              page-break-inside: avoid;
            }
            img {
              width: 100px;
              height: 100px;
              object-fit: contain;
              margin-bottom: 10px;
            }
            .footer {
              margin-top: 8px;
              font-size: 10px;
            }
          </style>
        </head>
        <body>
          <div class="grid">
            ${selectedOrAll
              .map(
                (qr) => `
              <div class="card">
                <img src="/sqratchLogo.png" alt="Logo" />
                <img src="${qr.imageUrl}" alt="QR Code" />
                <div>${qr.campaignName}</div>
                <div>${format(new Date(qr.createdAt), "PPP")}</div>
                <div>${qr.status}</div>
                <div class="footer">Scan Me • Powered by SQRATCH</div>
              </div>
            `
              )
              .join("")}
          </div>
          <script>
            window.onload = () => {
              window.print();
              window.onafterprint = () => window.close();
            }
          </script>
        </body>
      </html>
    `;
    printWindow.document.write(html);
    printWindow.document.close();
  };

  const handleExportExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("QR Codes");

    sheet.columns = [
      { header: "Code", key: "code", width: 20 },
      { header: "Campaign", key: "campaign", width: 20 },
      { header: "Status", key: "status", width: 15 },
      { header: "Used By", key: "usedBy", width: 25 },
      { header: "Used At", key: "usedAt", width: 25 },
      { header: "Created At", key: "createdAt", width: 25 },
      { header: "QR Image", key: "qrImage", width: 30 },
    ];

    for (const qr of selectedOrAll) {
      const row = sheet.addRow({
        code: qr.code,
        campaign: qr.campaignName,
        status: qr.status,
        usedBy: qr.usedBy || "",
        usedAt: qr.usedAt || "",
        createdAt: qr.createdAt,
      });

      try {
        const res = await axios.get(qr.imageUrl, {
          responseType: "arraybuffer",
        });
        const imageId = workbook.addImage({
          buffer: res.data,
          extension: "png",
        });
        sheet.addImage(imageId, {
          tl: { col: 6, row: row.number - 1 },
          ext: { width: 100, height: 100 },
        });
        row.height = 80;
      } catch (err) {
        console.warn("Failed to fetch image for", qr.code);
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "qr_export.xlsx";
    link.click();
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-col md:flex-row gap-4">
        <Select value={selectedCampaign} onValueChange={setSelectedCampaign}>
          <SelectTrigger className="w-48">
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

        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="NEW">NEW</SelectItem>
            <SelectItem value="REDEEMED">REDEEMED</SelectItem>
          </SelectContent>
        </Select>

        <DateRangePicker dateRange={dateRange} setDateRange={setDateRange} />

        <Button onClick={handleExportExcel} className="bg-[#3E93DE] text-white">
          Export Excel
        </Button>
        <Button onClick={handlePrint}>Print Selected</Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
        {filteredQRCodes.map((qr) => (
          <Card
            key={qr.id}
            className="p-4 print:w-[250px] print:h-[300px] print:break-inside-avoid"
          >
            <CardContent className="flex flex-col items-center space-y-2">
              <Checkbox
                checked={selectedQRIds.has(qr.id)}
                onCheckedChange={(checked) => {
                  const newSet = new Set(selectedQRIds);
                  checked ? newSet.add(qr.id) : newSet.delete(qr.id);
                  setSelectedQRIds(newSet);
                }}
              />
              <img src="/sqratchLogo.png" alt="Logo" className="w-20" />
              <img
                src={qr.imageUrl}
                alt="QR Code"
                className="w-32 h-32 bg-white"
              />
              <div className="text-center text-sm">
                <div>{qr.campaignName}</div>
                <div>{format(new Date(qr.createdAt), "PPP")}</div>
                <div>{qr.status}</div>
                <div className="text-xs mt-1">Scan Me • Powered by SQRATCH</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
