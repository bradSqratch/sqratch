"use client";

import React from "react";
import { motion } from "framer-motion";

type FadeVariant = "eyebrow" | "heading" | "supporting-text" | "card";

const VARIANTS = {
  "eyebrow": {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.4, ease: "easeOut" }
  },
  "heading": {
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.5, ease: "easeOut", delay: 0.05 }
  },
  "supporting-text": {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: 0.5, ease: "easeOut", delay: 0.12 }
  },
  "card": {
    initial: { opacity: 0, y: 16, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1 },
    transition: { duration: 0.55, ease: "easeOut", delay: 0.18 }
  }
};

export function PageFade({ 
  variant, 
  children, 
  className,
  as = "div" 
}: { 
  variant: FadeVariant; 
  children: React.ReactNode;
  className?: string;
  as?: "div" | "p" | "h1" | "article" | "section";
}) {
  const props = VARIANTS[variant];
  const Component = motion[as] as React.ElementType;
  
  return (
    <Component className={className} {...props}>
      {children}
    </Component>
  );
}
