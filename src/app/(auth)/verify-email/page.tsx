"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import Link from "next/link";
import PublicHeader from "@/components/publicHeader";

export default function VerifyEmailPage() {
  const searchParams = useSearchParams();
  const emailVerifyToken = searchParams.get("token");
  const qrcodeID = searchParams.get("qrcodeID");
  const [isVerified, setIsVerified] = useState(false);
  const [loading, setLoading] = useState(false);

  const verifyToken = async () => {
    try {
      setLoading(true);
      const response = await axios.post("/api/users/verify-email", {
        emailVerifyToken,
        qrcodeID,
      });
      toast.success("Success", { description: response.data.message });
      setIsVerified(true);
    } catch (error: any) {
      toast.error("Error", {
        description: error.response?.data?.error || "Failed to verify email.",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[url('/assets/homepage/home_bg.jpeg')] bg-cover bg-center">
      <PublicHeader />

      <main className="flex-1 flex items-center justify-center p-4">
        <Card className="w-[400px] bg-white shadow-2xl z-10">
          <CardHeader>
            <CardTitle>
              {isVerified ? "Email Verified" : "Verify Email"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isVerified ? (
              <p>Email verified successfully!</p>
            ) : (
              <Button onClick={verifyToken} disabled={loading}>
                {loading ? "Loading..." : "Verify Email"}
              </Button>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
