type UniqueConstraintShape = { index?: unknown; fields?: unknown };

function collectNames(value: unknown, into: string[]) {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectNames(entry, into));
}

/**
 * True when `error` is a unique-constraint violation (P2002) on `field`.
 *
 * With the PostgreSQL driver adapter Prisma no longer fills `meta.target`; the
 * violated constraint arrives in `meta.driverAdapterError.cause.constraint`
 * (for example `{ index: "User_email_key" }`). Older client shapes still use
 * `meta.target`. Both are checked so duplicate-key handling does not depend on
 * which shape the runtime produces.
 */
export function isUniqueViolationOn(error: unknown, field: string): boolean {
  const err = error as { code?: unknown; meta?: Record<string, unknown> } | null;
  if (!err || err.code !== "P2002") return false;

  const names: string[] = [];
  collectNames(err.meta?.target, names);
  const cause = (err.meta?.driverAdapterError as { cause?: { constraint?: UniqueConstraintShape } } | undefined)?.cause;
  collectNames(cause?.constraint?.index, names);
  collectNames(cause?.constraint?.fields, names);

  const pattern = new RegExp(`(^|[^A-Za-z0-9])${field}([^A-Za-z0-9]|$)`, "i");
  return names.some((name) => pattern.test(name));
}
