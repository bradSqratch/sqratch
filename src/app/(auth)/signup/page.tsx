// src/app/(auth)/signup/page.tsx
"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
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
  const router = useRouter();

  const [user, setUser] = React.useState({
    name: "",
    email: "",
    password: "",
  });

  const [buttonDisabled, setButtonDisabled] = React.useState(true);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState<Message | null>(null);

  const onSignup = async () => {
    setMessage(null);

    if (!user.name || !user.email || !user.password) {
      setMessage({ type: "error", text: "All fields are required." });
      return;
    }

    setLoading(true);
    try {
      const res = await axios.post("/api/users/signup", user);

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
    <section className="relative min-h-screen bg-[url('/assets/homepage/home_bg.jpeg')] bg-cover bg-center">
      {/* dark overlay */}
      <div className="absolute inset-0 bg-black/75" />

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

        <div className="flex flex-1 items-center justify-center px-4 mx-4">
          <Card className="w-full max-w-sm rounded-2xl shadow-2xl">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onSignup();
              }}
            >
              <CardHeader>
                <CardTitle className="text-center text-3xl font-bold">
                  Signup
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
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    type="text"
                    autoComplete="name"
                    value={user.name}
                    onChange={(e) => setUser({ ...user, name: e.target.value })}
                    className="mt-1"
                  />
                </div>

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
                    autoComplete="new-password"
                    value={user.password}
                    onChange={(e) =>
                      setUser({ ...user, password: e.target.value })
                    }
                    className="mt-1"
                  />
                </div>
              </CardContent>

              <CardFooter className="flex flex-col mt-6 gap-3">
                <Button
                  type="submit"
                  disabled={buttonDisabled || loading}
                  className="w-full bg-[#3E93DE] text-white rounded-full py-3 hover:bg-[#6388bb] transition-colors"
                >
                  Signup
                </Button>

                <Button variant="link" asChild className="text-blue-500">
                  <Link href="/login">Already have an account? Login</Link>
                </Button>
              </CardFooter>
            </form>
          </Card>
        </div>

        <div className="pb-6 text-center text-gray-400">
          © {new Date().getFullYear()} SQRATCH. All rights reserved.
        </div>
      </div>
    </section>
  );
}
