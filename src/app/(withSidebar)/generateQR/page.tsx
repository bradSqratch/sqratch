"use client";

import React, { useEffect, useState } from "react";
import axios from "axios";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

export default function GenerateQRPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>(
    []
  );
  const [campaignId, setCampaignId] = useState<string>("");
  const [quantity, setQuantity] = useState<number>(1);
  const [blocking, setBlocking] = useState(false);

  useEffect(() => {
    if (status === "authenticated") {
      axios
        .get("/api/admin/get-all-campaigns")
        .then((res) => setCampaigns(res.data.data))
        .catch(() => toast.error("Failed to fetch campaigns"));
    }
  }, [status]);

  const handleGenerate = async () => {
    if (!campaignId || quantity < 1) {
      toast.error("Please select campaign and valid quantity");
      return;
    }
    try {
      setBlocking(true);
      await axios.post("/api/qr/bulk-generate-qr", {
        campaignId,
        quantity,
      });
      toast.success("QR Codes Generated");
      router.push("/admin/qr-management");
    } catch (err) {
      toast.error("Generation failed");
    } finally {
      setBlocking(false);
    }
  };

  return (
    <div className="min-h-screen py-12 px-6 relative">
      {blocking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 backdrop-blur-sm">
          <div className="text-white text-lg font-semibold">
            Generating QR Codes…
          </div>
        </div>
      )}

      <Card className="mx-auto max-w-xl w-full">
        <CardHeader>
          <CardTitle className="text-2xl">Generate QR Codes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Select Campaign</Label>
            <Select
              value={campaignId}
              onValueChange={(val) => setCampaignId(val)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a campaign" />
              </SelectTrigger>
              <SelectContent>
                {campaigns.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="quantity">Quantity</Label>
            <Input
              type="number"
              id="quantity"
              value={quantity}
              min={1}
              onChange={(e) => setQuantity(parseInt(e.target.value))}
            />
          </div>

          <Button
            onClick={handleGenerate}
            className="w-full bg-[#3b639a] text-white rounded-full py-3 hover:bg-[#6388bb] transition-colors"
          >
            Generate QR Codes
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
