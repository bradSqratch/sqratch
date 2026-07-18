import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAuthRouteHandler,
  type NextAuthRouteContext,
} from "../src/lib/auth/auth-route-wrapper";

const routeContext: NextAuthRouteContext = {
  params: { nextauth: ["signin"] },
};

test("forwards the Request and route context, including params.nextauth", async () => {
  const request = new Request("http://localhost/api/auth/signin", {
    method: "GET",
  });
  const response = new Response("ok");
  let receivedRequest: Request | null = null;
  let receivedContext!: NextAuthRouteContext;

  const wrapped = createAuthRouteHandler(async (received, context) => {
    receivedRequest = received;
    receivedContext = context;
    return response;
  });

  const result = await wrapped(request, routeContext);
  assert.equal(receivedRequest, request);
  assert.deepEqual(receivedContext, routeContext);
  assert.deepEqual(receivedContext.params.nextauth, ["signin"]);
  assert.equal(result, response);
  assert.equal(result.headers.get("Cache-Control"), "no-store, max-age=0");
  assert.equal(result.headers.get("Pragma"), "no-cache");
});

test("the wrapper cannot regress to a Request-only underlying call", async () => {
  const request = new Request("http://localhost/api/auth/callback");
  const calls: unknown[][] = [];

  const wrapped = createAuthRouteHandler(async (...args) => {
    calls.push(args);
    return new Response(null, { status: 204 });
  });

  await wrapped(request, {
    params: { nextauth: ["callback", "credentials"] },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.length, 2);
  assert.equal(calls[0]?.[0], request);
  assert.deepEqual(calls[0]?.[1], {
    params: { nextauth: ["callback", "credentials"] },
  });
});

test("GET and POST route exports share the corrected wrapper", async () => {
  process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";
  process.env.NEXTAUTH_SECRET ||= "auth-route-wrapper-test-secret";

  const route = await import("../src/app/api/auth/[...nextauth]/route");

  assert.equal(route.GET, route.POST);
  assert.equal(typeof route.GET, "function");
  assert.equal(typeof route.POST, "function");
});

test("request context and no-store dependencies remain in the wrapper flow", async () => {
  const request = new Request("http://localhost/api/auth/session");
  const response = new Response("session");
  const calls: string[] = [];
  const context = { requestId: "request-id" };

  const wrapped = createAuthRouteHandler(
    async () => {
      calls.push("handler");
      return response;
    },
    {
      createAuthRequestContext: (receivedRequest) => {
        calls.push(receivedRequest === request ? "create-context" : "wrong-request");
        return context;
      },
      runWithAuthRequestContext: async (receivedContext, callback) => {
        calls.push(receivedContext === context ? "run-context" : "wrong-context");
        return callback();
      },
      withAuthNoStore: (receivedResponse) => {
        calls.push(receivedResponse === response ? "no-store" : "wrong-response");
        return receivedResponse;
      },
    },
  );

  await wrapped(request, routeContext);

  assert.deepEqual(calls, ["create-context", "run-context", "handler", "no-store"]);
});
