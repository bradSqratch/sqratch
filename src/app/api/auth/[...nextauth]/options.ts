import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import prisma from "@/lib/prisma"; // Your Prisma client setup
import bcrypt from "bcryptjs";
import { hasPendingApproval } from "@/lib/approval-gating";
import { logCredentialLoginEvent } from "@/lib/auth/auth-security";

class ExpectedCredentialLoginFailure extends Error {}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  providers: [
    CredentialsProvider({
      id: "credentials",
      name: "Credentials",
      credentials: {
        email: {
          label: "Email:",
          type: "text",
          placeholder: "your-cool-username",
        },
        password: {
          label: "Password:",
          type: "password",
          placeholder: "your-awesome-password",
        },
      },
      async authorize(
        credentials?: Record<"email" | "password", string> | undefined,
      ) {
        const email = String(credentials?.email || "")
          .trim()
          .toLowerCase();
        const password = String(credentials?.password || "");

        try {
          // Find user in database
          const user = await prisma.user.findUnique({
            where: { email },
          });

          if (!user || !user.password) {
            logCredentialLoginEvent("invalid_credentials", email);
            throw new ExpectedCredentialLoginFailure(
              "Invalid email or password",
            );
          }

          // For permanent users, check if the email is verified
          if (!user.isEmailVerified) {
            logCredentialLoginEvent("email_unverified", email);
            throw new ExpectedCredentialLoginFailure(
              "Please verify your email address first.",
            );
          }

          if (user.role !== "ADMIN" && (await hasPendingApproval(user.id))) {
            logCredentialLoginEvent("approval_pending", email);
            throw new ExpectedCredentialLoginFailure(
              "Wait for your approval from the admin. You will be notified via email once approved.",
            );
          }

          // Verify password
          const isPasswordCorrect = await bcrypt.compare(
            password,
            user.password
          );

          if (isPasswordCorrect) {
            logCredentialLoginEvent("success", email);
            return {
              id: user.id,
              email: user.email,
              name: user.name,
              role: user.role,
              isEmailVerified: user.isEmailVerified,
              imageUrl: user.imageUrl,
              sessionVersion: user.sessionVersion,
            };
          } else {
            logCredentialLoginEvent("invalid_credentials", email);
            throw new ExpectedCredentialLoginFailure(
              "Invalid email or password",
            );
          }
        } catch (error: unknown) {
          if (error instanceof ExpectedCredentialLoginFailure) {
            throw new Error(error.message);
          }

          logCredentialLoginEvent("system_error", email);
          throw new Error("Unable to complete sign in.");
        }
      },
    }),
  ],
  pages: {
    signIn: "/login", // Custom login page
    // signUp: "/signup", // Optional, for signup page
    newUser: "/",
  },
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 24 * 7,
  },
  jwt: {
    maxAge: 60 * 60 * 24 * 7,
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // Initial sign-in: write all fields into the token.
        token.id = user.id?.toString();
        token.role = user.role;
        token.isEmailVerified = user.isEmailVerified;
        token.email = user.email;
        token.imageUrl = user.imageUrl;
        token.sessionVersion = user.sessionVersion;
        token.isTemporary = user.isTemporary;
        token.isActive = true; // newly signed-in users are always active
        token.roleCheckedAt = Date.now();
      } else {
        // Session revocation is checked on every JWT callback. Tokens created
        // before sessionVersion existed are treated as version zero.
        try {
          const fresh = await prisma.user.findUnique({
            where: { id: token.id as string },
            select: {
              role: true,
              isActive: true,
              isEmailVerified: true,
              sessionVersion: true,
            },
          });
          const versionMismatch =
            typeof fresh?.sessionVersion === "number" &&
            (token.sessionVersion ?? 0) !== fresh.sessionVersion;
          if (!fresh || !fresh.isActive || versionMismatch) {
            token.accountInvalidated = true;
            delete token.id;
            delete token.role;
            delete token.email;
            return token;
          }
          delete token.accountInvalidated;
          token.role = fresh.role;
          token.isActive = fresh.isActive;
          token.isEmailVerified = fresh.isEmailVerified;
          if (typeof fresh.sessionVersion === "number") {
            token.sessionVersion = fresh.sessionVersion;
          }
          token.roleCheckedAt = Date.now();
        } catch {
          token.accountInvalidated = true;
          delete token.id;
          delete token.role;
          delete token.email;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token.accountInvalidated) {
        return {
          ...session,
          user: undefined,
        };
      }

      if (token) {
        session.user.id = token.id;
        session.user.role = token.role;
        session.user.isEmailVerified = token.isEmailVerified;
        session.user.email = token.email;
        session.user.imageUrl = token.imageUrl;
        session.user.image = token.imageUrl || session.user.image;
        session.user.sessionVersion = token.sessionVersion;
        session.user.isTemporary = token.isTemporary;
        // isActive is checked server-side; expose it so middleware can gate routes
        (session.user as Record<string, unknown>).isActive = token.isActive;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET, // Use a secure secret
};
