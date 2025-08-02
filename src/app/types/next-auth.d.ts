import "next-auth";

declare module "next-auth" {
  interface User {
    id?: string;
    isEmailVerified?: boolean;
    email?: string;
    isTemporary?: boolean;
    role?: "USER" | "ADMIN";
  }

  interface Session {
    user: {
      id?: string;
      isEmailVerified?: boolean;
      email?: string;
      isTemporary?: boolean;
      role?: "USER" | "ADMIN";
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    isEmailVerified?: boolean;
    email?: string;
    role?: "USER" | "ADMIN";
  }
}
