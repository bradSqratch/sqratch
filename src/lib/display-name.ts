export function publicDisplayName({ name }: { name?: string | null }): string {
  return name?.trim() || "SQRATCH member";
}
