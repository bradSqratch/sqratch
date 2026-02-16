"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import axios from "axios";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import CommonNavbar from "@/components/commonNavbar";
import { gaEvent } from "@/lib/googleAnalytics";
import { useRef } from "react";

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

  // GA: log redeem_view event
  useEffect(() => {
    gaEvent("redeem_view", {
      campaign_id: campaignId,
      qr_code_id: qrCodeId,
      page_path: window.location.pathname + window.location.search,
    });
  }, [campaignId, qrCodeId]);

  // GA: log redeem_form_start event
  const startedRef = useRef(false);

  const trackFormStart = () => {
    if (startedRef.current) return;
    startedRef.current = true;

    gaEvent("redeem_form_start", {
      campaign_id: campaignId,
      qr_code_id: qrCodeId,
      page_path: window.location.pathname + window.location.search,
    });
  };

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
      gaEvent("redeem_submit_click", {
        campaign_id: campaignId,
        qr_code_id: qrCodeId,
        page_path: window.location.pathname + window.location.search,
      });

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
      gaEvent("redeem_submit_success", {
        campaign_id: campaignId,
        qr_code_id: qrCodeId,
        page_path: window.location.pathname + window.location.search,
        mode:
          message === "Invite sent directly to your email!"
            ? "direct_invite"
            : "verify_email",
      });

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
      gaEvent("redeem_submit_error", {
        campaign_id: campaignId,
        qr_code_id: qrCodeId,
        page_path: window.location.pathname + window.location.search,
        reason: errorMessage,
      });

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
      "relative w-full max-w-md rounded-[28px] border border-white/15 bg-white/6 backdrop-blur-xl text-white shadow-[0_30px_90px_rgba(0,0,0,0.55)]";

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
          <form className="space-y-6" onSubmit={handleSubmit}>
            <Input
              className="
                rounded-2xl
                border-white/10
                bg-black/40
                text-white
                placeholder:text-white/50
                focus-visible:ring-0
                focus-visible:border-white/25
              "
              placeholder="Your Name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              onFocus={trackFormStart}
              required
            />
            <Input
              className="
              rounded-2xl
              border-white/10
              bg-black/40
              text-white
              placeholder:text-white/50
              focus-visible:ring-0
              focus-visible:border-white/25
            "
              placeholder="Your Email"
              type="email"
              value={form.email}
              onChange={(e) =>
                setForm((f) => ({ ...f, email: e.target.value }))
              }
              onFocus={trackFormStart}
              required
            />
            <Input
              placeholder="Confirm Email"
              type="email"
              value={form.confirmEmail}
              onChange={(e) =>
                setForm((f) => ({ ...f, confirmEmail: e.target.value }))
              }
              onFocus={trackFormStart}
              required
              className={`${
                showEmailError ? "border-red-500" : "border-white/10"
              } rounded-2xl bg-black/40 text-white placeholder:text-white/50 focus-visible:ring-0 focus-visible:border-white/25`}
            />
            {showEmailError && (
              <p className="text-red-500 text-sm">
                Email addresses do not match
              </p>
            )}
            <Button
              type="submit"
              disabled={submitting || !isFormValid}
              className="
                w-full rounded-full py-6
                border border-white bg-white text-black
                hover:scale-[1.01] active:scale-[0.99]
                transition
                disabled:opacity-50 disabled:cursor-not-allowed
              "
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
    <div className="relative min-h-screen bg-[#020015] text-white overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        {/* Primary glow behind hero */}
        <div className="absolute inset-0 bg-[radial-gradient(1100px_600px_at_50%_10%,rgba(99,102,241,0.30),rgba(2,0,21,0)_70%)]" />

        {/* Secondary glow behind the card (centered slightly lower) */}
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_50%_55%,rgba(99,102,241,0.13),rgba(2,0,21,0)_65%)]" />

        {/* One accent only (pink), bottom-left for depth */}
        <div className="absolute inset-0 bg-[radial-gradient(900px_600px_at_10%_90%,rgba(236,72,153,0.10),rgba(2,0,21,0)_65%)]" />

        {/* Subtle vignette to darken edges */}
        <div className="absolute inset-0 bg-[radial-gradient(1200px_900px_at_50%_50%,rgba(2,0,21,0)_35%,rgba(2,0,21,0.85)_100%)]" />

        {/* Bottom fade */}
        <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-[#020121]" />
      </div>

      {/* content layer (match Signup) */}
      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-6 pt-28 pb-12 sm:pt-32">
          {/* Hero heading (Signup-style) */}
          <div className="w-full max-w-5xl text-center">
            <h1
              className="
              mt-2
              text-[40px] sm:text-[56px] lg:text-[64px]
              font-bold leading-[105%] tracking-[-0.03em]
              bg-[linear-gradient(145.55deg,#ECECEC_20.35%,rgba(236,236,236,0)_128.73%)]
              bg-clip-text text-transparent
              drop-shadow-[0_0_12px_rgba(236,236,236,0.50)]
              lg:whitespace-nowrap
            "
            >
              {qrStatus === "NEW" ? (
                <>
                  <span className="block leading-[1.1]">Redeem Your</span>
                  <span className="block leading-none">SQRATCH Code</span>
                </>
              ) : qrStatus === "INVALID" ? (
                "Invalid QR"
              ) : qrStatus === "REDEEMED" ? (
                "QR Code Info"
              ) : qrStatus === "SUBMITTED" ||
                qrStatus === "DIRECT_INVITE" ||
                qrStatus === "VERIFY_FIRST" ? (
                "Check Your Email"
              ) : (
                "Loading..."
              )}
            </h1>

            <p className="mt-3 text-[16px] sm:text-[18px] leading-[160%] text-[#ECECEC]/75">
              {qrStatus === "NEW"
                ? "Enter your details to claim your one-time invite."
                : qrStatus === "INVALID"
                ? "This QR code is invalid or expired."
                : qrStatus === "REDEEMED"
                ? "This QR code has already been redeemed."
                : qrStatus === "SUBMITTED" ||
                  qrStatus === "DIRECT_INVITE" ||
                  qrStatus === "VERIFY_FIRST"
                ? "Follow the instructions sent to your email."
                : "Checking your code..."}
            </p>
          </div>

          <Card
            className="
            relative mt-10 w-full max-w-md
            rounded-[28px]
            border border-white/15
            bg-white/6
            backdrop-blur-xl
            shadow-[0_30px_90px_rgba(0,0,0,0.55)]
            overflow-hidden
          "
          >
            <div className="pointer-events-none absolute inset-0 rounded-[28px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />

            <CardContent className="pt-2">{renderCardContent()}</CardContent>
          </Card>
        </main>
        {/* Footer (match Signup) */}
        <div className="pb-6 text-center text-white/55">
          © {new Date().getFullYear()} SQRATCH. All rights reserved.
        </div>
      </div>
    </div>
  );
}
