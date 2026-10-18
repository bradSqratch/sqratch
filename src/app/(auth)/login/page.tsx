// app/login/page.tsx
"use client";

import React, { Suspense, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn, getSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CommonNavbar from "@/components/commonNavbar";
import { normalizeInternalRedirectPath } from "@/lib/safe-redirect";

type Message = { type: "error" | "success"; text: React.ReactNode };

function shouldCheckQrWarningForPath(nextPath: string) {
  return (
    nextPath.startsWith("/c/") ||
    nextPath.startsWith("/x/") ||
    nextPath.startsWith("/q/")
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = normalizeInternalRedirectPath(
    searchParams.get("callbackUrl") || searchParams.get("next"),
  );
  const shouldCheckQrWarning = shouldCheckQrWarningForPath(nextPath);
  const signupHref = `/signup?next=${encodeURIComponent(nextPath)}`;

  const [user, setUser] = React.useState({ email: "", password: "" });
  const [buttonDisabled, setButtonDisabled] = React.useState(true);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState<Message | null>(null);
  const [hasRedeemedQrWarning, setHasRedeemedQrWarning] =
    React.useState(false);
  const [viewerStatusLoaded, setViewerStatusLoaded] = React.useState(false);
  const onLogin = async () => {
    setMessage(null);

    if (!user.email || !user.password) {
      setMessage({
        type: "error",
        text: "Email and Password cannot be empty!",
      });
      return;
    }

    setLoading(true);
    try {
      const result = await signIn("credentials", {
        redirect: false,
        email: user.email,
        password: user.password,
      });

      if (result?.error) {
        setMessage({
          type: "error",
          text: result.error || "Invalid credentials.",
        });
        setLoading(false);
      } else {
        await checkSession();
      }
    } catch (err) {
      console.error(err);
      setMessage({
        type: "error",
        text: "An unexpected error occurred. Please try again.",
      });
      setLoading(false);
    }
  };

  const ReSendVerificationEmail = async (email: string) => {
    try {
      const res = await fetch("/api/auth/send-email-verification", {
        method: "POST",
        body: JSON.stringify({ email }),
        headers: { "Content-Type": "application/json" },
      });

      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Verification email sent!" });
      } else {
        setMessage({
          type: "error",
          text: data.error || "Failed to send email.",
        });
      }
    } catch (error) {
      console.error(error);
      setMessage({
        type: "error",
        text: "Something went wrong sending the email.",
      });
    }
  };

  const checkSession = async (attempt = 0) => {
    const MAX_ATTEMPTS = 10;
    const sess = await getSession();
    if (sess?.user) {
      const { isEmailVerified, email } = sess.user;

      if (!isEmailVerified) {
        setMessage({
          type: "error",
          text: (
            <>
              Your email is not verified.{" "}
              <button
                onClick={() => email && ReSendVerificationEmail(email)}
                className="text-blue-500 underline"
              >
                Click here to resend verification email.
              </button>
            </>
          ),
        });
        setLoading(false);
        return;
      }

      // if (role !== "USER" && role !== "ADMIN") {
      //   setMessage({
      //     type: "error",
      //     text: "You are not allowed to log in with this account.",
      //   });
      //   setLoading(false);
      //   return;
      // }

      try {
        await fetch("/api/progress/merge", {
          method: "POST",
          credentials: "include",
        });
      } catch (mergeError) {
        console.error("Failed to merge anonymous progress:", mergeError);
      }

      setMessage({ type: "success", text: "Login successful! Redirecting…" });
      setTimeout(() => {
        router.push(nextPath);
      }, 600);
    } else if (attempt < MAX_ATTEMPTS) {
      // retry briefly
      setTimeout(() => checkSession(attempt + 1), 500);
    } else {
      setMessage({
        type: "error",
        text: "Sign-in is taking longer than expected. Please refresh and try again.",
      });
      setLoading(false);
    }
  };

  useEffect(() => {
    setButtonDisabled(!(user.email && user.password));
  }, [user]);

  useEffect(() => {
    if (!shouldCheckQrWarning) {
      setHasRedeemedQrWarning(false);
      setViewerStatusLoaded(true);
      return;
    }

    const loadViewerStatus = async () => {
      try {
        const response = await fetch("/api/public/viewer-status", {
          credentials: "include",
        });
        const payload = await response.json();
        setHasRedeemedQrWarning(Boolean(payload?.data?.hasRedeemedQrWarning));
      } catch {
        setHasRedeemedQrWarning(false);
      } finally {
        setViewerStatusLoaded(true);
      }
    };

    void loadViewerStatus();
  }, [shouldCheckQrWarning]);

  const handleEnterSubmit = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();

    if (buttonDisabled || loading) {
      return;
    }

    void onLogin();
  };

  return (
    <div className="relative min-h-screen bg-page text-ink overflow-hidden">
      {/* Contact-page style background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_50%_0%,rgba(var(--glow-primary-rgb),0.28),rgba(var(--scene-rgb),0)_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_15%_25%,rgba(var(--glow-secondary-rgb),0.20),rgba(var(--scene-rgb),0)_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_85%_30%,rgba(var(--glow-tertiary-rgb),0.18),rgba(var(--scene-rgb),0)_60%)]" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-section" />
      </div>

      {/* Loader overlay */}
      {loading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center theme-media bg-black/80 text-ink">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-edge border-t-transparent rounded-full animate-spin" />
            <p className="text-ink text-lg">Validating credentials...</p>
          </div>
        </div>
      )}

      {/* content layer */}
      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />

        {/* Login Form (centered) */}
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-6 pt-20 pb-12 sm:pt-32">
          {/* Heading like Contact SQRATCH */}
          <div className="w-full max-w-3xl text-center">
            <h1
              className="
                mt-2
                text-[40px] sm:text-[56px] lg:text-[64px]
                font-bold leading-[105%] tracking-[-0.03em]
                bg-[image:var(--heading-gradient)]
                bg-clip-text text-transparent
                drop-shadow-[0_0_12px_rgba(236,236,236,0.50)]
              "
            >
              Login
            </h1>

            <p className="mt-3 text-[16px] sm:text-[18px] leading-[160%] text-copy-75">
              Login to access your dashboard
            </p>

            {viewerStatusLoaded && hasRedeemedQrWarning && (
              <div className="mx-auto mt-6 max-w-2xl rounded-2xl border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm leading-6 text-amber-700 dark:text-amber-100">
                This QR code is already redeemed. You can still log in, but it
                will not unlock private access or award points.
              </div>
            )}
          </div>

          {/* Outer card matches Contact outer glass */}
          <Card
            className="
              relative mt-10 w-full max-w-md
              rounded-[28px]
              border border-edge/15
              bg-glass-6
              backdrop-blur-xl
              shadow-[0_8px_28px_rgba(72,57,34,0.06)] dark:shadow-[0_30px_90px_rgba(0,0,0,0.55)]
              overflow-hidden
            "
          >
            <div className="pointer-events-none absolute inset-0 rounded-[28px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />

            <form
              onSubmit={(e) => {
                e.preventDefault();
                onLogin();
              }}
              className="relative"
            >
              <CardHeader className="pb-2">
                <CardDescription>
                  {message && (
                    <div
                      className={`mt-2 text-center text-[14px] ${
                        message.type === "error"
                          ? "text-red-700 dark:text-red-400"
                          : "text-green-700 dark:text-green-400"
                      }`}
                    >
                      {message.text}
                    </div>
                  )}
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-5 px-6 pb-5 sm:px-8">
                {/* Field container styled like inner card background */}
                <div className="pb-5">
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="email" className="pl-1 text-copy-70">
                        Email
                      </Label>
                      <Input
                        id="email"
                        type="email"
                        autoComplete="email"
                        value={user.email}
                        onKeyDown={handleEnterSubmit}
                        onChange={(e) =>
                          setUser({ ...user, email: e.target.value })
                        }
                        className="
                  mt-2 rounded-2xl
                  border-edge/10 bg-inset/30
                  text-ink placeholder:text-copy-40
                  focus-visible:ring-0 focus-visible:border-edge/25
                "
                      />
                    </div>

                    <div>
                      <Label htmlFor="password" className="pl-1 text-copy-70">
                        Password
                      </Label>
                      <Input
                        id="password"
                        type="password"
                        autoComplete="current-password"
                        value={user.password}
                        onKeyDown={handleEnterSubmit}
                        onChange={(e) =>
                          setUser({ ...user, password: e.target.value })
                        }
                        className="
                  mt-2 rounded-2xl
                  border-edge/10 bg-inset/30
                  text-ink placeholder:text-copy-40
                  focus-visible:ring-0 focus-visible:border-edge/25
                "
                      />
                    </div>
                  </div>
                </div>
              </CardContent>

              <CardFooter className="flex flex-col gap-3 pb-4 px-6 sm:px-8">
                <Button
                  type="submit"
                  disabled={buttonDisabled || loading}
                  className="
            w-full rounded-full py-6
            border border-edge bg-primary text-primary-foreground
            hover:scale-[1.01] active:scale-[0.99]
            transition
          "
                >
                  Login
                </Button>
                {viewerStatusLoaded && !hasRedeemedQrWarning && (
                  <p className="text-center text-sm text-copy-60">
                    Need an account?{" "}
                    <Link href={signupHref} className="text-ink underline">
                      Sign up
                    </Link>
                  </p>
                )}
              </CardFooter>
            </form>
          </Card>
        </main>

        {/* Footer */}
        <div className="pb-6 text-center text-copy-55">
          © {new Date().getFullYear()} SQRATCH. All rights reserved.
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
