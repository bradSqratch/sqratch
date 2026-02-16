import type { Metadata } from "next";
import React, { Suspense } from "react";

export const metadata: Metadata = {
  title: "Verify Email",
};

export default function VerifyEmailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <Suspense fallback={<div>Loading...</div>}>{children}</Suspense>;
}
