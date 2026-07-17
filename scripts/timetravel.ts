// npm run timetravel -- --request <id> --days <n>
// Shifts all clock-relevant timestamps of a request and its engagements BACK
// n days, so a 14-day streak is simulatable in minutes: timetravel 1 day +
// cron:daily = one streak day. Guarded by ALLOW_SEED=true.
import {
  adminClient,
  fail,
  requireArg,
  requireSeedMode,
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

async function main() {
  requireSeedMode();
  const admin = adminClient();

  const requestId = requireArg("--request", USAGE);
  const days = Number(requireArg("--days", USAGE));
  if (!Number.isInteger(days) || days < 1) {
    fail(`--days must be a positive integer. ${USAGE}`);
  }

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
      })
      .eq("id", e.id);
    if (error) fail(`engagement ${e.id} update failed: ${error.message}`);
    shifted++;
  }

  console.log(
    `✓ "${request.app_name}": request clocks and ${shifted} engagement(s) moved ${days} day(s) into the past.\n` +
      `  Now run \`npm run cron:daily\` to let the streak math catch up.`,
  );
}

main();
