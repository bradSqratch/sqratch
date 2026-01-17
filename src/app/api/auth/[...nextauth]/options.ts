import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import prisma from "@/lib/prisma"; // Your Prisma client setup
import bcrypt from "bcryptjs";

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
      async authorize(credentials: any): Promise<any> {
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
            };
          } else {
            throw new Error("Invalid email or password");
          }
        } catch (err: any) {
          throw new Error(err.message);
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
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // Add custom fields to the token
        token.id = user.id?.toString();
        token.role = user.role;
        token.isEmailVerified = user.isEmailVerified;
        token.email = user.email;
        token.isTemporary = user.isTemporary; // Add isTemporary field
      }
      return token;
    },
    async session({ session, token }) {
      // Add custom fields to the session
      if (token) {
        session.user.id = token.id;
        session.user.role = token.role;
        session.user.isEmailVerified = token.isEmailVerified;
        session.user.email = token.email;
        session.user.isTemporary = token.isTemporary; // Add isTemporary field
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET, // Use a secure secret
};
