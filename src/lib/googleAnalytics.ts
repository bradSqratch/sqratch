export function gaEvent(event: string, params?: Record<string, any>) {
  if (typeof window === "undefined") return;
  // @ts-ignore
  if (!window.gtag) return;

  // @ts-ignore
  window.gtag("event", event, params || {});
}
