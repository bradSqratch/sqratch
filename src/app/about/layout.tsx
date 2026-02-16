import type { Metadata } from "next";
import React from "react";

export const metadata: Metadata = {
  title: "About",
};

export default function AboutLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div>{children}</div>;
}
