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
  // F4: the Stage 6 five-day shift flipped everyone at_risk (−5 each), so
  // the dropper stands at 95 before the −15 → 80.
  check("dropped tester reliability 100−5(flip)−15(drop)", 80, await reliabilityOf(admin, lastConfirmed.tester_id));
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
  check("rejoin after drop + confirm (reliability 80 ≥ 60)", "ok", refillConfirmError ? refillConfirmError.message : "ok");
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
  // Cumulative across the run: the Stage 6 shifts already crossed the 5-day
  // line for the 12 first-generation engagements (12 owner notifications);
  // one of those was then dropped in Stage 7 and its REFILL engagement flips
  // here (+1). Notifications for dropped engagements don't un-count → 13.
  check(
    "engagement_at_risk notifications to owner (12 first-gen + 1 refill)",
    13,
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
  await pause(["Nothing visual — script output only."]);

  // ================= F4 stages =================

  // ---- Stage 13: check-in mechanics + at-risk recovery ----
  stage("Stage 13 — Check-in: recovery, −5 verified, once-per-day lock");
  const { data: firstAtRisk } = await admin
    .from("engagements")
    .select("id, tester_id")
    .eq("request_id", reqId)
    .eq("status", "at_risk")
    .order("joined_at")
    .limit(1)
    .single();
  if (!firstAtRisk) fail("no at_risk engagement for the check-in stage");
  const recoveryEng = firstAtRisk.id;
  const recoveryTester = firstAtRisk.tester_id;
  check(
    "at-risk flip applied −5 exactly once (100−5)",
    95,
    await reliabilityOf(admin, recoveryTester),
  );
  const { data: checkinResult, error: checkinError } = await admin.rpc(
    "seed_create_checkin",
    { eng: recoveryEng, cstatus: "ok", note: null },
  );
  check("check-in succeeds", "ok", checkinError ? checkinError.message : "ok");
  check(
    "check-in recovers at_risk → confirmed",
    true,
    checkinResult && typeof checkinResult === "object" && !Array.isArray(checkinResult)
      ? (checkinResult as Record<string, Json>).recovered === true
      : false,
  );
  const { data: recoveredRow } = await admin
    .from("engagements")
    .select("status, last_checkin_at, checkin_count, checkin_reminded_at")
    .eq("id", recoveryEng)
    .single();
  check("engagement status after recovery", "confirmed", recoveredRow?.status);
  check("last_checkin_at stamped", "set", recoveredRow?.last_checkin_at ? "set" : "null");
  check("checkin_count", 1, recoveredRow?.checkin_count);
  check(
    "recovery does NOT refund the −5 (score stays 95)",
    95,
    await reliabilityOf(admin, recoveryTester),
  );
  const dayLockCode = await rpcExpectErrorAny(admin, "seed_create_checkin", {
    eng: recoveryEng,
    cstatus: "ok",
    note: null,
  });
  check(
    "second check-in same UTC day blocked",
    "LT_ALREADY_CHECKED_IN_TODAY",
    dayLockCode,
  );
  await pause([
    `${BASE}/dashboard#my-tests → on YOUR engagements the same button shows a locked "Checked in today ✓" state after use (this stage exercised a seeded tester).`,
  ]);

  // ---- Stage 14: feedback gates + prompts ----
  stage("Stage 14 — Feedback: day-7 mid unlocked, day-14 final gated, prompts once");
  // The refill engagement (Stage 8) sits mid-window: shifted 2+5+3 = 10 days.
  const { data: refillRow } = await admin
    .from("engagements")
    .select("id, tester_id, confirmed_at, status")
    .eq("id", engRefill)
    .single();
  if (!refillRow?.confirmed_at) fail("refill engagement lost its confirmed_at");
  const refillDay =
    Math.floor(
      (Date.now() - Date.parse(refillRow.confirmed_at)) / 86_400_000,
    ) + 1;
  check(
    "refill engagement sits between day 7 and 13",
    "7 <= day < 14",
    `day ${refillDay}`,
    refillDay >= 7 && refillDay < 14,
  );
  await runCronRoute("daily-clocks");
  const { data: promptedRow } = await admin
    .from("engagements")
    .select("feedback_mid_prompted_at, feedback_final_prompted_at")
    .eq("id", engRefill)
    .single();
  check("cron prompted mid (day ≥ 7)", "set", promptedRow?.feedback_mid_prompted_at ? "set" : "null");
  check("cron did NOT prompt final (day < 14)", "null", promptedRow?.feedback_final_prompted_at ?? "null");
  check(
    "feedback_prompt_mid notification",
    1,
    await notifCount(admin, refillRow.tester_id, "feedback_prompt_mid", reqId),
  );
  await runCronRoute("daily-clocks");
  check(
    "prompt not re-sent on the next cron",
    1,
    await notifCount(admin, refillRow.tester_id, "feedback_prompt_mid", reqId),
  );
  const tooEarlyCode = await rpcExpectErrorAny(admin, "seed_submit_feedback", {
    eng: engRefill,
    ftype: "final",
    stability: 4,
    ux: 4,
    value_score: 4,
    bugs: [],
    suggestions: null,
    usage_freq: "daily",
  });
  check("final before day 14 rejected", "LT_FEEDBACK_TOO_EARLY:14", tooEarlyCode);
  const { error: midError } = await admin.rpc("seed_submit_feedback", {
    eng: engRefill,
    ftype: "mid",
    stability: 4,
    ux: 3,
    value_score: 5,
    bugs: [{ text: "Back button exits instead of going up.", severity: "medium" }],
    suggestions: "Consider a bottom nav.",
    usage_freq: "daily",
  });
  check("mid feedback on day ≥ 7 accepted", "ok", midError ? midError.message : "ok");
  const dupMidCode = await rpcExpectErrorAny(admin, "seed_submit_feedback", {
    eng: engRefill,
    ftype: "mid",
    stability: 5,
    ux: 5,
    value_score: 5,
    bugs: [],
    suggestions: null,
    usage_freq: "daily",
  });
  check("duplicate mid rejected (immutable)", "LT_FEEDBACK_EXISTS", dupMidCode);
  check(
    "feedback_received notification to owner",
    1,
    await notifCount(admin, owner.id, "feedback_received", reqId),
  );
  await pause([
    `${BASE}/requests/${reqId}/manage → Feedback Hub section: 1 mid-test card (bug + suggestion) — visible to the seed owner only, asserted via DB here.`,
  ]);

  // ---- Stage 15: final feedback completes + escrow release ----
  stage("Stage 15 — Final feedback → completed + escrow release + A1 live");
  const { data: finalResult, error: finalError } = await admin.rpc(
    "seed_submit_feedback",
    {
      eng: recoveryEng,
      ftype: "final",
      stability: 5,
      ux: 4,
      value_score: 4,
      bugs: [{ text: "Rare crash when offline.", severity: "high" }],
      suggestions: "Offline mode would seal it.",
      usage_freq: "few_weekly",
    },
  );
  check("final feedback (day ≥ 14) succeeds", "ok", finalError ? finalError.message : "ok");
  check(
    "returns completed=true",
    true,
    finalResult && typeof finalResult === "object" && !Array.isArray(finalResult)
      ? (finalResult as Record<string, Json>).completed === true
      : false,
  );
  const { data: completedRow } = await admin
    .from("engagements")
    .select("status, completed_at")
    .eq("id", recoveryEng)
    .single();
  check("engagement status", "completed", completedRow?.status);
  check("completed_at stamped", "set", completedRow?.completed_at ? "set" : "null");
  const { data: releaseRows } = await admin
    .from("credit_transactions")
    .select("amount, type, status")
    .eq("engagement_id", recoveryEng)
    .eq("type", "escrow_release");
  check("exactly one escrow_release row", 1, (releaseRows ?? []).length);
  check(
    "release is +1 settled",
    "1/settled",
    releaseRows?.[0] ? `${releaseRows[0].amount}/${releaseRows[0].status}` : "—",
  );
  check(
    "reliability 95 + 2 completion bonus",
    97,
    await reliabilityOf(admin, recoveryTester),
  );
  check(
    "engagement_completed notification",
    1,
    await notifCount(admin, recoveryTester, "engagement_completed", reqId),
  );
  slots = await slotCounts(admin, reqId);
  req = await requestRow(admin, reqId);
  check("completed engagement STILL counts toward the 12 (A1 live)", 12, slots.confirmed);
  check("request stays active", "active", req.status);
  await pause([
    `${BASE}/board → the walkthrough card still shows a healthy request (A1: completion didn't dent the 12).`,
  ]);

  // ---- Stage 16: helpful rating + bonus idempotency ----
  stage("Stage 16 — Helpful rating: +1 bonus, idempotent, rating is final");
  const { data: finalFb } = await admin
    .from("feedback")
    .select("id")
    .eq("engagement_id", recoveryEng)
    .eq("type", "final")
    .single();
  if (!finalFb) fail("final feedback row missing");
  const { data: rate1, error: rateError } = await admin.rpc("seed_rate_feedback", {
    fb: finalFb.id,
    rating: "helpful",
  });
  check("rate helpful succeeds", "ok", rateError ? rateError.message : "ok");
  check(
    "bonus minted (+1)",
    1,
    rate1 && typeof rate1 === "object" && !Array.isArray(rate1)
      ? Number((rate1 as Record<string, Json>).bonus)
      : NaN,
  );
  const bonusCount = async () => {
    const { data } = await admin
      .from("credit_transactions")
      .select("id")
      .eq("engagement_id", recoveryEng)
      .eq("type", "bonus");
    return (data ?? []).length;
  };
  check("exactly one bonus row", 1, await bonusCount());
  const { data: rate2, error: rate2Error } = await admin.rpc("seed_rate_feedback", {
    fb: finalFb.id,
    rating: "helpful",
  });
  check("repeat helpful is a no-op success", "ok", rate2Error ? rate2Error.message : "ok");
  check(
    "repeat reports already_rated",
    true,
    rate2 && typeof rate2 === "object" && !Array.isArray(rate2)
      ? (rate2 as Record<string, Json>).already_rated === true
      : false,
  );
  check("still exactly one bonus row (idempotent)", 1, await bonusCount());
  const changeCode = await rpcExpectErrorAny(admin, "seed_rate_feedback", {
    fb: finalFb.id,
    rating: "not_helpful",
  });
  check("changing the rating blocked", "LT_ALREADY_RATED", changeCode);
  check(
    "bonus_credit notification to tester",
    1,
    await notifCount(admin, recoveryTester, "bonus_credit", reqId),
  );
  const { data: testerTx } = await admin
    .from("credit_transactions")
    .select("amount")
    .eq("user_id", recoveryTester)
    .eq("request_id", reqId);
  check(
    "tester earned exactly +2 on this request (release + bonus)",
    2,
    (testerTx ?? []).reduce((sum, t) => sum + t.amount, 0),
  );
  await pause([
    `${BASE}/requests/${reqId}/manage → Feedback Hub: the final card shows "✓ Rated helpful — +1 bonus credit sent".`,
  ]);

  // ---- Stage 17: day-3 check-in reminder + re-arm ----
  stage("Stage 17 — Day-3 check-in reminder fires once and re-arms");
  const { data: secondAtRisk } = await admin
    .from("engagements")
    .select("id, tester_id")
    .eq("request_id", reqId)
    .eq("status", "at_risk")
    .order("joined_at")
    .limit(1)
    .single();
  if (!secondAtRisk) fail("no at_risk engagement left for the reminder stage");
  const { error: recover2Error } = await admin.rpc("seed_create_checkin", {
    eng: secondAtRisk.id,
    cstatus: "issue",
    note: "Walkthrough issue: share sheet crashes.",
  });
  check("recover a second tester via an issue check-in", "ok", recover2Error ? recover2Error.message : "ok");
  await timetravelRequest(admin, reqId, 3);
  await runCronRoute("reminders");
  const { data: remindedEng } = await admin
    .from("engagements")
    .select("checkin_reminded_at")
    .eq("id", secondAtRisk.id)
    .single();
  check("checkin_reminded_at stamped after 3-day gap", "set", remindedEng?.checkin_reminded_at ? "set" : "null");
  check(
    "checkin_reminder_3d notification",
    1,
    await notifCount(admin, secondAtRisk.tester_id, "checkin_reminder_3d", reqId),
  );
  await runCronRoute("reminders");
  check(
    "second reminders run adds nothing",
    1,
    await notifCount(admin, secondAtRisk.tester_id, "checkin_reminder_3d", reqId),
  );
  const { error: rearmError } = await admin.rpc("seed_create_checkin", {
    eng: secondAtRisk.id,
    cstatus: "ok",
    note: null,
  });
  check("new check-in allowed (day rows shifted consistently)", "ok", rearmError ? rearmError.message : "ok");
  const { data: rearmedEng } = await admin
    .from("engagements")
    .select("checkin_reminded_at")
    .eq("id", secondAtRisk.id)
    .single();
  check("check-in re-arms the reminder (marker cleared)", "null", rearmedEng?.checkin_reminded_at ?? "null");
  await pause([
    `${BASE}/requests/${reqId}/manage → Feedback Hub now also lists the issue check-in ("share sheet crashes").`,
  ]);

  printTableAndExit();
}

// RPC that is EXPECTED to fail, for the F4 functions (loose arg typing).
async function rpcExpectErrorAny(
  admin: Admin,
  fn:
    | "seed_create_checkin"
    | "seed_submit_feedback"
    | "seed_rate_feedback",
  args: Record<string, unknown>,
): Promise<string> {
  const { error } = await admin.rpc(fn, args as never);
  if (!error) return "(no error)";
  return error.message.match(/LT_[A-Z_0-9]+(?::[^\s"]*)?/)?.[0] ?? error.message;
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
