// npm run seed:join -- --request <id> --count <n> [--opted-in] [--tester <email>]
// Joins n seeded testers to a request through the REAL join path
// (seed_join_test → join_test_impl: eligibility, capacity race, notification).
// --opted-in additionally marks each as opted in. --tester targets one seed
// user (e.g. lowscore@seed.launchtrain.local to demo the reliability block).
import {
  adminClient,
  argValue,
  fail,
  hasFlag,
  jsonString,
  listSeedTesters,
  requireArg,
  requireSeedMode,
} from "./harness";

const USAGE =
  "npm run seed:join -- --request <id> --count <n> [--opted-in] [--tester <email>]";

async function main() {
  requireSeedMode();
  const admin = adminClient();

  const requestId = requireArg("--request", USAGE);
  const testerEmail = argValue("--tester");
  const count = testerEmail ? 1 : Number(requireArg("--count", USAGE));
  if (!Number.isInteger(count) || count < 1) fail(`--count must be a positive integer. ${USAGE}`);
  const optIn = hasFlag("--opted-in");

  const { data: request } = await admin
    .from("test_requests")
    .select("id, app_name, owner_id, slots_needed, status")
    .eq("id", requestId)
    .maybeSingle();
  if (!request) fail(`Request ${requestId} not found.`);

  const candidates = (
    await listSeedTesters(admin, { includeLowscore: testerEmail !== null })
  ).filter(
    (t) =>
      t.id !== request.owner_id &&
      (testerEmail === null || t.email === testerEmail),
  );
  if (testerEmail && candidates.length === 0) {
    fail(`Seed tester ${testerEmail} not found — run npm run seed:testers.`);
  }

  let joined = 0;
  for (const tester of candidates) {
    if (joined >= count) break;

    const { data: device } = await admin
      .from("devices")
      .select("id, manufacturer, model, android_version")
      .eq("user_id", tester.id)
      .limit(1)
      .maybeSingle();
    if (!device) {
      console.log(`· ${tester.email}: no device on file — skipped`);
      continue;
    }

    const { data, error } = await admin.rpc("seed_join_test", {
      tester: tester.id,
      req: request.id,
      device: device.id,
    });

    if (error) {
      const code = error.message.match(/LT_[A-Z_0-9]+(?::[^\s"]*)?/)?.[0] ?? error.message;
      console.log(`✗ ${tester.email}: ${code}`);
      // Full test / not joinable will fail for everyone — stop early.
      if (error.message.includes("LT_TEST_FULL") || error.message.includes("LT_NOT_JOINABLE")) break;
      continue;
    }

    joined++;
    const engagementId = jsonString(data, "engagement_id");
    let optedNote = "";
    if (optIn && engagementId) {
      const { error: optError } = await admin.rpc("seed_mark_opted_in", {
        eng: engagementId,
      });
      optedNote = optError ? ` (opt-in failed: ${optError.message})` : " · opted in";
    }
    console.log(`✓ ${tester.email} joined "${request.app_name}"${optedNote}`);
  }

  const { data: slots } = await admin
    .from("request_slot_counts")
    .select("confirmed_count, occupied_count")
    .eq("request_id", request.id)
    .maybeSingle();
  console.log(
    `\nDone: ${joined}/${count} joined. Slots now ${slots?.occupied_count ?? "?"}/${request.slots_needed} occupied, ${slots?.confirmed_count ?? "?"} confirmed.`,
  );
}

main();
