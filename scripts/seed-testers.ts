// npm run seed:testers — creates ~15 clearly-fake onboarded testers with
// valid Android devices, plus one low-score tester (55 + active cooldown)
// for the reliability-block demo. Idempotent: existing seed users are
// skipped. Guarded by ALLOW_SEED=true.
import {
  adminClient,
  fail,
  requireSeedMode,
  SEED_LOWSCORE_EMAIL,
  SEED_TESTER_COUNT,
  seedEmail,
} from "./harness";

// Manufacturer variety from the curated list (SPEC §6), Android 12–15 so
// every tester is compatible with typical min versions.
const DEVICES: Array<[string, string, number]> = [
  ["Samsung", "Galaxy S24", 14],
  ["Google", "Pixel 8", 15],
  ["Xiaomi", "Redmi Note 13", 13],
  ["OnePlus", "12R", 14],
  ["Motorola", "Edge 50", 14],
  ["Oppo", "Reno 11", 14],
  ["Samsung", "Galaxy A54", 13],
  ["Google", "Pixel 7a", 14],
  ["Nothing", "Phone (2)", 14],
  ["Realme", "GT 6", 14],
  ["Vivo", "V30", 14],
  ["Sony", "Xperia 10 V", 13],
  ["Samsung", "Galaxy S22", 12],
  ["Xiaomi", "13T", 13],
  ["Google", "Pixel 6", 12],
];

async function createSeedUser(
  admin: ReturnType<typeof adminClient>,
  email: string,
  displayName: string,
  device: [string, string, number],
): Promise<"created" | "skipped"> {
  const { data: existing } = await admin
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (existing) return "skipped";

  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: displayName },
    });
  if (createError || !created.user) {
    fail(`auth.createUser failed for ${email}: ${createError?.message}`);
  }
  const userId = created.user.id;

  // Device BEFORE onboarded_at — the DB guard requires >= 1 device.
  const [manufacturer, model, androidVersion] = device;
  const { error: deviceError } = await admin.from("devices").insert({
    user_id: userId,
    manufacturer,
    model,
    android_version: androidVersion,
  });
  if (deviceError) fail(`device insert failed for ${email}: ${deviceError.message}`);

  const { error: profileError } = await admin
    .from("users")
    .update({ country: "US", onboarded_at: new Date().toISOString() })
    .eq("id", userId);
  if (profileError) fail(`profile update failed for ${email}: ${profileError.message}`);

  return "created";
}

async function main() {
  requireSeedMode();
  const admin = adminClient();

  let created = 0;
  let skipped = 0;

  for (let i = 1; i <= SEED_TESTER_COUNT; i++) {
    const email = seedEmail(i);
    const result = await createSeedUser(
      admin,
      email,
      `Seed Tester ${String(i).padStart(2, "0")}`,
      DEVICES[(i - 1) % DEVICES.length],
    );
    if (result === "created") created++;
    else skipped++;
    console.log(`${result === "created" ? "✓ created" : "· exists "} ${email}`);
  }

  // Low-score tester: reliability 55 + active cooldown → demonstrates the
  // join block (score < 60 AND cooldown) without needing three real drops.
  const lowResult = await createSeedUser(
    admin,
    SEED_LOWSCORE_EMAIL,
    "Seed Lowscore",
    ["Samsung", "Galaxy S21", 12],
  );
  if (lowResult === "created") {
    const { error } = await admin
      .from("users")
      .update({
        reliability_score: 55,
        join_blocked_until: new Date(
          Date.now() + 14 * 86_400_000,
        ).toISOString(),
      })
      .eq("email", SEED_LOWSCORE_EMAIL);
    if (error) fail(`lowscore update failed: ${error.message}`);
    created++;
    console.log(`✓ created ${SEED_LOWSCORE_EMAIL} (reliability 55, cooldown active)`);
  } else {
    skipped++;
    console.log(`· exists  ${SEED_LOWSCORE_EMAIL}`);
  }

  console.log(
    `\nDone: ${created} created, ${skipped} already existed. ` +
      `Seeded testers sign in nowhere — drive them with seed:join / seed:confirm / seed:drop.`,
  );
}

main();
