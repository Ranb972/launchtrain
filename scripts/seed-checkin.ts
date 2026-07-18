// npm run seed:checkin -- --request <id> [--count <n>] [--issue] [--tester <email>]
// Seeded testers check in today through the REAL path (seed_create_checkin →
// create_checkin_impl: once-per-UTC-day, at_risk recovery, reminder re-arm).
// --issue reports an issue with an auto note instead of "works fine".
import {
  adminClient,
  argValue,
  fail,
  hasFlag,
  requireArg,
  requireSeedMode,
  SEED_EMAIL_DOMAIN,
} from "./harness";

const USAGE =
  "npm run seed:checkin -- --request <id> [--count <n>] [--issue] [--tester <email>]";

async function main() {
  requireSeedMode();
  const admin = adminClient();

  const requestId = requireArg("--request", USAGE);
  const testerEmail = argValue("--tester");
  const count = Number(argValue("--count") ?? (testerEmail ? "1" : "1"));
  if (!Number.isInteger(count) || count < 1) {
    fail(`--count must be a positive integer. ${USAGE}`);
  }
  const issue = hasFlag("--issue");

  const { data: request } = await admin
    .from("test_requests")
    .select("id, app_name")
    .eq("id", requestId)
    .maybeSingle();
  if (!request) fail(`Request ${requestId} not found.`);

  const { data: live } = await admin
    .from("engagements")
    .select("id, tester_id, status")
    .eq("request_id", requestId)
    .in("status", ["confirmed", "at_risk"])
    .order("joined_at");
  const rows = live ?? [];
  if (rows.length === 0) fail(`No live engagements on "${request.app_name}".`);

  const testerIds = [...new Set(rows.map((r) => r.tester_id))];
  const { data: users } = await admin
    .from("users")
    .select("id, email")
    .in("id", testerIds);
  const emailById = new Map((users ?? []).map((u) => [u.id, u.email]));

  const targets = rows.filter((r) => {
    const email = emailById.get(r.tester_id) ?? "";
    return testerEmail
      ? email === testerEmail
      : email.endsWith(`@${SEED_EMAIL_DOMAIN}`);
  });
  if (targets.length === 0) fail("No matching seeded engagements to check in.");

  let done = 0;
  for (const row of targets) {
    if (done >= count) break;
    const { data, error } = await admin.rpc("seed_create_checkin", {
      eng: row.id,
      cstatus: issue ? "issue" : "ok",
      note: issue ? "Seeded issue: app froze on the settings screen." : null,
    });
    if (error) {
      const code = error.message.match(/LT_[A-Z_0-9]+/)?.[0] ?? error.message;
      console.log(`✗ ${emailById.get(row.tester_id)}: ${code}`);
      continue;
    }
    done++;
    const recovered =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>).recovered === true
        : false;
    console.log(
      `✓ ${emailById.get(row.tester_id)} checked in${issue ? " (issue)" : ""}${recovered ? " — recovered from at_risk" : ""}`,
    );
  }
  console.log(`\nDone: ${done}/${count} check-in(s) on "${request.app_name}".`);
}

main();
