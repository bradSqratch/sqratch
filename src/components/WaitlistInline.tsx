"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, Check } from "lucide-react";

export default function WaitlistInline({
  placeholder = "Enter your email",
  buttonLabel = "Join the Waitlist",
  onSubmit,
  className = "",
}: {
  placeholder?: string;
  buttonLabel?: string;
  onSubmit?: (email: string) => Promise<void> | void;
  className?: string;
}) {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    setIsLoading(true);
    setErrorMsg("");

    try {
      if (onSubmit) {
        await onSubmit(trimmed);
      }
      setIsSuccess(true);
      setEmail("");
    } catch (error: any) {
      console.error("Waitlist error:", error);
      setErrorMsg("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    // Align center so the success pill stays in the middle
    <div className={`flex flex-col items-center gap-2 ${className}`}>
      <AnimatePresence mode="wait">
        {isSuccess ? (
          /* SUCCESS STATE */
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="flex h-11 w-auto min-w-[180px] items-center justify-center gap-2 rounded-full border border-green-500/30 bg-green-500/10 text-green-100 backdrop-blur-md px-6 shadow-[0_0_20px_rgba(34,197,94,0.2)]"
          >
            <Check className="h-4 w-4" />
            <span className="font-medium">You're on the list!</span>
          </motion.div>
        ) : (
          /* FORM STATE */
          <motion.form
            key="form"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -10 }}
            className="
              flex w-full sm:w-auto
              flex-col items-stretch gap-3
              sm:flex-row sm:items-center
            "
            onSubmit={handleSubmit}
          >
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              disabled={isLoading}
              placeholder={placeholder}
              className={[
                "text-[16px] sm:text-[18px] w-full flex-1 rounded-full px-4 py-3 leading-none",
                "border border-white/25 bg-black/30 text-white placeholder:text-white/70",
                "backdrop-blur-md outline-none transition-colors",
                "focus:border-white/35 focus:ring-2 focus:ring-white/20",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              ].join(" ")}
            />

            <motion.button
              whileHover={!isLoading ? { scale: 1.02 } : {}}
              whileTap={!isLoading ? { scale: 0.98 } : {}}
              disabled={isLoading}
              type="submit"
              className={[
                "text-[16px] sm:text-[18px] shrink-0 rounded-full px-6 py-3 w-full sm:w-[180px] leading-none",
                "border border-white text-black bg-white",
                "backdrop-blur-md",
                "transition",
                "whitespace-nowrap inline-flex items-center justify-center gap-2",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              ].join(" ")}
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Joining...</span>
                </>
              ) : (
                buttonLabel
              )}
            </motion.button>
          </motion.form>
        )}
      </AnimatePresence>

      {/* Error Message */}
      {errorMsg && (
        <p className="ml-4 text-xs text-red-300 animate-pulse">{errorMsg}</p>
      )}
    </div>
  );
}
