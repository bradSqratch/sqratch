import crypto from "node:crypto";

function getPepper() {
  const pepper = process.env.EMAIL_VERIFICATION_CODE_PEPPER?.trim();
  if (!pepper) {
    throw new Error("EMAIL_VERIFICATION_CODE_PEPPER is not configured");
  }
  return pepper;
}

export function generateEmailVerificationCode() {
  return String(crypto.randomInt(100000, 1000000));
}

export function hashEmailVerificationCode(email: string, code: string) {
  if (!/^\d{6}$/.test(code)) {
    throw new Error("Verification code must be six digits");
  }

  return crypto
    .createHmac("sha256", getPepper())
    .update(`sqratch-email-verification:v1:${email}:${code}`)
    .digest("hex");
}

export function compareEmailVerificationCodeHash(
  expectedHash: string,
  actualHash: string,
) {
  const expected = Buffer.from(expectedHash, "utf8");
  const actual = Buffer.from(actualHash, "utf8");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
