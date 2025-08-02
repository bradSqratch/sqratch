"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

export default function VerifyEmailPage() {
  const searchParams = useSearchParams();
  const emailVerifyToken = searchParams.get("token");
  const [isVerified, setIsVerified] = useState(false);
  const [loading, setLoading] = useState(false);

  const verifyToken = async () => {
    try {
      setLoading(true);
      const response = await axios.post("/api/users/verify-email", {
        emailVerifyToken,
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
    <div className="flex items-center justify-center min-h-screen">
      <Card className="w-[400px]">
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
    </div>
  );
}
