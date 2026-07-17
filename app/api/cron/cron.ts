import { NextResponse } from "next/server";
import { dispatchNotificationEmails, notificationsFromResult } from "@/lib/email";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

// Shared handler for /api/cron/* (SPEC §5/§7). Guarded by CRON_SECRET:
// Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" on GET; the local
// harness (npm run cron:*) POSTs with the same header. Fails closed when the
// secret is unconfigured.
export async function runCron(
  request: Request,
  fn: "run_daily_clocks" | "run_confirm_reminders",
): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc(fn);
  if (error) {
    console.error(`[cron] ${fn} failed:`, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const notifications = notificationsFromResult(data);
  await dispatchNotificationEmails(notifications);

  // Return the summary counters; notification payloads stay server-side.
  const summary: Record<string, Json> = {};
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) {
      if (key !== "notifications" && value !== undefined) summary[key] = value;
    }
  }
  summary.notifications_created = notifications.length;

  return NextResponse.json({ ok: true, ...summary });
}
