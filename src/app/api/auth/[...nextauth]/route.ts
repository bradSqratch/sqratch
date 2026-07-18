import NextAuth from "next-auth";
import { authOptions } from "./options";
import { createAuthRouteHandler } from "@/lib/auth/auth-route-wrapper";

const handler = NextAuth(authOptions);

const authHandler = createAuthRouteHandler(handler);

export { authHandler as GET, authHandler as POST };
