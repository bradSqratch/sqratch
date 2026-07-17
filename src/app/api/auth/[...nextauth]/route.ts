import NextAuth from "next-auth";
import { authOptions } from "./options";
import {
  createAuthRequestContext,
  runWithAuthRequestContext,
} from "@/lib/auth/auth-security";
import { withAuthNoStore } from "@/lib/auth/auth-response";

const handler = NextAuth(authOptions);

async function authHandler(request: Request) {
  const context = createAuthRequestContext(request);
  return runWithAuthRequestContext(context, async () =>
    withAuthNoStore(await handler(request)),
  );
}

export { authHandler as GET, authHandler as POST };
