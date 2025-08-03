"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import axios from "axios";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import Link from "next/link";
import PublicHeader from "@/components/publicHeader";

export default function QRRedemptionPage() {
  const params = useParams();
  const campaignId = params.campaignID as string;
  const qrCodeId = params.qrcodeID as string;

  const [qrStatus, setQrStatus] = useState<
    "LOADING" | "INVALID" | "REDEEMED" | "NEW" | "USED" | "SUBMITTED"
  >("LOADING");
  const [form, setForm] = useState({ name: "", email: "" });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const checkQRCode = async () => {
      try {
        const res = await axios.get(
          `/api/qr/check-qrcode/${qrCodeId}?campaignId=${campaignId}`
        );
        if (res.data.status === "USED") setQrStatus("REDEEMED");
        else if (res.data.status === "NEW") setQrStatus("NEW");
        else setQrStatus("INVALID");
      } catch {
        setQrStatus("INVALID");
      }
    };
    checkQRCode();
  }, [campaignId, qrCodeId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await axios.post("/api/users/add-user-send-verify-email", {
        ...form,
        qrCodeId,
        campaignId,
      });
      toast.success("Check your email to verify & complete redemption!");
      setQrStatus("SUBMITTED");
    } catch (err: any) {
      toast.error(err.response?.data?.error || "Failed to register.");
    } finally {
      setSubmitting(false);
    }
  };

  const renderCardContent = () => {
    switch (qrStatus) {
      case "INVALID":
        return "Invalid or expired QR code.";
      case "REDEEMED":
        return "This QR code has already been redeemed.";
      case "SUBMITTED":
        return (
          <p className="text-center py-8">
            <b>Check your email for the verification link.</b>
            <br />
            Click on the link, then click <b>“Verify and Redeem”</b> to complete
            your redemption.
          </p>
        );
      case "NEW":
        return (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <Input
              placeholder="Your Name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
            <Input
              placeholder="Your Email"
              type="email"
              value={form.email}
              onChange={(e) =>
                setForm((f) => ({ ...f, email: e.target.value }))
              }
              required
            />
            <Button type="submit" disabled={submitting}>
              {submitting ? "Sending..." : "Submit"}
            </Button>
          </form>
        );
      default:
        return "Loading...";
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[url('/assets/homepage/home_bg.jpeg')] bg-cover bg-center">
      <PublicHeader />

      <main className="flex-1 flex items-center justify-center p-4">
        <Card className="w-[350px] bg-white shadow-2xl z-10">
          <CardHeader>
            <CardTitle>
              {qrStatus === "SUBMITTED"
                ? "Check Your Email"
                : qrStatus === "NEW"
                ? "Redeem QR Code"
                : qrStatus === "INVALID"
                ? "Invalid QR"
                : "QR Code Info"}
            </CardTitle>
          </CardHeader>
          <CardContent>{renderCardContent()}</CardContent>
        </Card>
      </main>
    </div>
  );
}
