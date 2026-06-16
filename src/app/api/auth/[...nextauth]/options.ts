import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import prisma from "@/lib/prisma"; // Your Prisma client setup
import bcrypt from "bcryptjs";
import { hasPendingApproval } from "@/lib/approval-gating";

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
        try {
          const email = String(credentials?.email || "")
            .trim()
            .toLowerCase();
          const password = String(credentials?.password || "");

          // Find user in database
          const user = await prisma.user.findUnique({
            where: { email },
          });

          if (!user || !user.password) {
            throw new Error("Invalid email or password");
          }

          // For permanent users, check if the email is verified
          if (!user.isEmailVerified) {
            throw new Error("Please verify your email address first.");
          }

          if (user.role !== "ADMIN" && (await hasPendingApproval(user.id))) {
            throw new Error(
              "Wait for your approval from the admin. You will be notified via email once approved.",
            );
          }

          // Verify password
          const isPasswordCorrect = await bcrypt.compare(
            password,
            user.password
          );

          if (isPasswordCorrect) {
            return {
              id: user.id,
              email: user.email,
              name: user.name,
              role: user.role,
              isEmailVerified: user.isEmailVerified,
              imageUrl: user.imageUrl,
            };
          } else {
            throw new Error("Invalid email or password");
          }
        } catch (error: unknown) {
          const message =
            error instanceof Error
              ? error.message
              : "Unable to complete sign in.";
          throw new Error(message);
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
        token.isTemporary = user.isTemporary;
        token.isActive = true; // newly signed-in users are always active
        token.roleCheckedAt = Date.now();
      } else {
        // Subsequent requests: re-read role and isActive every 5 minutes.
        const RECHECK_MS = 5 * 60 * 1000;
        const lastCheck = (token.roleCheckedAt as number | undefined) ?? 0;
        if (Date.now() - lastCheck > RECHECK_MS) {
          try {
            const fresh = await prisma.user.findUnique({
              where: { id: token.id as string },
              select: { role: true, isActive: true, isEmailVerified: true },
            });
            if (!fresh || !fresh.isActive) {
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
            token.roleCheckedAt = Date.now();
          } catch {
            // On DB error keep the existing token rather than signing out.
          }
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
        session.user.isTemporary = token.isTemporary;
        // isActive is checked server-side; expose it so middleware can gate routes
        (session.user as Record<string, unknown>).isActive = token.isActive;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET, // Use a secure secret
};
