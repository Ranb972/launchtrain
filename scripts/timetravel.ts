// npm run timetravel -- --request <id> --days <n>
// Shifts all clock-relevant timestamps of a request and its engagements BACK
// n days, so a 14-day streak is simulatable in minutes: timetravel 1 day +
// cron:daily = one streak day. Guarded by ALLOW_SEED=true.
import { pathToFileURL } from "node:url";
import {
  adminClient,
  fail,
  requireArg,
  requireSeedMode,
  type Admin,
} from "./harness";

const USAGE = "npm run timetravel -- --request <id> --days <n>";
const DAY_MS = 86_400_000;

function shiftTs(iso: string | null, days: number): string | null {
  return iso ? new Date(Date.parse(iso) - days * DAY_MS).toISOString() : null;
}

function shiftDate(date: string | null, days: number): string | null {
  return date
    ? new Date(Date.parse(date) - days * DAY_MS).toISOString().slice(0, 10)
    : null;
}

// Importable by the walkthrough. Returns the number of engagements shifted.
export async function timetravelRequest(
  admin: Admin,
  requestId: string,
  days: number,
): Promise<number> {
  const { data: request } = await admin
    .from("test_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();
  if (!request) fail(`Request ${requestId} not found.`);

  const { error: reqError } = await admin
    .from("test_requests")
    .update({
      published_at: shiftTs(request.published_at, days),
      clock_started_at: shiftTs(request.clock_started_at, days),
      streak_ok_since: shiftTs(request.streak_ok_since, days),
      streak_last_counted_day: shiftDate(request.streak_last_counted_day, days),
    })
    .eq("id", requestId);
  if (reqError) fail(`request update failed: ${reqError.message}`);

  const { data: engagements } = await admin
    .from("engagements")
    .select("*")
    .eq("request_id", requestId);

  let shifted = 0;
  for (const e of engagements ?? []) {
    const { error } = await admin
      .from("engagements")
      .update({
        joined_at: shiftTs(e.joined_at, days) ?? e.joined_at,
        opted_in_at: shiftTs(e.opted_in_at, days),
        confirmed_at: shiftTs(e.confirmed_at, days),
        completed_at: shiftTs(e.completed_at, days),
        last_checkin_at: shiftTs(e.last_checkin_at, days),
        ended_at: shiftTs(e.ended_at, days),
        replacement_requested_at: shiftTs(e.replacement_requested_at, days),
        confirm_reminded_at: shiftTs(e.confirm_reminded_at, days),
        checkin_reminded_at: shiftTs(e.checkin_reminded_at, days),
        feedback_mid_prompted_at: shiftTs(e.feedback_mid_prompted_at, days),
        feedback_final_prompted_at: shiftTs(e.feedback_final_prompted_at, days),
      })
      .eq("id", e.id);
    if (error) fail(`engagement ${e.id} update failed: ${error.message}`);
    shifted++;
  }

  // Check-in and feedback rows must move too: the once-per-UTC-day unique
  // index keys on checkins.created_at, so it has to stay consistent with the
  // shifted last_checkin_at (all rows move by the same delta — uniqueness is
  // preserved).
  const engagementIds = (engagements ?? []).map((e) => e.id);
  let shiftedCheckins = 0;
  if (engagementIds.length > 0) {
    const { data: checkins } = await admin
      .from("checkins")
      .select("id, created_at")
      .in("engagement_id", engagementIds);
    for (const c of checkins ?? []) {
      const { error } = await admin
        .from("checkins")
        .update({ created_at: shiftTs(c.created_at, days) ?? c.created_at })
        .eq("id", c.id);
      if (error) fail(`checkin ${c.id} update failed: ${error.message}`);
      shiftedCheckins++;
    }
    const { data: feedback } = await admin
      .from("feedback")
      .select("id, created_at")
      .in("engagement_id", engagementIds);
    for (const f of feedback ?? []) {
      const { error } = await admin
        .from("feedback")
        .update({ created_at: shiftTs(f.created_at, days) ?? f.created_at })
        .eq("id", f.id);
      if (error) fail(`feedback ${f.id} update failed: ${error.message}`);
    }
  }

  console.log(
    `✓ "${request.app_name}": request clocks, ${shifted} engagement(s), and ${shiftedCheckins} check-in(s) moved ${days} day(s) into the past.`,
  );
  return shifted;
}

async function main() {
  requireSeedMode();
  const admin = adminClient();

  const requestId = requireArg("--request", USAGE);
  const days = Number(requireArg("--days", USAGE));
  if (!Number.isInteger(days) || days < 1) {
    fail(`--days must be a positive integer. ${USAGE}`);
  }

  await timetravelRequest(admin, requestId, days);
  console.log("  Now run `npm run cron:daily` to let the streak math catch up.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
