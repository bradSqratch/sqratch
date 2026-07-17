export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;
export const PASSWORD_POLICY_MESSAGE =
  "Password must be 8-72 characters and include at least one letter and one number.";

export function isValidPassword(password: string) {
  return (
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH &&
    /[A-Za-z]/.test(password) &&
    /\d/.test(password)
  );
}

export function validatePassword(password: string) {
  return isValidPassword(password) ? null : PASSWORD_POLICY_MESSAGE;
}
