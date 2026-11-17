"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthPageShell, authButtonClass, authInputClass } from "@/components/auth/auth-page-shell";
import { PASSWORD_POLICY_MESSAGE, validatePassword } from "@/lib/password-policy";

type Phase = "reading" | "no_token" | "form" | "done";

export default function ResetPasswordPage() {
  const [phase, setPhase] = useState<Phase>("reading");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkInvalid, setLinkInvalid] = useState(false);

  useEffect(() => {
    // The token is in the URL fragment, which the server never sees. Read it,
    // then remove it from the address bar and history entry.
    const match = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
    if (match) {
      setToken(decodeURIComponent(match[1]));
      setPhase("form");
      window.history.replaceState(null, "", window.location.pathname);
    } else {
      setPhase("no_token");
    }
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    const policy = validatePassword(password);
    if (policy) {
      setError(PASSWORD_POLICY_MESSAGE);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, confirmPassword }),
      });
      const json = await response.json().catch(() => null);
      if (response.ok) {
        setToken("");
        setPhase("done");
      } else if (response.status === 429) {
        setError("Too many attempts. Please wait a few minutes and try again.");
      } else if (response.status === 400 && json?.error && /reset link/i.test(json.error)) {
        setLinkInvalid(true);
        setError(json.error);
      } else {
        setError(json?.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "reading") {
    return <AuthPageShell title="Reset password">{null}</AuthPageShell>;
  }

  if (phase === "no_token" || linkInvalid) {
    return (
      <AuthPageShell title="Reset password">
        <div className="space-y-4 text-center">
          <p role="alert" className="text-red-700 dark:text-red-400">
            {error ?? "This reset link is invalid or has expired. Request a new one."}
          </p>
          <Link href="/forgot-password" className="text-sm text-ink underline">
            Request a new link
          </Link>
        </div>
      </AuthPageShell>
    );
  }

  if (phase === "done") {
    return (
      <AuthPageShell title="Password updated">
        <div className="space-y-4 text-center">
          <p role="status" className="text-green-700 dark:text-green-400">
            Your password has been changed and you have been signed out everywhere.
          </p>
          <Link href="/login" className="text-sm text-ink underline">
            Log in with your new password
          </Link>
        </div>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell title="Choose a new password" subtitle="Use at least 8 characters with a letter and a number.">
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {error ? (
          <p role="alert" className="text-center text-[14px] text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <div>
          <Label htmlFor="password" className="pl-1 text-copy-70">
            New password
          </Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={authInputClass}
          />
        </div>
        <div>
          <Label htmlFor="confirmPassword" className="pl-1 text-copy-70">
            Confirm new password
          </Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className={authInputClass}
          />
        </div>
        <Button type="submit" disabled={submitting || !password || !confirmPassword} className={authButtonClass}>
          {submitting ? "Saving..." : "Change password"}
        </Button>
      </form>
    </AuthPageShell>
  );
}
