"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthPageShell, authButtonClass, authInputClass } from "@/components/auth/auth-page-shell";
import { isValidEmail } from "@/lib/email-validation";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (!isValidEmail(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json = await response.json().catch(() => null);
      if (response.ok) {
        setSentMessage(json?.data?.message ?? "If an account exists for that email address, we have sent a link to reset the password.");
      } else if (response.status === 429) {
        setError("Too many requests. Please wait a few minutes and try again.");
      } else {
        setError(json?.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthPageShell title="Forgot password" subtitle="Enter your email and we will send you a link to choose a new one.">
      {sentMessage ? (
        <div className="space-y-4 text-center">
          <p role="status" className="text-green-700 dark:text-green-400">
            {sentMessage}
          </p>
          <p className="text-sm text-copy-60">The link works once and expires in 30 minutes. Check your spam folder if it does not arrive.</p>
          <Link href="/login" className="text-sm text-ink underline">
            Back to login
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          {error ? (
            <p role="alert" className="text-center text-[14px] text-red-700 dark:text-red-400">
              {error}
            </p>
          ) : null}
          <div>
            <Label htmlFor="email" className="pl-1 text-copy-70">
              Email
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={authInputClass}
              aria-invalid={Boolean(error)}
            />
          </div>
          <Button type="submit" disabled={submitting || !email} className={authButtonClass}>
            {submitting ? "Sending..." : "Send reset link"}
          </Button>
          <p className="text-center text-sm text-copy-60">
            <Link href="/login" className="text-ink underline">
              Back to login
            </Link>
          </p>
        </form>
      )}
    </AuthPageShell>
  );
}
