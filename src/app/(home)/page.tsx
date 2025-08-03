"use client";

import React, { useEffect, useState, useCallback } from "react";
import axios from "axios";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import PublicHeader from "@/components/publicHeader";

export default function GuestQueuePage() {
  return (
    <div
      className="min-h-screen flex flex-col relative
       bg-[url('/assets/homepage/home_bg.jpeg')]
       bg-cover bg-center"
    >
      {/* Header
      <header className="flex items-center justify-between p-4 bg-black shadow">
        <Link href="/">
          <img
            src="/sqratchLogo.png"
            alt="SQRATCH Logo"
            className="h-10 w-auto"
          />
        </Link>
        <Link href="/login">
          <Button
            variant="ghost"
            className="text-amber-100 border-amber-100 border-1 hover:bg-amber-100"
          >
            Admin Login
          </Button>
        </Link>
      </header> */}

      <PublicHeader showAdminLogin />

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center p-8">
        <Card className="w-full max-w-4xl bg-[#ffffff] shadow-2xl z-10">
          <CardContent>
            <div className="text-center">
              <h2 className="text-2xl font-bold mb-4">Welcome to SQRATCH</h2>
              <p className="text-gray-600 mb-6">
                Experience the best closed communities with SQRATCH.
              </p>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
