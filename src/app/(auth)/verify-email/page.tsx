"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import PublicHeader from "@/components/publicHeader";

export default function VerifyEmailPage() {
  const searchParams = useSearchParams();
  const emailVerifyToken = searchParams.get("token");
  const qrcodeID = searchParams.get("qrcodeID");

  const [isVerified, setIsVerified] = useState(false);
  const [loading, setLoading] = useState(false);

  // For success message
  const [campaignName, setCampaignName] = useState<string>("");

  // Fetch campaign name from DB (doesn't change your verify logic)
  useEffect(() => {
    const fetchCampaignName = async () => {
      if (!qrcodeID) return;
      try {
        const res = await axios.get<{ data: { name: string } }>(
          `/api/public/get-campaign-from-qrid?qrcodeID=${encodeURIComponent(
            qrcodeID
          )}`
        );
        setCampaignName(res.data?.data?.name || "");
      } catch {
        // If it fails, we just fall back to placeholder text
      }
    };
    fetchCampaignName();
  }, [qrcodeID]);

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
        <Card className="w-[90%] md:w-1/2 bg-white shadow-2xl z-10">
          <CardHeader className="flex justify-center">
            <img src="/sqratchLogo.png" alt="SQRATCH" className="h-7 w-auto" />
          </CardHeader>

          <CardContent className="text-center space-y-4">
            {isVerified ? (
              <>
                <div className="font-semibold text-[#3b639a]">
                  Your Invitation is Waiting!
                </div>
                <p className="text-sm">
                  Your exclusive invitation has been sent to your email. Be sure
                  to check your spam folder. <br />
                  <br /> See you on the other side!
                </p>
              </>
            ) : (
              <>
                <div className="font-semibold text-[#3b639a]">
                  Verification successful!
                </div>
                <p className="text-sm">
                  Click below to receive your exclusive invitation to{" "}
                  <span className="font-extrabold uppercase">
                    “{campaignName || "CAMPAIGN NAME"}”
                  </span>
                  .
                </p>
                <Button
                  onClick={verifyToken}
                  disabled={loading}
                  className="bg-[#3b639a] hover:bg-[#335689] rounded-md px-6"
                >
                  {loading ? "Loading..." : "Get Invite"}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
