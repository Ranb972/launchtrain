// The screenshots bucket is public (SPEC §7: request pages are public/SEO);
// rows store bucket-relative paths, pages render them via this helper.

export function screenshotPublicUrl(path: string): string {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/screenshots/${path}`;
}

// devices/screenshots jsonb column → string[] (defensive: jsonb is untyped).
export function screenshotPaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((p): p is string => typeof p === "string")
    : [];
}
