"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import axios from "axios";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import PublicHeader from "@/components/publicHeader";

export default function QRRedemptionPage() {
  const params = useParams();
  const campaignId = params.campaignID as string;
  const qrCodeId = params.qrcodeID as string;

  const [qrStatus, setQrStatus] = useState<
    | "LOADING"
    | "INVALID"
    | "REDEEMED"
    | "NEW"
    | "USED"
    | "SUBMITTED"
    | "DIRECT_INVITE"
    | "VERIFY_FIRST"
  >("LOADING");
  const [form, setForm] = useState({ name: "", email: "" });
  const [submitting, setSubmitting] = useState(false);

  // New: campaign name for personalized SUBMITTED screen
  const [campaignName, setCampaignName] = useState<string>("");

  // Load QR status, and also try to get the campaign name
  useEffect(() => {
    const checkQRCode = async () => {
      try {
        const res = await axios.get(
          `/api/qr/check-qrcode/${qrCodeId}?campaignId=${campaignId}`
        );
        // if your check endpoint ever returns campaignName, read it here:
        if (res.data?.campaignName) setCampaignName(res.data.campaignName);

        if (res.data.status === "USED") setQrStatus("REDEEMED");
        else if (res.data.status === "NEW") setQrStatus("NEW");
        else setQrStatus("INVALID");
      } catch {
        setQrStatus("INVALID");
      }
    };

    const fetchCampaignName = async () => {
      try {
        // fallback public endpoint to get the campaign name
        const r = await axios.get(
          `/api/public/get-campaign-name?campaignId=${campaignId}`
        );
        if (r.data?.name) setCampaignName(r.data.name);
      } catch {
        // silently ignore (UI still works without the name)
      }
    };

    checkQRCode().finally(fetchCampaignName);
  }, [campaignId, qrCodeId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const response = await axios.post(
        "/api/users/add-user-send-verify-email",
        {
          ...form,
          qrCodeId,
          campaignId,
        }
      );

      // Check the response message to determine which card to show
      const message = response.data.message;
      if (message === "Invite sent directly to your email!") {
        toast.success(message);
        setQrStatus("DIRECT_INVITE");
      } else {
        // This case should no longer happen with the new flow, but keeping for safety
        toast.success("Check your email to verify & complete redemption!");
        setQrStatus("SUBMITTED");
      }
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || "Failed to register.";
      toast.error(errorMessage);

      // Check if it's the "verify first" error
      if (errorMessage.includes("Verify the email address first")) {
        setQrStatus("VERIFY_FIRST");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const SubmittedCard = () => {
    if (qrStatus === "DIRECT_INVITE") {
      return (
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle>Invite Sent!</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <div className="text-green-600 font-medium">
              Great news! Your community invite has been sent directly to your
              email.
            </div>
            <p className="text-gray-600">
              Check your inbox for the community invite link. You're all set!
            </p>
          </CardContent>
        </Card>
      );
    }

    if (qrStatus === "VERIFY_FIRST") {
      return (
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle>Email Verification Required</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <div className="text-orange-600 font-medium">
              We found an account with your email, but it needs verification
              first.
            </div>
            <p className="text-gray-600">
              Please complete your email verification using the mail you
              received by scanning a QR code earlier. Once verified, you can
              scan this QR code again.
            </p>
          </CardContent>
        </Card>
      );
    }

    // Default SUBMITTED state
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>Check your email for a verification link.</CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          <div className="text-green-600 font-medium">
            Thank you for your submission!
          </div>
          <p className="text-gray-600">
            Click on the link in your email to complete your redemption, where
            you will receive an exclusive one‑time invite
            {campaignName ? (
              <>
                {" "}
                to{" "}
                <span className="font-extrabold">
                  &quot;{campaignName}&quot;
                </span>
                .
              </>
            ) : (
              "."
            )}
          </p>
        </CardContent>
      </Card>
    );
  };

  const renderCardContent = () => {
    switch (qrStatus) {
      case "INVALID":
        return "Invalid or expired QR code.";
      case "REDEEMED":
        return "This QR code has already been redeemed.";
      case "SUBMITTED":
      case "DIRECT_INVITE":
      case "VERIFY_FIRST":
        return <SubmittedCard />;
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
            <Button
              type="submit"
              disabled={submitting}
              className="bg-[#3b639a] hover:bg-[#335689]"
            >
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
        <Card className=" w-[90%] md:w-[35%] bg-white shadow-2xl z-10">
          <CardHeader className="flex justify-center">
            {qrStatus === "SUBMITTED" ||
            qrStatus === "DIRECT_INVITE" ||
            qrStatus === "VERIFY_FIRST" ? (
              // Use logo instead of text
              <img
                src="/sqratchLogo.png"
                alt="SQRATCH"
                className="h-6 w-auto"
              />
            ) : (
              <CardTitle className="text-[#3b639a] text-center">
                {qrStatus === "NEW"
                  ? "Redeem Your SQRATCH Code"
                  : qrStatus === "INVALID"
                  ? "Invalid QR"
                  : qrStatus === "REDEEMED"
                  ? "QR Code Info"
                  : "Check Your Email"}
              </CardTitle>
            )}
          </CardHeader>

          <CardContent>{renderCardContent()}</CardContent>
        </Card>
      </main>
    </div>
  );
}
