export const AUTH_NO_STORE_CACHE_CONTROL = "no-store, max-age=0";

export function withAuthNoStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", AUTH_NO_STORE_CACHE_CONTROL);
  response.headers.set("Pragma", "no-cache");
  return response;
}
