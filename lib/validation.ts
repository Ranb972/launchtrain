// Shared validation primitives. Mirrors the DB CHECK constraints in
// supabase/migrations/20260612120000_initial_schema.sql so users get
// friendly errors before the database rejects bad data.

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const DISPLAY_NAME_MAX = 80;
export const ANDROID_VERSION_MIN = 1;
export const ANDROID_VERSION_MAX = 50;

export function parseAndroidVersion(raw: string): number | null {
  const n = Number(raw);
  if (
    !Number.isInteger(n) ||
    n < ANDROID_VERSION_MIN ||
    n > ANDROID_VERSION_MAX
  ) {
    return null;
  }
  return n;
}
