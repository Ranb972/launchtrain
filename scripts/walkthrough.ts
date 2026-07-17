// npm run walkthrough [-- --no-pause]
// Scripted end-to-end verification of the F3 manual checklist. Runs every
// stage in order against the dev DB through the REAL RPC paths (seed_*
// wrappers), asserts observed values, prints a PASS/FAIL table, and pauses
// between named stages so you can inspect the browser. The walkthrough
// request is owned by seed tester15, so manage-page/bell effects are
// asserted via DB reads; the public request page and board are your visual
// checkpoints. Requires: dev server running (npm run dev), ALLOW_SEED=true.
import { createInterface } from "node:readline/promises";
import {
  adminClient,
  fail,
  hasFlag,
  jsonNumber,
  jsonString,
  listSeedTesters,
  requireSeedMode,
  SEED_LOWSCORE_EMAIL,
  seedEmail,
  type Admin,
} from "./harness";
import { seedTesters } from "./seed-testers";
import { timetravelRequest } from "./timetravel";
import type { Json } from "../lib/supabase/types";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3456";
const NO_PAUSE = hasFlag("--no-pause") || !process.stdin.isTTY;
const WT_PACKAGE_PREFIX = "com.seed.wt.";

// ------------------------------------------------------------
// result collection
// ------------------------------------------------------------

type CheckRow = {
  stage: string;
  check: string;
  expected: string;
  observed: string;
  pass: boolean;
};
const results: CheckRow[] = [];
let currentStage = "";

function check(
  name: string,
  expected: string | number | boolean,
  observed: string | number | boolean | null | undefined,
  passOverride?: boolean,
): boolean {
  const exp = String(expected);
  const obs = observed === null || observed === undefined ? "—" : String(observed);
  const pass = passOverride ?? exp === obs;
  results.push({ stage: currentStage, check: name, expected: exp, observed: obs, pass });
  console.log(`  ${pass ? "✓" : "✗ FAIL"} ${name} — expected: ${exp} | observed: ${obs}`);
  return pass;
}

function stage(title: string) {
  currentStage = title;
  const bar = "━".repeat(Math.max(4, 68 - title.length));
  console.log(`\n━━ ${title} ${bar}`);
}

async function pause(uiChecks: string[]) {
  console.log("\n  ⏸  In the browser you should now see:");
  for (const line of uiChecks) console.log(`     • ${line}`);
  if (NO_PAUSE) {
    console.log("     (non-interactive run — continuing)");
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("     Press Enter to continue… ");
  rl.close();
}

// ------------------------------------------------------------
// observation helpers
// ------------------------------------------------------------

async function slotCounts(admin: Admin, requestId: string) {
  const { data } = await admin
    .from("request_slot_counts")
    .select("confirmed_count, occupied_count")
    .eq("request_id", requestId)
    .maybeSingle();
  return { confirmed: data?.confirmed_count ?? 0, occupied: data?.occupied_count ?? 0 };
}

async function requestRow(admin: Admin, requestId: string) {
  const { data } = await admin
    .from("test_requests")
    .select(
      "status, streak_days, streak_ok_since, streak_last_counted_day, clock_started_at, slots_needed, is_founding",
    )
    .eq("id", requestId)
    .single();
  if (!data) fail("walkthrough request vanished mid-run");
  return data;
}

async function engagementStatusCounts(admin: Admin, requestId: string) {
  const { data } = await admin
    .from("engagements")
    .select("status")
    .eq("request_id", requestId);
  const map = new Map<string, number>();
  for (const e of data ?? []) map.set(e.status, (map.get(e.status) ?? 0) + 1);
  return map;
}

async function notifCount(
  admin: Admin,
  userId: string,
  type: string,
  requestId: string,
): Promise<number> {
  const { count } = await admin
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("type", type)
    .eq("payload->>request_id", requestId);
  return count ?? 0;
}

async function reliabilityOf(admin: Admin, userId: string): Promise<number> {
  const { data } = await admin
    .from("users")
    .select("reliability_score")
    .eq("id", userId)
    .single();
  return data?.reliability_score ?? -1;
}

// RPC that is EXPECTED to fail — returns the LT_* code (or full message).
async function rpcExpectError(
  admin: Admin,
  fn: "seed_join_test" | "seed_confirm_engagement" | "seed_request_replacement",
  args: Record<string, string>,
): Promise<string> {
  // Args are validated by the DB functions themselves.
  const { error } = await admin.rpc(fn, args as never);
  if (!error) return "(no error)";
  return error.message.match(/LT_[A-Z_0-9]+(?::[^\s"]*)?/)?.[0] ?? error.message;
}

async function runCronRoute(which: "daily-clocks" | "reminders") {
  const secret = process.env.CRON_SECRET;
  if (!secret) fail("CRON_SECRET missing from .env.local");
  const res = await fetch(`${BASE}/api/cron/${which}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!res.ok) fail(`cron ${which} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, Json>;
}

// ------------------------------------------------------------
// the walkthrough
// ------------------------------------------------------------

async function main() {
  requireSeedMode();
  const admin = adminClient();

  console.log("LaunchTrain F3 walkthrough — scripted verification of the manual checklist");
  console.log(`App: ${BASE} | pauses: ${NO_PAUSE ? "off (non-interactive)" : "on"}`);
  console.log(
    "Tip: sign in in the browser first. The walkthrough request is owned by seed",
  );
  console.log(
    "tester15 — your visual checkpoints are the public request page and /board;",
  );
  console.log("owner-side effects (manage page, bell) are asserted via DB reads.\n");

  // ---- Stage 0: preflight ----
  stage("Stage 0 — Preflight");
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(4000) });
    check("dev server reachable", "yes", "yes");
  } catch {
    check("dev server reachable", "yes", "no", false);
    printTableAndExit();
    return;
  }

  // ---- Stage 1: seed + baseline ----
  stage("Stage 1 — Seed testers & reset baseline");
  await seedTesters(admin);
  const allSeed = await listSeedTesters(admin, { includeLowscore: true });
  check("seed users present (15 + lowscore)", 16, allSeed.length);

  // Reset reliability so re-runs start from a known state.
  const regular = allSeed.filter((t) => t.email !== SEED_LOWSCORE_EMAIL);
  for (const t of regular) {
    await admin
      .from("users")
      .update({ reliability_score: 100, join_blocked_until: null })
      .eq("id", t.id);
  }
  await admin
    .from("users")
    .update({
      reliability_score: 55,
      join_blocked_until: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    })
    .eq("email", SEED_LOWSCORE_EMAIL);
  check("baseline reset (regulars=100, lowscore=55+cooldown)", "done", "done");

  // Cancel leftovers from previous walkthrough runs (cleanup only — not a
  // product path; the fresh request below is what exercises real paths).
  const owner = await byEmail(admin, seedEmail(15));
  const { data: leftovers } = await admin
    .from("test_requests")
    .select("id, package_name, status")
    .eq("owner_id", owner.id)
    .like("package_name", `${WT_PACKAGE_PREFIX}%`)
    .not("status", "in", "(completed,cancelled,expired)");
  for (const old of leftovers ?? []) {
    await admin
      .from("engagements")
      .update({ status: "cancelled", ended_at: new Date().toISOString() })
      .eq("request_id", old.id)
      .not("status", "in", "(dropped,cancelled,completed)");
    await admin.from("test_requests").update({ status: "cancelled" }).eq("id", old.id);
  }
  check("previous walkthrough requests cleaned up", "done", "done");
  await pause([
    "Nothing yet — seeding is invisible. Keep a tab open on " + `${BASE}/board`,
  ]);

  // ---- Stage 2: publish a fresh request ----
  stage("Stage 2 — Publish a fresh request (seed_publish_request)");
  const pkg = `${WT_PACKAGE_PREFIX}r${Date.now()}`;
  const { data: draft, error: draftError } = await admin
    .from("test_requests")
    .insert({
      owner_id: owner.id,
      app_name: "LT Walkthrough App",
      package_name: pkg,
      description: "Scripted F3 walkthrough request — safe to ignore.",
      category: "tools",
      join_method: "google_group",
      opt_in_url: `https://play.google.com/apps/testing/${pkg}`,
      group_url: "https://groups.google.com/g/lt-walkthrough",
      instructions: "Harness request. The links are placeholders.",
      min_android_version: 8,
      slots_needed: 14,
    })
    .select("id")
    .single();
  if (draftError || !draft) fail(`draft insert failed: ${draftError?.message}`);
  const reqId = draft.id;
  const reqUrl = `${BASE}/requests/${reqId}`;

  const { error: pubError } = await admin.rpc("seed_publish_request", { req: reqId });
  check("seed_publish_request succeeds", "ok", pubError ? pubError.message : "ok");
  let req = await requestRow(admin, reqId);
  check("status after publish", "recruiting", req.status);
  const founding = req.is_founding;
  console.log(`  (request ${reqId}, founding=${founding})`);
  await pause([
    `${BASE}/board → card "LT Walkthrough App", 0/14 slots${founding ? ", Founding badge" : ""}`,
    `${reqUrl} → device picker + "Join this test" (when signed in; you're eligible)`,
  ]);

  // ---- Stage 3: eleven joins ----
  stage("Stage 3 — 11 seeded testers join (--opted-in), real join path");
  const pool = (await listSeedTesters(admin)).filter((t) => t.id !== owner.id);
  const joiners = pool.slice(0, 11); // tester01..tester11
  for (const t of joiners) {
    const engId = await joinAs(admin, t.id, reqId, t.email);
    const { error } = await admin.rpc("seed_mark_opted_in", { eng: engId });
    if (error) fail(`opt-in failed for ${t.email}: ${error.message}`);
  }
  let slots = await slotCounts(admin, reqId);
  check("occupied after 11 joins", 11, slots.occupied);
  check("confirmed still", 0, slots.confirmed);
  check(
    "tester_joined notifications to owner",
    11,
    await notifCount(admin, owner.id, "tester_joined", reqId),
  );
  await pause([
    `${reqUrl} → "11/14 filled"`,
    `${BASE}/board → card shows 11/14 slots`,
  ]);

  // ---- Stage 4: cancel-before-confirm race ----
  stage("Stage 4 — Withdraw-then-confirm race (graceful failure)");
  const racer = pool[11]; // tester12
  const racerEng = await joinAs(admin, racer.id, reqId, racer.email);
  const scoreBefore = await reliabilityOf(admin, racer.id);
  const { error: withdrawError } = await admin.rpc("seed_drop_engagement", {
    eng: racerEng,
  });
  check("pending withdrawal succeeds", "ok", withdrawError ? withdrawError.message : "ok");
  check("no reliability penalty on pending withdrawal", scoreBefore, await reliabilityOf(admin, racer.id));
  const raceCode = await rpcExpectError(admin, "seed_confirm_engagement", {
    eng: racerEng,
  });
  check("confirm after cancel fails gracefully", "LT_TESTER_CANCELLED", raceCode);
  slots = await slotCounts(admin, reqId);
  check("slot reopened (occupied)", 11, slots.occupied);
  await pause([
    `${reqUrl} → still "11/14 filled" (${racer.email} came and went without a trace)`,
  ]);

  // ---- Stage 5: confirm 11, then reach 12 ----
  stage("Stage 5 — Confirm all, 12th confirm starts the Google clock");
  const { data: pending } = await admin
    .from("engagements")
    .select("id")
    .eq("request_id", reqId)
    .eq("status", "pending_developer")
    .order("joined_at");
  for (const e of pending ?? []) {
    const { error } = await admin.rpc("seed_confirm_engagement", { eng: e.id });
    if (error) fail(`confirm failed: ${error.message}`);
  }
  req = await requestRow(admin, reqId);
  slots = await slotCounts(admin, reqId);
  check("confirmed after 11 confirms", 11, slots.confirmed);
  check("still recruiting below 12", "recruiting", req.status);
  check("clock not started below 12", "null", req.clock_started_at ?? "null");

  // Re-join after cancel (new row) + the crossing confirm.
  const eng12 = await joinAs(admin, racer.id, reqId, racer.email);
  const { error: confirm12Error } = await admin.rpc("seed_confirm_engagement", {
    eng: eng12,
  });
  check("12th confirm succeeds (rejoin after cancel)", "ok", confirm12Error ? confirm12Error.message : "ok");
  req = await requestRow(admin, reqId);
  slots = await slotCounts(admin, reqId);
  check("confirmed", 12, slots.confirmed);
  check("status flips to active", "active", req.status);
  check("clock_started_at set", "set", req.clock_started_at ? "set" : "null");
  check("streak_ok_since set", "set", req.streak_ok_since ? "set" : "null");
  check(
    "request_reached_12 notification",
    1,
    await notifCount(admin, owner.id, "request_reached_12", reqId),
  );
  await pause([
    `${reqUrl} → chip "Active", "12/14 filled"`,
    `${BASE}/board → card 12/14, no at-risk priority`,
  ]);

  // ---- Stage 6: streak advance + idempotency + catch-up ----
  stage("Stage 6 — Streak: advance, idempotent re-run, catch-up");
  await timetravelRequest(admin, reqId, 2);
  await runCronRoute("daily-clocks");
  req = await requestRow(admin, reqId);
  check("streak after 2-day shift (crossing day never counts)", 1, req.streak_days);
  await runCronRoute("daily-clocks");
  req = await requestRow(admin, reqId);
  check("idempotent: second cron run leaves streak", 1, req.streak_days);
  await timetravelRequest(admin, reqId, 3);
  await runCronRoute("daily-clocks");
  req = await requestRow(admin, reqId);
  check("catch-up after 3 more days", 4, req.streak_days);
  await pause([
    `Public pages don't show the streak (owner-only) — values are in the table above.`,
    `${reqUrl} → still "Active"`,
  ]);

  // ---- Stage 7: drop, break, board priority ----
  stage("Stage 7 — Drop below 12: immediate break + board priority");
  const { data: lastConfirmed } = await admin
    .from("engagements")
    .select("id, tester_id")
    .eq("request_id", reqId)
    .in("status", ["confirmed", "at_risk"])
    .order("joined_at", { ascending: false })
    .limit(1)
    .single();
  if (!lastConfirmed) fail("no confirmed engagement to drop");
  const { error: dropError } = await admin.rpc("seed_drop_engagement", {
    eng: lastConfirmed.id,
  });
  check("drop succeeds", "ok", dropError ? dropError.message : "ok");
  check("dropped tester reliability 100−15", 85, await reliabilityOf(admin, lastConfirmed.tester_id));
  req = await requestRow(admin, reqId);
  slots = await slotCounts(admin, reqId);
  check("status flips to at_risk immediately", "at_risk", req.status);
  check("streak reset to 0 immediately", 0, req.streak_days);
  check("streak_ok_since cleared", "null", req.streak_ok_since ?? "null");
  check("slot reopened (occupied)", 11, slots.occupied);
  check(
    "streak_broken notification",
    1,
    await notifCount(admin, owner.id, "streak_broken", reqId),
  );
  check(
    "tester_dropped notifications (withdrawal + drop)",
    2,
    await notifCount(admin, owner.id, "tester_dropped", reqId),
  );
  await pause([
    `${BASE}/board → "LT Walkthrough App" sorted FIRST with the "At risk" chip`,
    `${reqUrl} → chip "At risk", "11/14 filled"`,
  ]);

  // ---- Stage 8: refill → fresh window ----
  stage("Stage 8 — Refill to 12: fresh streak window, no revived days");
  const engRefill = await joinAs(admin, lastConfirmed.tester_id, reqId, "dropped tester (rejoin)");
  const { error: refillConfirmError } = await admin.rpc("seed_confirm_engagement", {
    eng: engRefill,
  });
  check("rejoin after drop + confirm (reliability 85 ≥ 60)", "ok", refillConfirmError ? refillConfirmError.message : "ok");
  req = await requestRow(admin, reqId);
  check("status back to active", "active", req.status);
  check("streak stays 0 until a full day passes", 0, req.streak_days);
  await timetravelRequest(admin, reqId, 2);
  await runCronRoute("daily-clocks");
  req = await requestRow(admin, reqId);
  check("fresh window: streak 1 (pre-break days NOT revived)", 1, req.streak_days);
  await pause([
    `${BASE}/board → card back in normal order, chip "Active" again, 12/14`,
  ]);

  // ---- Stage 9: 5-day engagement at-risk ----
  stage("Stage 9 — 5-day inactivity: engagements flip at_risk, still count");
  await timetravelRequest(admin, reqId, 5);
  await runCronRoute("daily-clocks");
  const engCounts = await engagementStatusCounts(admin, reqId);
  slots = await slotCounts(admin, reqId);
  req = await requestRow(admin, reqId);
  check("all 12 live engagements now at_risk", 12, engCounts.get("at_risk") ?? 0);
  check("at_risk testers still count toward the 12", 12, slots.confirmed);
  check("request stays active (streak intact)", "active", req.status);
  check(
    "engagement_at_risk notifications to owner",
    12,
    await notifCount(admin, owner.id, "engagement_at_risk", reqId),
  );
  await pause([
    `Public page unchanged ("Active") — at-risk engagements are owner/tester-facing.`,
    `The streak kept advancing (day ${req.streak_days}) despite 12 at-risk testers — that's rule A1/A2.`,
  ]);

  // ---- Stage 10: replacement ----
  stage("Stage 10 — Replacement: once per at-risk engagement");
  const { data: atRiskEng } = await admin
    .from("engagements")
    .select("id")
    .eq("request_id", reqId)
    .eq("status", "at_risk")
    .order("joined_at")
    .limit(1)
    .single();
  if (!atRiskEng) fail("no at_risk engagement for replacement");
  const { data: replacement, error: replacementError } = await admin.rpc(
    "seed_request_replacement",
    { eng: atRiskEng.id },
  );
  check("replacement succeeds", "ok", replacementError ? replacementError.message : "ok");
  req = await requestRow(admin, reqId);
  check("slots grew 14 → 15", 15, req.slots_needed);
  check(
    "replacement cost (founding grows free)",
    founding ? 0 : 1,
    replacement ? jsonNumber(replacement, "cost") : null,
  );
  const secondCode = await rpcExpectError(admin, "seed_request_replacement", {
    eng: atRiskEng.id,
  });
  check("second replacement blocked", "LT_REPLACEMENT_ALREADY", secondCode);
  await pause([`${reqUrl} → "12/15 filled" (an extra slot opened)`]);

  // ---- Stage 11: 48h reminder, once only ----
  stage("Stage 11 — 48h confirm reminder fires exactly once");
  const reminderTester = pool[12]; // tester13
  const reminderEng = await joinAs(admin, reminderTester.id, reqId, reminderTester.email);
  await timetravelRequest(admin, reqId, 3);
  await runCronRoute("reminders");
  const { data: remindedRow } = await admin
    .from("engagements")
    .select("confirm_reminded_at")
    .eq("id", reminderEng)
    .single();
  check("confirm_reminded_at stamped", "set", remindedRow?.confirm_reminded_at ? "set" : "null");
  check(
    "confirm_reminder_48h notification",
    1,
    await notifCount(admin, owner.id, "confirm_reminder_48h", reqId),
  );
  await runCronRoute("reminders");
  check(
    "second reminders run adds nothing",
    1,
    await notifCount(admin, owner.id, "confirm_reminder_48h", reqId),
  );
  await pause([
    `${reqUrl} → "13/15 filled" (${reminderTester.email} waiting pending)`,
  ]);

  // ---- Stage 12: cooldown / low-score block ----
  stage("Stage 12 — Reliability < 60 and cooldown both block joining");
  const lowscore = await byEmail(admin, SEED_LOWSCORE_EMAIL);
  const { data: lowDevice } = await admin
    .from("devices")
    .select("id")
    .eq("user_id", lowscore.id)
    .limit(1)
    .single();
  if (!lowDevice) fail("lowscore tester has no device");
  const lowCode = await rpcExpectError(admin, "seed_join_test", {
    tester: lowscore.id,
    req: reqId,
    device: lowDevice.id,
  });
  check("score 55 blocked", "LT_RELIABILITY_LOW:55", lowCode);
  await admin.from("users").update({ reliability_score: 70 }).eq("id", lowscore.id);
  const cooldownCode = await rpcExpectError(admin, "seed_join_test", {
    tester: lowscore.id,
    req: reqId,
    device: lowDevice.id,
  });
  check(
    "score 70 + active cooldown still blocked",
    "LT_COOLDOWN_ACTIVE:*",
    cooldownCode,
    cooldownCode.startsWith("LT_COOLDOWN_ACTIVE:"),
  );
  await admin.from("users").update({ reliability_score: 55 }).eq("id", lowscore.id);
  check("lowscore restored to 55 for future runs", "done", "done");

  printTableAndExit();
}

// Join helper via the real path; fails the run on unexpected errors.
async function joinAs(
  admin: Admin,
  testerId: string,
  requestId: string,
  label: string,
): Promise<string> {
  const { data: device } = await admin
    .from("devices")
    .select("id")
    .eq("user_id", testerId)
    .limit(1)
    .single();
  if (!device) fail(`${label}: no device on file`);
  const { data, error } = await admin.rpc("seed_join_test", {
    tester: testerId,
    req: requestId,
    device: device.id,
  });
  if (error) fail(`${label}: join failed — ${error.message}`);
  const engagementId = jsonString(data, "engagement_id");
  if (!engagementId) fail(`${label}: join returned no engagement id`);
  return engagementId;
}

async function byEmail(admin: Admin, email: string) {
  const { data } = await admin
    .from("users")
    .select("id, email, display_name")
    .eq("email", email)
    .maybeSingle();
  if (!data) fail(`${email} not found — run npm run seed:testers`);
  return data;
}

function printTableAndExit(): void {
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  const wStage = Math.min(46, Math.max(...results.map((r) => r.stage.length), 5));
  const wCheck = Math.min(52, Math.max(...results.map((r) => r.check.length), 5));
  const wExp = Math.min(24, Math.max(...results.map((r) => r.expected.length), 8));
  const wObs = Math.min(24, Math.max(...results.map((r) => r.observed.length), 8));

  console.log(`\n${"═".repeat(wStage + wCheck + wExp + wObs + 13)}`);
  console.log(
    `${pad("STAGE", wStage)} │ ${pad("CHECK", wCheck)} │ ${pad("EXPECTED", wExp)} │ ${pad("OBSERVED", wObs)} │ RESULT`,
  );
  console.log(`${"─".repeat(wStage + wCheck + wExp + wObs + 13)}`);
  for (const r of results) {
    console.log(
      `${pad(r.stage, wStage)} │ ${pad(r.check, wCheck)} │ ${pad(r.expected, wExp)} │ ${pad(r.observed, wObs)} │ ${r.pass ? "PASS" : "FAIL"}`,
    );
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`${"═".repeat(wStage + wCheck + wExp + wObs + 13)}`);
  console.log(
    `${results.length - failed}/${results.length} checks passed${failed > 0 ? ` — ${failed} FAILED` : " — ALL PASS"}`,
  );
  console.log(
    "\nLeft behind: the walkthrough request stays live for browsing; the next run cancels it and resets seed reliability scores.",
  );
  process.exit(failed > 0 ? 1 : 0);
}

main();
