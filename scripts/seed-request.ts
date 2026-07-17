// npm run seed:request — creates (or reuses) one recruiting request owned by
// seed tester01, so Ran can experience the TESTER side with his real account:
// join via the UI, opt in, then seed:confirm to be confirmed by the "owner".
// google_group method → both links reveal immediately (SPEC Flow 3 branch B).
import {
  adminClient,
  fail,
  findSeedUserByEmail,
  requireSeedMode,
  seedEmail,
} from "./harness";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3456";

async function main() {
  requireSeedMode();
  const admin = adminClient();

  const owner = await findSeedUserByEmail(admin, seedEmail(1));
  if (!owner) fail("Seed tester01 not found — run `npm run seed:testers` first.");

  // Reuse a live seed request when one exists (idempotent re-runs).
  const { data: existing } = await admin
    .from("test_requests")
    .select("id, status, app_name")
    .eq("owner_id", owner.id)
    .in("status", ["recruiting", "active", "at_risk"])
    .maybeSingle();
  if (existing) {
    console.log(
      `· exists  "${existing.app_name}" (${existing.status})\n` +
        `  Join it as yourself: ${APP_URL}/requests/${existing.id}`,
    );
    return;
  }

  const { data: draft, error: insertError } = await admin
    .from("test_requests")
    .insert({
      owner_id: owner.id,
      app_name: "Seed Demo App",
      package_name: "com.seed.demoapp",
      description:
        "A seeded demo request for exercising the tester-side flow end to end.",
      category: "tools",
      join_method: "google_group",
      opt_in_url: "https://play.google.com/apps/testing/com.seed.demoapp",
      group_url: "https://groups.google.com/g/seed-launchtrain-demo",
      instructions:
        "This is a harness request — the links are placeholders. Join, opt in, and watch the engagement lifecycle.",
      min_android_version: 8,
      slots_needed: 14,
    })
    .select("id")
    .single();
  if (insertError || !draft) {
    fail(`draft insert failed: ${insertError?.message}`);
  }

  const { error: publishError } = await admin.rpc("seed_publish_request", {
    req: draft.id,
  });
  if (publishError) {
    fail(
      `publish failed: ${publishError.message}` +
        (publishError.message.includes("LT_INSUFFICIENT_CREDITS")
          ? " (founding phase over and the seed owner has no credits)"
          : ""),
    );
  }

  console.log(
    `✓ published "Seed Demo App" owned by ${owner.display_name}\n` +
      `  Join it as yourself: ${APP_URL}/requests/${draft.id}`,
  );
}

main();
