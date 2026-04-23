"use client";

import React, { useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import axios from "axios";
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
import Link from "next/link";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type Message = { type: "error" | "success"; text: React.ReactNode };
type RequestedRole = "CREATOR" | "BRAND" | null;

function getErrorMessage(error: unknown, fallback: string) {
  if (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: unknown }).response === "object" &&
    (error as { response?: { data?: unknown } }).response !== null &&
    "data" in ((error as { response?: { data?: unknown } }).response || {}) &&
    typeof (error as { response?: { data?: { error?: unknown } } }).response
      ?.data === "object" &&
    (error as { response?: { data?: { error?: unknown } } }).response?.data !==
      null &&
    typeof (error as { response?: { data?: { error?: unknown } } }).response
      ?.data?.error === "string"
  ) {
    return (error as { response?: { data?: { error?: string } } }).response!
      .data!.error!;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

function normalizeNextPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/dashboard";
  }

  return value;
}

function SignupPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const invitedEmail = searchParams.get("registeredemail");
  const nextPath = normalizeNextPath(searchParams.get("next"));
  const isInvitedClaimFlow = Boolean(invitedEmail);

  const [user, setUser] = React.useState({
    name: "",
    email: "",
    password: "",
  });

  const [requestedRole, setRequestedRole] = React.useState<RequestedRole>(null);
  const [showApplyCard, setShowApplyCard] = React.useState(false);

  const [creatorApplication, setCreatorApplication] = React.useState({
    displayName: "",
    websiteOrSocial: "",
    shortReason: "",
  });

  const [brandApplication, setBrandApplication] = React.useState({
    brandName: "",
    website: "",
    shopifyDomain: "",
    shortGoal: "",
  });

  const [buttonDisabled, setButtonDisabled] = React.useState(true);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState<Message | null>(null);
  const [hasRedeemedQrWarning, setHasRedeemedQrWarning] =
    React.useState(false);
  const [viewerStatusLoaded, setViewerStatusLoaded] = React.useState(false);
  const redeemedQrBlocksSignup =
    viewerStatusLoaded && hasRedeemedQrWarning && !isInvitedClaimFlow;
  const waitingForViewerStatus = !viewerStatusLoaded && !isInvitedClaimFlow;

  useEffect(() => {
    if (invitedEmail) {
      setUser((u) => ({ ...u, email: invitedEmail.toLowerCase() }));
    }
  }, [invitedEmail]);

  useEffect(() => {
    setButtonDisabled(!(user.name && user.email && user.password));
  }, [user]);

  useEffect(() => {
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
  }, []);

  const onSignup = async () => {
    setMessage(null);

    if (!user.name || !user.email || !user.password) {
      setMessage({ type: "error", text: "All fields are required." });
      return;
    }

    if (
      requestedRole === "CREATOR" &&
      !creatorApplication.displayName.trim() &&
      !user.name.trim()
    ) {
      setMessage({
        type: "error",
        text: "Please provide a display name for your creator application.",
      });
      return;
    }

    if (requestedRole === "BRAND") {
      if (
        !brandApplication.brandName.trim() ||
        !brandApplication.website.trim()
      ) {
        setMessage({
          type: "error",
          text: "Brand name and website are required for brand applications.",
        });
        return;
      }
    }

    setLoading(true);

    try {
      const normalizedUser = {
        name: user.name.trim(),
        email: user.email.trim().toLowerCase(),
        password: user.password,
      };

      // 1) KEEP existing invited EXTERNAL claim flow intact
      if (isInvitedClaimFlow) {
        const res = await axios.post("/api/users/signup", normalizedUser);

        setMessage({
          type: "success",
          text: res.data?.message || "Signup successful! Redirecting…",
        });

        setTimeout(() => router.push("/login"), 700);
        return;
      }

      // 2) New self-serve signup flow
      let application: Record<string, string> | null = null;

      if (requestedRole === "CREATOR") {
        application = {
          displayName:
            creatorApplication.displayName.trim() || user.name.trim(),
          websiteOrSocial: creatorApplication.websiteOrSocial.trim(),
          shortReason: creatorApplication.shortReason.trim(),
        };
      }

      if (requestedRole === "BRAND") {
        application = {
          brandName: brandApplication.brandName.trim(),
          website: brandApplication.website.trim(),
          shopifyDomain: brandApplication.shopifyDomain.trim(),
          shortGoal: brandApplication.shortGoal.trim(),
        };
      }

      const res = await axios.post("/api/auth/signup", {
        ...normalizedUser,
        requestedRole,
        application,
      });

      setMessage({
        type: "success",
        text:
          res.data?.message ||
          "Account created. Please verify your email to continue.",
      });

      setTimeout(() => {
        router.push(
          `/verify-email?email=${encodeURIComponent(normalizedUser.email)}&next=${encodeURIComponent(nextPath)}`,
        );
      }, 700);
    } catch (error: unknown) {
      const msg = getErrorMessage(error, "Signup failed");
      setMessage({ type: "error", text: msg });
      setLoading(false);
      return;
    }

    setLoading(false);
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
              {isInvitedClaimFlow
                ? "Activating your account..."
                : "Creating your account..."}
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
              {redeemedQrBlocksSignup ? "QR Already Redeemed" : "Signup"}
            </h1>

            <p className="mt-3 text-[16px] sm:text-[18px] leading-[160%] text-[#ECECEC]/75">
              {redeemedQrBlocksSignup
                ? "Log in to browse public content"
                : isInvitedClaimFlow
                  ? "Claim your invited account"
                  : "Create your account to get started"}
            </p>

            {hasRedeemedQrWarning && (
              <div className="mx-auto mt-6 max-w-2xl rounded-2xl border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm leading-6 text-amber-100">
                This QR code is already redeemed. You can log in and browse
                public content, but you will not earn points or unlock private
                access from this QR code.
              </div>
            )}
          </div>

          {waitingForViewerStatus ? (
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
              <CardContent className="flex items-center justify-center gap-3 p-8 text-white/70">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/50 border-t-transparent" />
                Checking QR status...
              </CardContent>
            </Card>
          ) : redeemedQrBlocksSignup ? (
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

              <CardContent className="relative space-y-5 p-6 text-center sm:p-8">
                <p className="text-sm leading-6 text-white/70">
                  This QR code has already been used by another redemption. Use
                  a fresh QR code if you need private access or points.
                </p>

                <Button
                  asChild
                  className="w-full rounded-full border border-white bg-white py-6 text-black"
                >
                  <Link
                    href={`/login?next=${encodeURIComponent(nextPath)}`}
                  >
                    Log In
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : !showApplyCard || isInvitedClaimFlow ? (
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

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onSignup();
                }}
                className="relative"
              >
                <CardHeader className="pb-2">
                  <CardDescription>
                    {message && (
                      <div
                        className={`mt-2 text-center text-[14px] ${
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

                <CardContent className="space-y-5 px-6 pb-2 sm:px-8">
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="name" className="pl-1 text-white/70">
                        Name
                      </Label>
                      <Input
                        id="name"
                        type="text"
                        autoComplete="name"
                        value={user.name}
                        onChange={(e) =>
                          setUser({ ...user, name: e.target.value })
                        }
                        className="mt-2 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                      />
                    </div>

                    <div>
                      <Label htmlFor="email" className="pl-1 text-white/70">
                        Email
                      </Label>
                      <Input
                        id="email"
                        type="email"
                        autoComplete="email"
                        disabled={isInvitedClaimFlow}
                        value={user.email}
                        onChange={(e) =>
                          setUser({
                            ...user,
                            email: e.target.value.toLowerCase(),
                          })
                        }
                        className="mt-2 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25 disabled:opacity-70"
                      />
                    </div>

                    <div>
                      <Label htmlFor="password" className="pl-1 text-white/70">
                        Password
                      </Label>
                      <Input
                        id="password"
                        type="password"
                        autoComplete="new-password"
                        value={user.password}
                        onChange={(e) =>
                          setUser({ ...user, password: e.target.value })
                        }
                        className="mt-2 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                      />
                    </div>
                  </div>
                </CardContent>

                <CardFooter className="flex flex-col gap-3 px-6 pb-0 sm:px-8">
                  <Button
                    type="submit"
                    disabled={buttonDisabled || loading}
                    className="w-full rounded-full py-6 border border-white bg-white text-black hover:scale-[1.01] active:scale-[0.99] transition"
                  >
                    {isInvitedClaimFlow ? "Activate Account" : "Signup"}
                  </Button>

                  {!isInvitedClaimFlow && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setRequestedRole("CREATOR");
                        setShowApplyCard(true);
                        setMessage(null);
                      }}
                      className="w-full rounded-full border border-white/15 bg-white/5 text-white hover:bg-white/10"
                    >
                      Apply as Creator or Brand
                    </Button>
                  )}

                  <Button
                    variant="link"
                    asChild
                    className="mt-2 text-white/70 hover:text-white"
                  >
                    <Link href="/login">Already have an account? Login</Link>
                  </Button>
                </CardFooter>
              </form>
            </Card>
          ) : (
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

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onSignup();
                }}
                className="relative"
              >
                <CardHeader className="pb-2 px-6 pt-6 sm:px-8">
                  <CardDescription>
                    {message && (
                      <div
                        className={`mt-2 text-center text-[14px] ${
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

                <CardContent className="space-y-5 px-6 pb-2 sm:px-8">
                  <div className="mb-2">
                    <h2 className="text-lg font-semibold text-white">
                      Apply as Creator or Brand
                    </h2>
                    <p className="mt-1 text-sm text-white/65">
                      Your account will be created first, and your application
                      will be submitted for review.
                    </p>
                  </div>

                  <Tabs
                    value={requestedRole === "BRAND" ? "brand" : "creator"}
                    onValueChange={(value) => {
                      setRequestedRole(value === "brand" ? "BRAND" : "CREATOR");
                      setMessage(null);
                    }}
                    className="pt-1"
                  >
                    <TabsList className="grid w-full grid-cols-2 bg-black/30">
                      <TabsTrigger value="creator">Creator</TabsTrigger>
                      <TabsTrigger value="brand">Brand</TabsTrigger>
                    </TabsList>

                    <TabsContent value="creator" className="mt-4 space-y-4">
                      <div>
                        <Label className="pl-1 text-white/70">
                          Display Name
                        </Label>
                        <Input
                          value={creatorApplication.displayName}
                          onChange={(e) =>
                            setCreatorApplication((prev) => ({
                              ...prev,
                              displayName: e.target.value,
                            }))
                          }
                          className="mt-2 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                        />
                      </div>

                      <div>
                        <Label
                          htmlFor="creator-email"
                          className="pl-1 text-white/70"
                        >
                          Email
                        </Label>
                        <Input
                          id="creator-email"
                          type="email"
                          autoComplete="email"
                          value={user.email}
                          onChange={(e) =>
                            setUser({
                              ...user,
                              email: e.target.value.toLowerCase(),
                            })
                          }
                          className="mt-2 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                        />
                      </div>

                      <div>
                        <Label
                          htmlFor="creator-password"
                          className="pl-1 text-white/70"
                        >
                          Password
                        </Label>
                        <Input
                          id="creator-password"
                          type="password"
                          autoComplete="new-password"
                          value={user.password}
                          onChange={(e) =>
                            setUser({ ...user, password: e.target.value })
                          }
                          className="mt-2 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                        />
                      </div>

                      <div>
                        <Label
                          htmlFor="creator-name"
                          className="pl-1 text-white/70"
                        >
                          Your Name
                        </Label>
                        <Input
                          id="creator-name"
                          type="text"
                          autoComplete="name"
                          value={user.name}
                          onChange={(e) =>
                            setUser({ ...user, name: e.target.value })
                          }
                          className="mt-2 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                        />
                      </div>

                      <div>
                        <Label className="pl-1 text-white/70">
                          Website / Social
                        </Label>
                        <Input
                          value={creatorApplication.websiteOrSocial}
                          onChange={(e) =>
                            setCreatorApplication((prev) => ({
                              ...prev,
                              websiteOrSocial: e.target.value,
                            }))
                          }
                          className="mt-2 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                        />
                      </div>

                      <div>
                        <Label className="pl-1 text-white/70">
                          Reason / Note
                        </Label>
                        <Textarea
                          value={creatorApplication.shortReason}
                          onChange={(e) =>
                            setCreatorApplication((prev) => ({
                              ...prev,
                              shortReason: e.target.value,
                            }))
                          }
                          className="mt-2 min-h-27.5 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                        />
                      </div>
                    </TabsContent>

                    <TabsContent value="brand" className="mt-4 space-y-4">
                      <div>
                        <Label className="pl-1 text-white/70">Brand Name</Label>
                        <Input
                          value={brandApplication.brandName}
                          onChange={(e) =>
                            setBrandApplication((prev) => ({
                              ...prev,
                              brandName: e.target.value,
                            }))
                          }
                          className="mt-2 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                        />
                      </div>

                      <div>
                        <Label
                          htmlFor="brand-email"
                          className="pl-1 text-white/70"
                        >
                          Email
                        </Label>
                        <Input
                          id="brand-email"
                          type="email"
                          autoComplete="email"
                          value={user.email}
                          onChange={(e) =>
                            setUser({
                              ...user,
                              email: e.target.value.toLowerCase(),
                            })
                          }
                          className="mt-2 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                        />
                      </div>

                      <div>
                        <Label
                          htmlFor="brand-password"
                          className="pl-1 text-white/70"
                        >
                          Password
                        </Label>
                        <Input
                          id="brand-password"
                          type="password"
                          autoComplete="new-password"
                          value={user.password}
                          onChange={(e) =>
                            setUser({ ...user, password: e.target.value })
                          }
                          className="mt-2 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                        />
                      </div>

                      <div>
                        <Label
                          htmlFor="brand-name-user"
                          className="pl-1 text-white/70"
                        >
                          Your Name
                        </Label>
                        <Input
                          id="brand-name-user"
                          type="text"
                          autoComplete="name"
                          value={user.name}
                          onChange={(e) =>
                            setUser({ ...user, name: e.target.value })
                          }
                          className="mt-2 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                        />
                      </div>

                      <div>
                        <Label className="pl-1 text-white/70">Website</Label>
                        <Input
                          value={brandApplication.website}
                          onChange={(e) =>
                            setBrandApplication((prev) => ({
                              ...prev,
                              website: e.target.value,
                            }))
                          }
                          className="mt-2 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                        />
                      </div>

                      <div>
                        <Label className="pl-1 text-white/70">
                          Reason / Note
                        </Label>
                        <Textarea
                          value={brandApplication.shortGoal}
                          onChange={(e) =>
                            setBrandApplication((prev) => ({
                              ...prev,
                              shortGoal: e.target.value,
                            }))
                          }
                          className="mt-2 min-h-27.5 rounded-2xl border-white/10 bg-black/30 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-white/25"
                        />
                      </div>
                    </TabsContent>
                  </Tabs>
                </CardContent>

                <CardFooter className="flex flex-col gap-3 px-6 pb-6 sm:px-8">
                  <Button
                    type="submit"
                    disabled={buttonDisabled || loading}
                    className="w-full rounded-full py-6 border border-white bg-white text-black hover:scale-[1.01] active:scale-[0.99] transition"
                  >
                    Submit Application
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setShowApplyCard(false);
                      setRequestedRole(null);
                      setMessage(null);
                    }}
                    className="w-full rounded-full border border-white/15 bg-white/5 text-white hover:bg-white/10"
                  >
                    Back to Normal Signup
                  </Button>

                  <Button
                    variant="link"
                    asChild
                    className="text-white/70 hover:text-white"
                  >
                    <Link href="/login">Already have an account? Login</Link>
                  </Button>
                </CardFooter>
              </form>
            </Card>
          )}
        </main>

        <div className="pb-6 text-center text-white/55">
          © {new Date().getFullYear()} SQRATCH. All rights reserved.
        </div>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}
