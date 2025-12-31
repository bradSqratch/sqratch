import type { Metadata } from "next";
import { Geist, Geist_Mono, Lexend_Giga, Montserrat } from "next/font/google";
import "./globals.css";
import AuthProvider from "@/context/AuthProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  weight: ["400", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const lexendGiga = Lexend_Giga({
  variable: "--font-lexend-giga",
  subsets: ["latin"],
  weight: ["700"],
});

const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Sqratch",
  description:
    "SQRATCH empowers brands and builders to create private, real-person communities.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <AuthProvider>
        <body
          className={`${geistSans.variable} ${geistMono.variable} ${lexendGiga.variable} ${montserrat.variable} font-sans antialiased app-bg`}
        >
          {children}
        </body>
      </AuthProvider>
    </html>
  );
}
