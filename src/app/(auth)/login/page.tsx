// app/login/page.tsx
"use client";

import React, { useEffect } from "react";
import Link from "next/link";
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
    <section className="relative min-h-screen bg-[url('/assets/homepage/home_bg.jpeg')] bg-cover bg-center">
      {/* dark overlay */}
      <div className="absolute inset-0 bg-black/75" />

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
        {/* Logo */}
        <div className="pt-8 flex justify-center">
          <Link href="/" className="inline-flex">
            <img
              src="/sqratchLogo.png"
              alt="SQRATCH"
              className="h-10 w-auto mx-auto translate-x-[0.15rem] sm:translate-x-0"
            />
          </Link>
        </div>

        {/* Login Form (centered) */}
        <div className="flex flex-1 items-center justify-center px-4 mx-4">
          <Card className="w-full max-w-sm rounded-2xl shadow-2xl">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onLogin();
              }}
            >
              <CardHeader>
                <CardTitle className="text-center text-3xl font-bold">
                  Login
                </CardTitle>
                <CardDescription>
                  {message && (
                    <div
                      className={`mt-2 text-center ${
                        message.type === "error"
                          ? "text-red-500"
                          : "text-green-500"
                      }`}
                    >
                      {message.text}
                    </div>
                  )}
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-5">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={user.email}
                    onChange={(e) =>
                      setUser({ ...user, email: e.target.value })
                    }
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={user.password}
                    onChange={(e) =>
                      setUser({ ...user, password: e.target.value })
                    }
                    className="mt-1"
                  />
                </div>
              </CardContent>

              <CardFooter className="flex flex-col mt-6">
                <Button
                  type="submit"
                  disabled={buttonDisabled || loading}
                  className="w-full bg-[#3b639a] text-white rounded-full py-3 hover:bg-[#6388bb] transition-colors"
                >
                  Login
                </Button>
              </CardFooter>
            </form>
          </Card>
        </div>

        {/* Footer */}
        <div className="pb-6 text-center text-gray-400">
          © {new Date().getFullYear()} SQRATCH. All rights reserved.
        </div>
      </div>
    </section>
  );
}
