import React from "react";

export const metadata = {
  title: "Contact - SQRATCH",
};

export default function ContactLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="bootstrap-scoped">{children}</div>;
}
