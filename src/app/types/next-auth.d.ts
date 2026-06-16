import type { DefaultSession } from "next-auth";
import "next-auth";

declare module "next-auth" {
  type AppRole = "USER" | "CREATOR" | "BRAND_ADMIN" | "ADMIN" | "EXTERNAL";

  interface User {
    id?: string;
    isEmailVerified?: boolean;
    email?: string;
    isTemporary?: boolean;
    role?: AppRole;
    imageUrl?: string | null;
  }

  interface Session {
    user: {
      id?: string;
      isEmailVerified?: boolean;
      email?: string;
      isTemporary?: boolean;
      role?: AppRole;
      imageUrl?: string | null;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    isEmailVerified?: boolean;
    email?: string;
    role?: "USER" | "CREATOR" | "BRAND_ADMIN" | "ADMIN" | "EXTERNAL";
    imageUrl?: string | null;
    isTemporary?: boolean;
    accountInvalidated?: boolean;
  }
}
