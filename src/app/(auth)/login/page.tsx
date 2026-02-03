// app/login/page.tsx
"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { signIn, useSession, getSession } from "next-auth/react";
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

type Message = { type: "error" | "success"; text: string };

export default function LoginPage() {
  const router = useRouter();

  const [user, setUser] = React.useState({ email: "", password: "" });
  const [buttonDisabled, setButtonDisabled] = React.useState(true);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState<Message | null>(null);
  const { data: session } = useSession();

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
      // Check if user is ADMIN before login
      const roleRes = await fetch("/api/auth/check-roles-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email }),
      });

      const roleData = await roleRes.json();

      // if (!roleRes.ok || roleData.role !== "ADMIN") {
      //   setMessage({
      //     type: "error",
      //     text: "Only ADMIN users are allowed to log in.",
      //   });
      //   setLoading(false);
      //   return;
      // }

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
      const res = await fetch("/api/auth/send-verification", {
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

  const checkSession = async () => {
    const sess = await getSession();
    if (sess?.user) {
      const { role, isEmailVerified, email } = sess.user;

      if (!isEmailVerified) {
        setMessage({
          type: "error",
          text: (
            <>
              Your email is not verified.{" "}
              <button
                onClick={() => ReSendVerificationEmail(email)}
                className="text-blue-500 underline"
              >
                Click here to resend verification email.
              </button>
            </>
          ) as any,
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

      setMessage({ type: "success", text: "Login successful! Redirecting…" });
      setTimeout(() => {
        router.push("/dashboard");
      }, 600);
    } else {
      // retry briefly
      setTimeout(checkSession, 500);
    }
  };

  useEffect(() => {
    setButtonDisabled(!(user.email && user.password));
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
            <div className="w-12 h-12 border-4 border-white border-t-transparent rounded-full animate-spin" />
            <p className="text-white text-lg">Validating credentials...</p>
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
                bg-[linear-gradient(145.55deg,#ECECEC_20.35%,rgba(236,236,236,0)_128.73%)]
                bg-clip-text text-transparent
                drop-shadow-[0_0_12px_rgba(236,236,236,0.50)]
              "
            >
              Login
            </h1>

            <p className="mt-3 text-[16px] sm:text-[18px] leading-[160%] text-[#ECECEC]/75">
              Login to access your dashboard
            </p>
          </div>

          {/* Outer card matches Contact outer glass */}
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
                          ? "text-red-400"
                          : "text-green-400"
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
                      <Label htmlFor="email" className="pl-1 text-white/70">
                        Email
                      </Label>
                      <Input
                        id="email"
                        type="email"
                        autoComplete="email"
                        value={user.email}
                        onChange={(e) =>
                          setUser({ ...user, email: e.target.value })
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
                      <Label htmlFor="password" className="pl-1 text-white/70">
                        Password
                      </Label>
                      <Input
                        id="password"
                        type="password"
                        autoComplete="current-password"
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

              <CardFooter className="flex flex-col gap-3 pb-4 px-6 sm:px-8">
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
                  Login
                </Button>
              </CardFooter>
            </form>
          </Card>
        </main>

        {/* Footer */}
        <div className="pb-6 text-center text-white/55">
          © {new Date().getFullYear()} SQRATCH. All rights reserved.
        </div>
      </div>
    </div>
  );
}
