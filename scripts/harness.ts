// Shared helpers for the F3 dev/test harness (seed + timetravel + cron
// trigger scripts). These run OUTSIDE Next.js via `tsx --env-file=.env.local`
// (see package.json), talk to Supabase with the service role, and refuse to
// run without ALLOW_SEED=true — they are for development projects only.
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "../lib/supabase/types";

export const SEED_EMAIL_DOMAIN = "seed.launchtrain.local";
export const SEED_TESTER_COUNT = 15;
export const SEED_LOWSCORE_EMAIL = `lowscore@${SEED_EMAIL_DOMAIN}`;

export function seedEmail(i: number): string {
  return `tester${String(i).padStart(2, "0")}@${SEED_EMAIL_DOMAIN}`;
}

export function requireSeedMode(): void {
  if (process.env.ALLOW_SEED !== "true") {
    fail(
      "Refusing to run: set ALLOW_SEED=true in .env.local first (dev projects only).",
    );
  }
}

export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    fail(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — run through the npm scripts (they load .env.local).",
    );
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type Admin = ReturnType<typeof adminClient>;

export function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

export function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

export function requireArg(flag: string, usage: string): string {
  const value = argValue(flag);
  if (!value) fail(`Missing ${flag}. Usage: ${usage}`);
  return value;
}

export function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

export function jsonString(data: Json, key: string): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const v = (data as Record<string, Json | undefined>)[key];
  return typeof v === "string" ? v : null;
}

// Seeded testers (service-role read; bypasses RLS), ordered by email so
// tester01..tester15 join in a stable order. Excludes the low-score tester
// unless explicitly included.
export async function listSeedTesters(
  admin: Admin,
  opts: { includeLowscore?: boolean } = {},
) {
  const { data, error } = await admin
    .from("users")
    .select("id, email, display_name, reliability_score")
    .like("email", `%@${SEED_EMAIL_DOMAIN}`)
    .order("email");
  if (error) fail(`Could not list seed testers: ${error.message}`);
  const rows = data ?? [];
  return opts.includeLowscore
    ? rows
    : rows.filter((r) => r.email !== SEED_LOWSCORE_EMAIL);
}

export async function findSeedUserByEmail(admin: Admin, email: string) {
  const { data } = await admin
    .from("users")
    .select("id, email, display_name")
    .eq("email", email)
    .maybeSingle();
  return data;
}
