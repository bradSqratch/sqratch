"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import axios from "axios";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import CommonNavbar from "@/components/commonNavbar";

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
  const [form, setForm] = useState({ name: "", email: "", confirmEmail: "" });
  const [submitting, setSubmitting] = useState(false);

  // New: campaign name for personalized SUBMITTED screen
  const [campaignName, setCampaignName] = useState<string>("");

  // Email validation
  const emailsMatch = form.email === form.confirmEmail;
  const showEmailError = form.confirmEmail && !emailsMatch;
  const isFormValid =
    form.name && form.email && form.confirmEmail && emailsMatch;

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
    const sharedCardClasses =
      "w-full max-w-md rounded-2xl border border-white/10 bg-white/5 backdrop-blur text-white shadow-inner";

    if (qrStatus === "DIRECT_INVITE") {
      return (
        <Card className={sharedCardClasses}>
          <CardHeader className="text-center">
            <CardTitle className="text-white">Invite Sent!</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <div className="text-emerald-300 font-medium">
              Great news! Your community invite has been sent directly to your
              email.
            </div>
            <p className="text-white/70">
              Check your inbox for the community invite link. You're all set!
            </p>
          </CardContent>
        </Card>
      );
    }

    if (qrStatus === "VERIFY_FIRST") {
      return (
        <Card className={sharedCardClasses}>
          <CardHeader className="text-center">
            <CardTitle className="text-white">
              Email Verification Required
            </CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <div className="text-amber-300 font-medium">
              We found an account with your email, but it needs verification
              first.
            </div>
            <p className="text-white/70">
              Please complete your email verification using the mail you
              received by scanning a QR code earlier. Once verified, you can
              scan this QR code again.
            </p>
          </CardContent>
        </Card>
      );
    }

    return (
      <Card className={sharedCardClasses}>
        <CardHeader className="text-center">
          <CardTitle className="text-white">
            Check your email for a verification link.
          </CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          <div className="text-emerald-300 font-medium">
            Thank you for your submission!
          </div>
          <p className="text-white/70">
            Click on the link in your email to complete your redemption, where
            you will receive an exclusive one‑time invite
            {campaignName ? (
              <>
                {" "}
                to{" "}
                <span className="font-extrabold text-white">
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
            <Input
              placeholder="Confirm Email"
              type="email"
              value={form.confirmEmail}
              onChange={(e) =>
                setForm((f) => ({ ...f, confirmEmail: e.target.value }))
              }
              required
              className={showEmailError ? "border-red-500" : ""}
            />
            {showEmailError && (
              <p className="text-red-500 text-sm">
                Email addresses do not match
              </p>
            )}
            <Button
              type="submit"
              disabled={submitting || !isFormValid}
              className="bg-[#3E93DE] text-white hover:bg-[#335689] disabled:opacity-50 disabled:cursor-not-allowed"
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
    <div className="min-h-screen flex flex-col bg-[url('/assets/homepage/home_bg.jpeg')] bg-cover bg-center text-white">
      <CommonNavbar />

      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <Card className="w-full max-w-lg rounded-xl border border-white/10 bg-[linear-gradient(180deg,rgba(9,17,48,0.95)_0%,rgba(3,6,20,0.95)_100%)] text-white shadow-[0_25px_80px_rgba(0,0,0,0.65)]">
          <CardHeader className="text-center border-b border-white/10 pb-4">
            {qrStatus === "SUBMITTED" ||
            qrStatus === "DIRECT_INVITE" ||
            qrStatus === "VERIFY_FIRST" ? (
              <img
                src="/sqratchLogo.png"
                alt="SQRATCH"
                className="h-8 w-auto mx-auto"
              />
            ) : (
              <CardTitle className="text-2xl font-semibold text-white">
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

          <CardContent className="pt-2">{renderCardContent()}</CardContent>
        </Card>
      </main>
    </div>
  );
}
