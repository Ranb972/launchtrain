// Test-request validation primitives (SPEC Flow 2, F2). Mirrors the DB CHECK
// constraints and the F2 publish/cancel functions so users get friendly
// errors before the database rejects bad data.

import type { Enums } from "@/lib/supabase/types";

export const CATEGORIES: Enums<"request_category">[] = [
  "games",
  "productivity",
  "social",
  "tools",
  "lifestyle",
  "education",
  "finance",
  "health",
  "other",
];

export const DESCRIPTION_MAX = 300;
export const INSTRUCTIONS_MAX = 1000;
export const SLOTS_MIN = 1;
export const SLOTS_MAX = 20;
export const SLOTS_DEFAULT = 14;
export const SLOTS_EXPLAINER =
  "Google requires 12 simultaneous testers. We recommend 14+ to absorb dropouts.";

export const OPT_IN_URL_PREFIX = "https://play.google.com/apps/testing/";
export const GROUP_URL_PREFIX = "https://groups.google.com/";

export const MAX_SCREENSHOTS = 4;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024; // storage bucket limit
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

// Android package name: dot-separated identifiers (Play requirement).
const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

// SPEC Flow 2 step 2: package_name is extracted from the opt-in URL, never
// entered by hand. Returns null when the URL or the embedded package is invalid.
export function extractPackageName(optInUrl: string): string | null {
  if (!optInUrl.startsWith(OPT_IN_URL_PREFIX)) return null;
  const pkg = optInUrl
    .slice(OPT_IN_URL_PREFIX.length)
    .split(/[/?#]/)[0]
    ?.trim();
  return pkg && PACKAGE_RE.test(pkg) ? pkg : null;
}

// Maps the LT_* error protocol raised by the F2 database functions
// (supabase/migrations/20260712130000_f2_publish_cancel.sql) to UI copy.
// Returns null for unrecognized errors so callers can fall back generically.
export function mapRequestFunctionError(message: string): string | null {
  if (message.includes("LT_INSUFFICIENT_CREDITS")) {
    const shortfall = message.match(/LT_INSUFFICIENT_CREDITS:(\d+)/)?.[1];
    return shortfall
      ? `You need ${shortfall} more credit${shortfall === "1" ? "" : "s"}.`
      : "You don't have enough credits.";
  }
  if (message.includes("LT_FOUNDING_CAP_REACHED")) {
    return "The founding cap was just reached — normal pricing now applies. Review the cost below and publish again.";
  }
  if (message.includes("LT_NOT_DRAFT")) {
    return "This request is already published.";
  }
  if (message.includes("LT_ALREADY_TERMINAL")) {
    return "This request is already closed.";
  }
  if (message.includes("LT_SLOTS_GROW_ONLY")) {
    return "Slots can be increased but never decreased.";
  }
  if (message.includes("LT_SLOTS_MAX_20")) {
    return "A request can have at most 20 slots.";
  }
  if (message.includes("LT_FROZEN_AFTER_PUBLISH")) {
    return "That field is frozen after publish. Cancel and republish to change it.";
  }
  if (message.includes("LT_NOT_PUBLISHED") || message.includes("LT_NOT_FOUND")) {
    return "Request not found.";
  }
  return null;
}
