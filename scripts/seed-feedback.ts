// npm run seed:feedback -- --request <id> --type mid|final [--count <n>] [--tester <email>]
// Seeded testers submit feedback through the REAL path (seed_submit_feedback
// → submit_feedback_impl: day gates, validation; FINAL completes the
// engagement and releases the escrowed credit). Ratings and bugs vary per
// tester so the Feedback Hub and future Dossier have texture.
import {
  adminClient,
  argValue,
  fail,
  requireArg,
  requireSeedMode,
  SEED_EMAIL_DOMAIN,
} from "./harness";

const USAGE =
  "npm run seed:feedback -- --request <id> --type mid|final [--count <n>] [--tester <email>]";

const SAMPLE_BUGS = [
  [],
  [{ text: "App froze when rotating the screen on the map view.", severity: "medium" }],
  [
    { text: "Crash on first launch after granting notifications.", severity: "high" },
    { text: "Typo on the onboarding screen ('recieve').", severity: "low" },
  ],
];

const SAMPLE_SUGGESTIONS = [
  null,
  "A dark theme would be great for night use.",
  "Let me reorder the home screen cards.",
];

async function main() {
  requireSeedMode();
  const admin = adminClient();

  const requestId = requireArg("--request", USAGE);
  const ftype = requireArg("--type", USAGE);
  if (ftype !== "mid" && ftype !== "final") fail(`--type must be mid or final. ${USAGE}`);
  const testerEmail = argValue("--tester");
  const count = Number(argValue("--count") ?? "1");
  if (!Number.isInteger(count) || count < 1) {
    fail(`--count must be a positive integer. ${USAGE}`);
  }

  const { data: request } = await admin
    .from("test_requests")
    .select("id, app_name")
    .eq("id", requestId)
    .maybeSingle();
  if (!request) fail(`Request ${requestId} not found.`);

  const { data: live } = await admin
    .from("engagements")
    .select("id, tester_id")
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
  if (targets.length === 0) fail("No matching seeded engagements.");

  let done = 0;
  let i = 0;
  for (const row of targets) {
    if (done >= count) break;
    const { data, error } = await admin.rpc("seed_submit_feedback", {
      eng: row.id,
      ftype,
      stability: 3 + (i % 3),
      ux: 3 + ((i + 1) % 3),
      value_score: 3 + ((i + 2) % 3),
      bugs: SAMPLE_BUGS[i % SAMPLE_BUGS.length],
      suggestions: SAMPLE_SUGGESTIONS[i % SAMPLE_SUGGESTIONS.length],
      usage_freq: (["daily", "few_weekly", "rarely"] as const)[i % 3],
    });
    i++;
    if (error) {
      const code =
        error.message.match(/LT_[A-Z_0-9]+(?::\d+)?/)?.[0] ?? error.message;
      console.log(`✗ ${emailById.get(row.tester_id)}: ${code}`);
      continue;
    }
    done++;
    const completed =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>).completed === true
        : false;
    console.log(
      `✓ ${emailById.get(row.tester_id)} submitted ${ftype} feedback${completed ? " — engagement COMPLETED, +1 credit released" : ""}`,
    );
  }
  console.log(`\nDone: ${done}/${count} ${ftype} feedback(s) on "${request.app_name}".`);
}

main();
