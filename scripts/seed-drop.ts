// npm run seed:drop -- --request <id> [--count <n>] [--tester <email>] [--pending]
// A seeded tester leaves through the REAL drop path (seed_drop_engagement →
// drop_engagement_impl). Default: a confirmed tester drops (−15, slot
// reopens, streak break if the request dips below 12). --pending instead
// withdraws a pending_developer engagement (penalty-free cancel — stages the
// graceful confirm-after-cancel demo). Only touches @seed.launchtrain.local
// testers unless --tester explicitly names someone else.
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
  "npm run seed:drop -- --request <id> [--count <n>] [--tester <email>] [--pending]";

async function main() {
  requireSeedMode();
  const admin = adminClient();

  const requestId = requireArg("--request", USAGE);
  const testerEmail = argValue("--tester");
  const count = Number(argValue("--count") ?? "1");
  if (!Number.isInteger(count) || count < 1) {
    fail(`--count must be a positive integer. ${USAGE}`);
  }

  const { data: request } = await admin
    .from("test_requests")
    .select("id, app_name, streak_days, status")
    .eq("id", requestId)
    .maybeSingle();
  if (!request) fail(`Request ${requestId} not found.`);

  const pendingMode = hasFlag("--pending");
  const statuses: Array<"pending_developer" | "confirmed" | "at_risk"> =
    pendingMode ? ["pending_developer"] : ["confirmed", "at_risk"];
  const { data: droppable } = await admin
    .from("engagements")
    .select("id, tester_id, status, joined_at")
    .eq("request_id", requestId)
    .in("status", statuses)
    .order("joined_at", { ascending: false });
  const rows = droppable ?? [];
  if (rows.length === 0) {
    fail(
      `No ${pendingMode ? "pending" : "confirmed"} engagements on "${request.app_name}".`,
    );
  }

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
  if (targets.length === 0) {
    fail(
      testerEmail
        ? `${testerEmail} has no confirmed engagement on this request.`
        : `No SEEDED testers are confirmed on this request (real accounts are never auto-dropped).`,
    );
  }

  let dropped = 0;
  for (const row of targets) {
    if (dropped >= count) break;
    const { error } = await admin.rpc("seed_drop_engagement", { eng: row.id });
    if (error) {
      console.log(`✗ ${emailById.get(row.tester_id)}: ${error.message}`);
      continue;
    }
    dropped++;
    console.log(
      pendingMode
        ? `✓ ${emailById.get(row.tester_id)} withdrew (pending — no penalty)`
        : `✓ ${emailById.get(row.tester_id)} dropped (−15 reliability)`,
    );
  }

  const { data: after } = await admin
    .from("test_requests")
    .select("status, streak_days")
    .eq("id", requestId)
    .single();
  const { data: slots } = await admin
    .from("request_slot_counts")
    .select("confirmed_count, occupied_count")
    .eq("request_id", requestId)
    .maybeSingle();
  console.log(
    `\nDone: ${dropped} drop(s). Request is now ${after?.status}, streak ${after?.streak_days}, ` +
      `${slots?.confirmed_count ?? "?"} confirmed / ${slots?.occupied_count ?? "?"} occupied.`,
  );
}

main();
