import {
  createAuthRequestContext,
  runWithAuthRequestContext,
} from "@/lib/auth/auth-security";
import { withAuthNoStore } from "@/lib/auth/auth-response";

export type NextAuthRouteContext = {
  params: {
    nextauth: string[];
  };
};

export type NextAuthRequestHandler = (
  request: Request,
  routeContext: NextAuthRouteContext,
) => Promise<Response>;

type AuthRouteWrapperDependencies = {
  createAuthRequestContext: typeof createAuthRequestContext;
  runWithAuthRequestContext: typeof runWithAuthRequestContext;
  withAuthNoStore: typeof withAuthNoStore;
};

const defaultDependencies: AuthRouteWrapperDependencies = {
  createAuthRequestContext,
  runWithAuthRequestContext,
  withAuthNoStore,
};

export function createAuthRouteHandler(
  nextAuthHandler: NextAuthRequestHandler,
  dependencies: AuthRouteWrapperDependencies = defaultDependencies,
) {
  return async function authRouteHandler(
    request: Request,
    routeContext: NextAuthRouteContext,
  ) {
    const context = dependencies.createAuthRequestContext(request);

    return dependencies.runWithAuthRequestContext(context, async () =>
      dependencies.withAuthNoStore(
        await nextAuthHandler(request, routeContext),
      ),
    );
  };
}
