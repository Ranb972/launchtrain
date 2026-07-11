// Shared validation primitives. Mirrors the DB CHECK constraints in
// supabase/migrations/ (initial schema + device constraints) so users get
// friendly errors before the database rejects bad data.

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const DISPLAY_NAME_MAX = 80;

// devices.android_version: Android 8.0 (Oreo) through a generous future
// ceiling. Device data drives tester eligibility (Flow 3) and the Dossier's
// Device Coverage Matrix, so out-of-range versions are rejected in the form,
// the server action, and a DB CHECK.
export const ANDROID_VERSION_MIN = 8;
export const ANDROID_VERSION_MAX = 30;
export const ANDROID_VERSION_ERROR = `Android version must be between ${ANDROID_VERSION_MIN} and ${ANDROID_VERSION_MAX}.`;

// LaunchTrain is Google Play-only (SPEC §1): manufacturer is a curated select;
// "Other" reveals a required free-text input for the long tail.
export const DEVICE_MANUFACTURERS = [
  "Samsung",
  "Google",
  "Xiaomi",
  "OnePlus",
  "Oppo",
  "Vivo",
  "Motorola",
  "Huawei",
  "Honor",
  "Realme",
  "Nothing",
  "Sony",
  "Asus",
] as const;

export const MANUFACTURER_OTHER = "Other";

// Rejected server-side regardless of what the UI sends.
export const NON_ANDROID_MANUFACTURER_RE = /apple|iphone|ipad|ios/i;
export const NON_ANDROID_MANUFACTURER_ERROR =
  "LaunchTrain is for Google Play apps — Android devices only.";

// Resolves the manufacturer select + "Other" free-text pair to a final value.
// Returns null when the pair is invalid (nothing selected, or "Other" without
// the free-text value). The free-text field is ignored unless "Other" is chosen.
export function resolveManufacturer(
  choice: string,
  other: string,
): string | null {
  const selected = choice.trim();
  if (!selected) return null;
  if (selected === MANUFACTURER_OTHER) {
    const custom = other.trim();
    return custom || null;
  }
  return selected;
}

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
