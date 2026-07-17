// npm run seed:confirm -- --request <id> [--count <n>] [--tester <email>]
// The request owner confirms pending testers through the REAL confirm path
// (seed_confirm_engagement → confirm_engagement_impl: the ≥12 crossing sets
// the Google clock exactly like a UI confirm). Defaults to confirming ALL
// pending engagements; --tester targets one (e.g. Ran's own join on the seed
// request — pass your login email).
import {
  adminClient,
  argValue,
  fail,
  requireArg,
  requireSeedMode,
} from "./harness";

const USAGE =
  "npm run seed:confirm -- --request <id> [--count <n>] [--tester <email>]";

async function main() {
  requireSeedMode();
  const admin = adminClient();

  const requestId = requireArg("--request", USAGE);
  const testerEmail = argValue("--tester");
  const countArg = argValue("--count");
  const count = countArg ? Number(countArg) : Infinity;
  if (countArg && (!Number.isInteger(count) || count < 1)) {
    fail(`--count must be a positive integer. ${USAGE}`);
  }

  const { data: request } = await admin
    .from("test_requests")
    .select("id, app_name, slots_needed")
    .eq("id", requestId)
    .maybeSingle();
  if (!request) fail(`Request ${requestId} not found.`);

  const { data: pending } = await admin
    .from("engagements")
    .select("id, tester_id, joined_at")
    .eq("request_id", requestId)
    .eq("status", "pending_developer")
    .order("joined_at");
  let rows = pending ?? [];

  if (testerEmail) {
    const { data: tester } = await admin
      .from("users")
      .select("id")
      .eq("email", testerEmail)
      .maybeSingle();
    if (!tester) fail(`User ${testerEmail} not found.`);
    rows = rows.filter((r) => r.tester_id === tester.id);
  }
  if (rows.length === 0) {
    fail(`No pending engagements to confirm on "${request.app_name}".`);
  }

  let confirmed = 0;
  for (const row of rows) {
    if (confirmed >= count) break;
    const { error } = await admin.rpc("seed_confirm_engagement", {
      eng: row.id,
    });
    if (error) {
      console.log(`✗ engagement ${row.id}: ${error.message}`);
      continue;
    }
    confirmed++;
  }

  const { data: slots } = await admin
    .from("request_slot_counts")
    .select("confirmed_count")
    .eq("request_id", requestId)
    .maybeSingle();
  const total = slots?.confirmed_count ?? 0;
  console.log(
    `✓ confirmed ${confirmed} tester(s) on "${request.app_name}" — ${total} confirmed total` +
      (total >= 12 ? ". The Google clock is running (12+ reached)." : "."),
  );
}

main();
