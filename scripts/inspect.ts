// npm run inspect -- --request <id> — read-only snapshot of a request's
// clocks and engagements (service role; dev visibility into what the UI and
// cron see). Part of the F3 harness.
import { adminClient, fail, requireArg, requireSeedMode } from "./harness";

const USAGE = "npm run inspect -- --request <id>";

async function main() {
  requireSeedMode();
  const admin = adminClient();
  const requestId = requireArg("--request", USAGE);

  const { data: request } = await admin
    .from("test_requests")
    .select(
      "app_name, status, streak_days, clock_started_at, streak_ok_since, streak_last_counted_day, slots_needed, published_at",
    )
    .eq("id", requestId)
    .maybeSingle();
  if (!request) fail(`Request ${requestId} not found.`);

  const { data: slots } = await admin
    .from("request_slot_counts")
    .select("confirmed_count, occupied_count")
    .eq("request_id", requestId)
    .maybeSingle();

  const { data: engagements } = await admin
    .from("engagements")
    .select("status, tester_id, confirmed_at, opted_in_at, confirm_reminded_at")
    .eq("request_id", requestId);

  const byStatus = new Map<string, number>();
  for (const e of engagements ?? []) {
    byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
  }

  console.log(`"${request.app_name}" — ${request.status}`);
  console.log(
    `  streak_days=${request.streak_days}  clock_started=${request.clock_started_at ?? "—"}`,
  );
  console.log(
    `  streak_ok_since=${request.streak_ok_since ?? "—"}  last_counted=${request.streak_last_counted_day ?? "—"}`,
  );
  console.log(
    `  slots: ${slots?.occupied_count ?? 0}/${request.slots_needed} occupied, ${slots?.confirmed_count ?? 0} streak-counted`,
  );
  console.log(
    `  engagements: ${
      [...byStatus.entries()].map(([s, c]) => `${s}=${c}`).join(", ") || "none"
    }`,
  );
}

main();
