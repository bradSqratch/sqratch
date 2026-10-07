export type ClickMintStage = "viewer_session" | "token_generation" | "token_hash" | "ip_hash" | "session_lookup" | "attribution_create";

// Allow-list only. Prisma names/messages/meta can contain SQL and parameter values.
const SAFE_CODES = new Set(["P1000", "P1001", "P1002", "P1008", "P1017", "P2002", "P2003", "P2021", "P2022", "P2024", "P2025"]);

export function clickMintErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && SAFE_CODES.has(code) ? code : "UNCLASSIFIED";
}

export class ClickMintFailure extends Error {
  readonly code: string;
  constructor(readonly stage: ClickMintStage, error: unknown) {
    super("Click attribution storage failed.");
    this.code = clickMintErrorCode(error);
  }
}
