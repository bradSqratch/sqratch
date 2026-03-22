import "next-auth";

declare module "next-auth" {
  type AppRole = "USER" | "CREATOR" | "BRAND_ADMIN" | "ADMIN" | "EXTERNAL";

  interface User {
    id?: string;
    isEmailVerified?: boolean;
    email?: string;
    isTemporary?: boolean;
    role?: AppRole;
  }

  interface Session {
    user: {
      id?: string;
      isEmailVerified?: boolean;
      email?: string;
      isTemporary?: boolean;
      role?: AppRole;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    isEmailVerified?: boolean;
    email?: string;
    role?: "USER" | "CREATOR" | "BRAND_ADMIN" | "ADMIN" | "EXTERNAL";
  }
}
