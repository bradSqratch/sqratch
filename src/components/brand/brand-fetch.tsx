"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import { RequestError } from "@/components/experience/client-utils";

const LoadedBrandContext = createContext<{ id: string; name: string } | null>(null);

export function LoadedBrandProvider({ brand, children }: { brand: { id: string; name: string } | null; children: ReactNode }) {
  return <LoadedBrandContext.Provider value={brand}>{children}</LoadedBrandContext.Provider>;
}

export function useBrandRawFetch() {
  const brand = useContext(LoadedBrandContext);
  return useCallback(async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (brand && (init?.method || "GET").toUpperCase() !== "GET") {
      headers.set("x-sqratch-expected-brand", brand.id);
    }
    const response = await fetch(input, { credentials: "include", ...init, headers });
    if (response.status === 409) {
      const body = await response.clone().json().catch(() => null);
      if (body?.code === "BRAND_CONTEXT_MISMATCH") {
        const active = body.activeBrand?.name || body.activeBrand?.id || "another brand";
        throw new RequestError(`This page was opened for ${brand?.name || body.expectedBrandId}. The active brand is now ${active}. Reload to continue in ${active}, or switch back.`, 409, body.code);
      }
    }
    return response;
  }, [brand]);
}

export function useBrandFetch() {
  const rawFetch = useBrandRawFetch();
  return useCallback(async <T,>(input: string, init?: RequestInit): Promise<T> => {
    let response: Response;
    try { response = await rawFetch(input, init); }
    catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(error instanceof Error ? error.message : "Request failed.", null);
    }
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new RequestError(json?.error || "Request failed.", response.status, json?.code);
    if (json === null) throw new RequestError("Request failed.", response.status);
    return (json.data ?? json) as T;
  }, [rawFetch]);
}
