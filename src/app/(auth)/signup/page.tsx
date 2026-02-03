// src/app/(auth)/signup/page.tsx
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
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CommonNavbar from "@/components/commonNavbar";
import Link from "next/link";

type Message = { type: "error" | "success"; text: React.ReactNode };

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );

  function SignupPageInner() {
    const router = useRouter();
    const searchParams = useSearchParams();

    const [user, setUser] = React.useState({
      name: "",
      email: "",
      password: "",
    });

    const [buttonDisabled, setButtonDisabled] = React.useState(true);
    const [loading, setLoading] = React.useState(false);
    const [message, setMessage] = React.useState<Message | null>(null);

    useEffect(() => {
      const invitedEmail = searchParams.get("registeredemail");
      if (invitedEmail) {
        setUser((u) => ({ ...u, email: invitedEmail }));
      }
    }, [searchParams]);

    const onSignup = async () => {
      setMessage(null);

      if (!user.name || !user.email || !user.password) {
        setMessage({ type: "error", text: "All fields are required." });
        return;
      }

      setLoading(true);
      try {
        const normalizedUser = {
          ...user,
          email: user.email.trim().toLowerCase(),
        };

        const res = await axios.post("/api/users/signup", normalizedUser);

        setMessage({
          type: "success",
          text: res.data?.message || "Signup successful! Redirecting…",
        });

        setTimeout(() => router.push("/login"), 600);
      } catch (error: any) {
        const msg =
          error?.response?.data?.error || error.message || "Signup failed";
        setMessage({ type: "error", text: msg });
        setLoading(false);
      }
    };

    useEffect(() => {
      setButtonDisabled(!(user.name && user.email && user.password));
    }, [user]);

    return (
      <div className="relative min-h-screen bg-[#020015] text-white overflow-hidden">
        {/* Contact-page style background */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_50%_0%,rgba(99,102,241,0.28),rgba(2,0,21,0)_70%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_15%_25%,rgba(236,72,153,0.20),rgba(2,0,21,0)_60%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(900px_500px_at_85%_30%,rgba(34,211,238,0.18),rgba(2,0,21,0)_60%)]" />
          <div className="absolute inset-x-0 bottom-0 h-64 bg-linear-to-b from-transparent to-[#020121]" />
        </div>

        {/* Loader overlay */}
        {loading && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
            <div className="flex flex-col items-center gap-4">
              <div className="h-12 w-12 animate-spin rounded-full border-4 border-white border-t-transparent" />
              <p className="text-lg text-white">Creating your account...</p>
            </div>
          </div>
        )}

        {/* content layer */}
        <div className="relative z-10 flex min-h-screen flex-col">
          <CommonNavbar />

          <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-6 pt-28 pb-12 sm:pt-32">
            {/* Heading like Contact SQRATCH */}
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
                Signup
              </h1>

              <p className="mt-3 text-[16px] sm:text-[18px] leading-[160%] text-[#ECECEC]/75">
                Create your account to get started
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
                  <div className="pb-5">
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
                          className="
                  mt-2 rounded-2xl
                  border-white/10 bg-black/30
                  text-white placeholder:text-white/40
                  focus-visible:ring-0 focus-visible:border-white/25
                "
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
                          value={user.email}
                          onChange={(e) =>
                            setUser({
                              ...user,
                              email: e.target.value.toLowerCase(),
                            })
                          }
                          className="
                  mt-2 rounded-2xl
                  border-white/10 bg-black/30
                  text-white placeholder:text-white/40
                  focus-visible:ring-0 focus-visible:border-white/25
                "
                        />
                      </div>

                      <div>
                        <Label
                          htmlFor="password"
                          className="pl-1 text-white/70"
                        >
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
                          className="
                  mt-2 rounded-2xl
                  border-white/10 bg-black/30
                  text-white placeholder:text-white/40
                  focus-visible:ring-0 focus-visible:border-white/25
                "
                        />
                      </div>
                    </div>
                  </div>
                </CardContent>

                <CardFooter className="flex flex-col gap-3 px-6 pb-0 sm:px-8">
                  <Button
                    type="submit"
                    disabled={buttonDisabled || loading}
                    className="
                      w-full rounded-full py-6
                      border border-white bg-white text-black
                      hover:scale-[1.01] active:scale-[0.99]
                      transition
                    "
                  >
                    Signup
                  </Button>

                  <Button
                    variant="link"
                    asChild
                    className="mt-4 text-white/70 hover:text-white"
                  >
                    <Link href="/login">Already have an account? Login</Link>
                  </Button>
                </CardFooter>
              </form>
            </Card>
          </main>

          <div className="pb-6 text-center text-white/55">
            © {new Date().getFullYear()} SQRATCH. All rights reserved.
          </div>
        </div>
      </div>
    );
  }
}
