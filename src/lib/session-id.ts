export function isValidSessionId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{48}$/i.test(value);
}
