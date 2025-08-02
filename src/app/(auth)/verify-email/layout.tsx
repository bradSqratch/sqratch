import React, { Suspense } from "react";

export const metadata = {
  title: "Verify Email - SQRATCH",
};

export default function VerifyEmailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <Suspense fallback={<div>Loading...</div>}>{children}</Suspense>;
}
