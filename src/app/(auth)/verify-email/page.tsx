"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import axios from "axios";
import CommonNavbar from "@/components/commonNavbar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { normalizeInternalRedirectPath } from "@/lib/safe-redirect";

type Message = { type: "error" | "success"; text: string };
type LoadingAction = "verify" | "resend" | null;

function VerifyEmailPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const email = searchParams.get("email") || "";
  const nextPath = normalizeInternalRedirectPath(searchParams.get("next"));

  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState("");
  const [isVerified, setIsVerified] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [message, setMessage] = useState<Message | null>(null);
  const [loadingAction, setLoadingAction] = useState<LoadingAction>(null);

  const canResend = useMemo(() => cooldown === 0 && !!email, [cooldown, email]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((prev) => prev - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const verifyOtp = async () => {
    setMessage(null);

    if (!email || code.trim().length !== 6) {
      setMessage({
        type: "error",
        text: "Please enter the 6-digit verification code.",
      });
      return;
    }

    try {
      setLoading(true);
      setLoadingAction("verify");

      const response = await axios.post("/api/auth/verify-email", {
        email,
        code: code.trim(),
      });

      const successMessage =
        response.data?.message || "Email verified successfully.";

      setMessage({
        type: "success",
        text: successMessage,
      });

      toast.success("Success", {
        description: successMessage,
      });

      setIsVerified(true);

      setTimeout(() => {
        router.push(`/login?next=${encodeURIComponent(nextPath)}`);
      }, 900);
    } catch {
      const errorMessage =
        "Unable to verify this code. Request a new code and try again.";

      setMessage({
        type: "error",
        text: errorMessage,
      });

      toast.error("Error", {
        description: errorMessage,
      });
    } finally {
      setLoading(false);
      setLoadingAction(null);
    }
  };

  const resendCode = async () => {
    setMessage(null);

    if (!email || !canResend) return;

    try {
      setLoading(true);
      setLoadingAction("resend");

      await axios.post("/api/auth/send-email-verification", { email });

      setMessage({
        type: "success",
        text: "A new verification code has been sent.",
      });

      toast.success("Success", {
        description: "A new verification code has been sent.",
      });

      setCooldown(30);
    } catch {
      const errorMessage =
        "Unable to send a verification code right now. Please try again.";

      setMessage({
        type: "error",
        text: errorMessage,
      });

      toast.error("Error", {
        description: errorMessage,
      });
    } finally {
      setLoading(false);
      setLoadingAction(null);
    }
  };

  return (
    <div className="relative min-h-screen bg-[#020015] text-white overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_50%_0%,rgba(99,102,241,0.28),rgba(2,0,21,0)_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_15%_25%,rgba(236,72,153,0.20),rgba(2,0,21,0)_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_85%_30%,rgba(34,211,238,0.18),rgba(2,0,21,0)_60%)]" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-[#020121]" />
      </div>

      {loading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
          <div className="flex flex-col items-center gap-4">
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-white border-t-transparent" />
            <p className="text-lg text-white">
              {isVerified
                ? "Redirecting..."
                : loadingAction === "resend"
                  ? "Sending a new code..."
                  : "Verifying your code..."}
            </p>
          </div>
        </div>
      )}

      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-6 pt-28 pb-12 sm:pt-32">
          <div className="w-full max-w-3xl text-center">
            <h1
              className="
                mt-2
                text-[40px] sm:text-[56px] lg:text-[64px]
                font-bold leading-[105%] tracking-[-0.03em]
                bg-[linear-gradient(145.55deg,#ECECEC_20.35%,rgba(236,236,236,0)_128.73%)]
                bg-clip-text text-transparent
                drop-shadow-[0_0_12px_rgba(236,236,236,0.50)]
              "
            >
              Verify Email
            </h1>

            <p className="mt-3 text-[16px] sm:text-[18px] leading-[160%] text-[#ECECEC]/75">
              Enter the 6-digit code sent to your email
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
              overflow-hidden pt-4 pb-2
            "
          >
            <div className="pointer-events-none absolute inset-0 rounded-[28px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />

            <CardHeader className="pb-2">
              <CardDescription className="text-center">
                <div className="text-white/70 text-[14px]">
                  We sent a 6-digit verification code to
                  <div className="mt-1 font-medium text-white break-all">
                    {email || "your email"}
                  </div>
                </div>

                {message && (
                  <div
                    className={`mt-3 text-center text-[14px] ${
                      message.type === "error"
                        ? "text-red-400"
                        : "text-green-400"
                    }`}
                  >
                    {message.text}
                  </div>
                )}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-5 px-6 pb-6 sm:px-8">
              {!isVerified && (
                <>
                  <div>
                    <label className="pl-1 text-white/70 text-sm">
                      Verification Code
                    </label>
                    <Input
                      value={code}
                      onChange={(e) => {
                        setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                        if (message?.type === "error") {
                          setMessage(null);
                        }
                      }}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="Enter 6-digit OTP"
                      className="
                        mt-2 h-14 rounded-2xl
                        border-white/10 bg-black/30
                        text-white placeholder:text-white/35
                        text-center text-2xl tracking-[0.4em]
                        caret-white
                        focus-visible:ring-0 focus-visible:border-white/25
                      "
                    />
                  </div>

                  <div className="flex flex-col gap-3">
                    <Button
                      onClick={verifyOtp}
                      disabled={loading || code.trim().length !== 6}
                      className="
                        w-full rounded-full py-6
                        border border-white bg-white text-black
                        hover:scale-[1.01] active:scale-[0.99]
                        transition
                      "
                    >
                      {loading ? "Verifying..." : "Verify"}
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      onClick={resendCode}
                      disabled={!canResend || loading}
                      className="
                        w-full rounded-full py-6
                        border border-white/15 bg-white/5 text-white
                        hover:bg-white/10
                      "
                    >
                      {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend Code"}
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </main>

        <div className="pb-6 text-center text-white/55">
          © {new Date().getFullYear()} SQRATCH. All rights reserved.
        </div>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailPageInner />
    </Suspense>
  );
}
