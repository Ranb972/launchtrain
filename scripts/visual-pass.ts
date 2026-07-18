// npm run visual:pass — automated browser pass over the visual half of the
// F4 manual checklist (items 1, 4, 7, 8): mobile bottom nav on
// /dashboard /board /notifications (+ /settings), the day-14 feedback gate,
// the Feedback Hub rating flow (clicked in the real UI), and the
// notifications sweep. Saves full-page screenshots to docs/qa/f4/.
//
// Auth: a REAL Supabase session for seed tester15 (password set via the
// admin API; magic-link token fallback), serialized into @supabase/ssr
// cookies by the library itself and injected into Playwright. No Google
// account involved. Requires: dev server running, ALLOW_SEED=true.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import {
  adminClient,
  fail,
  requireSeedMode,
  seedEmail,
  type Admin,
} from "./harness";
import { seedTesters } from "./seed-testers";
import { timetravelRequest } from "./timetravel";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3456";
const OUT_DIR = join(process.cwd(), "docs", "qa", "f4");
const VISUAL_PKG_PREFIX = "com.seed.visual.";
const PASSWORD = "seed-visual-pass-9f4!LT";

type ShotRow = { file: string; caption: string; check: string; pass: boolean };
const shots: ShotRow[] = [];

function report(file: string, caption: string, check: string, pass: boolean) {
  shots.push({ file, caption, check, pass });
  console.log(`  ${pass ? "✓" : "✗ FAIL"} ${file} — ${check}`);
}

// ------------------------------------------------------------
// data seeding (same primitives as the walkthrough)
// ------------------------------------------------------------

async function cleanupVisualRequests(admin: Admin, ownerIds: string[]) {
  const { data: leftovers } = await admin
    .from("test_requests")
    .select("id")
    .in("owner_id", ownerIds)
    .like("package_name", `${VISUAL_PKG_PREFIX}%`)
    .not("status", "in", "(completed,cancelled,expired)");
  for (const old of leftovers ?? []) {
    await admin
      .from("engagements")
      .update({ status: "cancelled", ended_at: new Date().toISOString() })
      .eq("request_id", old.id)
      .not("status", "in", "(dropped,cancelled,completed)");
    await admin.from("test_requests").update({ status: "cancelled" }).eq("id", old.id);
  }
}

async function publishSeedRequest(
  admin: Admin,
  ownerId: string,
  appName: string,
  pkg: string,
): Promise<string> {
  const { data: draft, error } = await admin
    .from("test_requests")
    .insert({
      owner_id: ownerId,
      app_name: appName,
      package_name: pkg,
      description: "Visual QA request — safe to ignore.",
      category: "tools",
      join_method: "google_group",
      opt_in_url: `https://play.google.com/apps/testing/${pkg}`,
      group_url: "https://groups.google.com/g/lt-visual-qa",
      instructions: "Automated visual pass data.",
      min_android_version: 8,
      slots_needed: 14,
    })
    .select("id")
    .single();
  if (error || !draft) fail(`draft insert failed: ${error?.message}`);
  const { error: pubError } = await admin.rpc("seed_publish_request", { req: draft.id });
  if (pubError) fail(`publish failed: ${pubError.message}`);
  return draft.id;
}

async function joinAndConfirm(
  admin: Admin,
  testerId: string,
  requestId: string,
): Promise<string> {
  const { data: device } = await admin
    .from("devices")
    .select("id")
    .eq("user_id", testerId)
    .limit(1)
    .single();
  if (!device) fail("seed tester has no device");
  const { data, error } = await admin.rpc("seed_join_test", {
    tester: testerId,
    req: requestId,
    device: device.id,
  });
  if (error) fail(`join failed: ${error.message}`);
  const engId =
    data && typeof data === "object" && !Array.isArray(data)
      ? String((data as Record<string, unknown>).engagement_id)
      : "";
  const { error: confirmError } = await admin.rpc("seed_confirm_engagement", {
    eng: engId,
  });
  if (confirmError) fail(`confirm failed: ${confirmError.message}`);
  return engId;
}

// ------------------------------------------------------------
// session minting for tester15 (no Google involved)
// ------------------------------------------------------------

async function mintSessionCookies(
  admin: Admin,
  userId: string,
  email: string,
): Promise<Array<{ name: string; value: string; url: string }>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // Primary: set a throwaway password on the seeded user, sign in with it.
  let accessToken = "";
  let refreshToken = "";
  const { error: pwError } = await admin.auth.admin.updateUserById(userId, {
    password: PASSWORD,
  });
  if (!pwError) {
    const { data, error } = await anon.auth.signInWithPassword({
      email,
      password: PASSWORD,
    });
    if (!error && data.session) {
      accessToken = data.session.access_token;
      refreshToken = data.session.refresh_token;
    } else {
      console.log(`  (password sign-in unavailable: ${error?.message ?? "?"})`);
    }
  }

  // Fallback: admin-generated magic-link token verified directly.
  if (!accessToken) {
    const { data: link, error: linkError } =
      await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (linkError || !link.properties?.hashed_token) {
      fail(`could not mint a session: ${linkError?.message ?? "no token"}`);
    }
    const { data, error } = await anon.auth.verifyOtp({
      type: "email",
      token_hash: link.properties.hashed_token,
    });
    if (error || !data.session) {
      fail(`magic-link verification failed: ${error?.message ?? "no session"}`);
    }
    accessToken = data.session.access_token;
    refreshToken = data.session.refresh_token;
  }

  // Let @supabase/ssr serialize the cookies itself (names, base64 format,
  // chunking) so the app's server client accepts them verbatim.
  const jar = new Map<string, string>();
  const ssr = createServerClient(url, anonKey, {
    cookies: {
      getAll: () =>
        [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const c of cookies) jar.set(c.name, c.value);
      },
    },
  });
  const { error: sessionError } = await ssr.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (sessionError) fail(`setSession failed: ${sessionError.message}`);
  if (jar.size === 0) fail("ssr client produced no auth cookies");

  return [...jar.entries()].map(([name, value]) => ({ name, value, url: BASE }));
}

// ------------------------------------------------------------
// screenshot helpers
// ------------------------------------------------------------

async function shoot(
  page: Page,
  path: string,
  file: string,
  caption: string,
  check: { name: string; locatorText: string },
) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 60_000 });
  // Scope to <main>: header copies of the same text may be display:none on
  // mobile (e.g. the sm+-only Sign out) and would fail a bare first() check.
  const visible = await page
    .locator("main")
    .getByText(check.locatorText, { exact: false })
    .first()
    .isVisible()
    .catch(() => false);
  await page.screenshot({ path: join(OUT_DIR, file), fullPage: true });
  report(file, caption, `${check.name} (${visible ? "found" : "MISSING"}: "${check.locatorText}")`, visible);
}

async function main() {
  requireSeedMode();
  const admin = adminClient();

  console.log("F4 visual pass — Playwright over the manual checklist items 1/4/7/8");
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(4000) });
  } catch {
    fail(`dev server unreachable at ${BASE} — run npm run dev first.`);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  // ---- seed the scene ----
  console.log("\nSeeding the visual scene…");
  await seedTesters(admin);
  const t15 = await byEmail(admin, seedEmail(15));
  const t14 = await byEmail(admin, seedEmail(14));
  const t01 = await byEmail(admin, seedEmail(1));
  const t02 = await byEmail(admin, seedEmail(2));
  const t03 = await byEmail(admin, seedEmail(3));
  await cleanupVisualRequests(admin, [t15.id, t14.id]);

  // V1 — Hub flow: owned by tester15 (the browser persona), 3 testers,
  // day 16, two finals (completed) + one mid + one issue check-in.
  const hubReq = await publishSeedRequest(
    admin, t15.id, "Visual Hub App", `${VISUAL_PKG_PREFIX}hub`,
  );
  const hubEng1 = await joinAndConfirm(admin, t01.id, hubReq);
  const hubEng2 = await joinAndConfirm(admin, t02.id, hubReq);
  const hubEng3 = await joinAndConfirm(admin, t03.id, hubReq);
  await timetravelRequest(admin, hubReq, 15);
  for (const [eng, i] of [
    [hubEng1, 0],
    [hubEng2, 1],
  ] as const) {
    const { error } = await admin.rpc("seed_submit_feedback", {
      eng,
      ftype: "final",
      stability: 4 + (i % 2),
      ux: 3 + i,
      value_score: 4,
      bugs:
        i === 0
          ? [{ text: "Crash when exporting on Android 13.", severity: "high" }]
          : [],
      suggestions: i === 0 ? "Add an export progress bar." : null,
      usage_freq: i === 0 ? "daily" : "few_weekly",
    });
    if (error) fail(`final feedback failed: ${error.message}`);
  }
  const { error: midErr } = await admin.rpc("seed_submit_feedback", {
    eng: hubEng3,
    ftype: "mid",
    stability: 3,
    ux: 4,
    value_score: 5,
    bugs: [{ text: "Dark mode flickers on launch.", severity: "low" }],
    suggestions: "Loving it so far.",
    usage_freq: "daily",
  });
  if (midErr) fail(`mid feedback failed: ${midErr.message}`);
  const { error: issueErr } = await admin.rpc("seed_create_checkin", {
    eng: hubEng3,
    cstatus: "issue",
    note: "Widget stops updating after a reboot.",
  });
  if (issueErr) fail(`issue check-in failed: ${issueErr.message}`);
  console.log(`  ✓ Visual Hub App ready (${hubReq})`);

  // V2 — Gate: tester15 as TESTER, day 1 (owned by tester14).
  const gateReq = await publishSeedRequest(
    admin, t14.id, "Visual Gate App", `${VISUAL_PKG_PREFIX}gate`,
  );
  const gateEng = await joinAndConfirm(admin, t15.id, gateReq);
  console.log(`  ✓ Visual Gate App ready (${gateReq}) — tester15 on day 1`);

  // ---- session + browser ----
  console.log("\nMinting a session for tester15…");
  const cookies = await mintSessionCookies(admin, t15.id, t15.email);
  console.log(`  ✓ ${cookies.length} auth cookie(s) minted`);

  const browser: Browser = await chromium.launch();
  try {
    // ---- item 1: mobile viewport ----
    console.log("\nItem 1 — mobile viewport (390×844):");
    const mobile: BrowserContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    await mobile.addCookies(cookies);
    const mPage = await mobile.newPage();

    await mPage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle", timeout: 90_000 });
    const bottomNavVisible = await mPage
      .locator('nav[aria-label="Primary"]')
      .isVisible()
      .catch(() => false);
    const signedIn = await mPage
      .getByText("Welcome aboard", { exact: false })
      .isVisible()
      .catch(() => false);
    await mPage.screenshot({ path: join(OUT_DIR, "01-mobile-dashboard.png"), fullPage: true });
    report(
      "01-mobile-dashboard.png",
      "Mobile /dashboard — stacked sections, live check-in card, bottom nav",
      `signed in (${signedIn}) + bottom nav visible (${bottomNavVisible})`,
      signedIn && bottomNavVisible,
    );

    await shoot(mPage, "/board", "02-mobile-board.png",
      "Mobile /board — cards + bottom nav, header collapsed to logo/bell/avatar",
      { name: "board heading", locatorText: "The Request Board" });
    await shoot(mPage, "/notifications", "03-mobile-notifications.png",
      "Mobile /notifications — list + bottom nav",
      { name: "notifications heading", locatorText: "Notifications" });
    await shoot(mPage, "/settings", "04-mobile-settings.png",
      "Mobile /settings — Profile tab target, Sign out at the bottom",
      { name: "sign out button", locatorText: "Sign out" });
    await mobile.close();

    // ---- items 4, 7, 8: desktop ----
    console.log("\nItems 4/7/8 — desktop (1280×900):");
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await desktop.addCookies(cookies);
    const dPage = await desktop.newPage();

    // item 4: day-14 gate
    await dPage.goto(`${BASE}/engagements/${gateEng}/feedback?type=final`, {
      waitUntil: "networkidle", timeout: 90_000,
    });
    const gateText = await dPage
      .getByText("unlocks on day 14", { exact: false })
      .isVisible()
      .catch(() => false);
    await dPage.screenshot({ path: join(OUT_DIR, "05-feedback-gate-day14.png"), fullPage: true });
    report("05-feedback-gate-day14.png",
      "Final feedback gate — tester15 on day 1 of Visual Gate App",
      `gate message visible (${gateText})`, gateText);

    // item 7: Feedback Hub rating flow
    await dPage.goto(`${BASE}/requests/${hubReq}/manage`, {
      waitUntil: "networkidle", timeout: 90_000,
    });
    const hubHeading = await dPage.getByText("Feedback Hub").isVisible().catch(() => false);
    const helpfulButton = dPage.getByRole("button", { name: "Helpful (+1 credit to tester)" });
    const buttonsBefore = await helpfulButton.count();
    await dPage.screenshot({ path: join(OUT_DIR, "06-hub-before-rating.png"), fullPage: true });
    report("06-hub-before-rating.png",
      "Feedback Hub — 2 finals (completed chips) + 1 mid + issue box, unrated",
      `hub heading (${hubHeading}) + ${buttonsBefore} helpful buttons`,
      hubHeading && buttonsBefore === 2);

    await helpfulButton.first().click();
    await dPage.getByText("Rated helpful — +1 bonus credit sent", { exact: false })
      .first().waitFor({ timeout: 30_000 });
    await dPage.screenshot({ path: join(OUT_DIR, "07-hub-rated-helpful.png"), fullPage: true });
    report("07-hub-rated-helpful.png",
      "After clicking Helpful — '+1 bonus credit sent' confirmation",
      "helpful confirmation rendered", true);

    await dPage.getByRole("button", { name: "Not helpful" }).first().click();
    // The revalidation may swap in the server-rendered rated state before the
    // transient client message — wait for whichever lands.
    await dPage
      .getByText("Rated not helpful", { exact: false })
      .or(dPage.getByText("Rating saved.", { exact: false }))
      .first()
      .waitFor({ timeout: 30_000 });
    await dPage.screenshot({ path: join(OUT_DIR, "08-hub-rated-not-helpful.png"), fullPage: true });
    report("08-hub-rated-not-helpful.png",
      "Second final rated Not helpful — muted state, no bonus",
      "not-helpful state rendered", true);

    // item 8: notifications sweep (bonus_credit just landed for tester01;
    // tester15 sees owner-side rows: joins + feedback received)
    await dPage.goto(`${BASE}/notifications`, { waitUntil: "networkidle", timeout: 60_000 });
    const sweepRow = await dPage
      .getByText("feedback", { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    await dPage.screenshot({ path: join(OUT_DIR, "09-notifications-sweep.png"), fullPage: true });
    report("09-notifications-sweep.png",
      "Notifications sweep — tester_joined ×4, feedback_received ×3 with links",
      `feedback rows visible (${sweepRow})`, sweepRow);
    await desktop.close();
  } finally {
    await browser.close();
  }

  // ---- gallery ----
  const gallery = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>LaunchTrain F4 — visual QA pass</title>
<style>
body{background:#09090b;color:#e4e4e7;font-family:system-ui,sans-serif;margin:2rem auto;max-width:1100px;padding:0 1rem}
h1{font-size:1.4rem} .shot{margin:2.5rem 0} .cap{font-weight:600;margin:.3rem 0}
.check{font-size:.85rem;color:#a1a1aa} .pass{color:#34d399} .fail{color:#f87171}
img{max-width:100%;border:1px solid #27272a;border-radius:12px}
</style></head><body>
<h1>LaunchTrain F4 — automated visual pass (${new Date().toISOString().slice(0, 10)})</h1>
<p>Authenticated as seed tester15 via a service-role-minted session. Items 1 / 4 / 7 / 8 of the F4 manual checklist.</p>
${shots
  .map(
    (s) => `<div class="shot"><p class="cap">${s.file} — ${s.caption}</p>
<p class="check ${s.pass ? "pass" : "fail"}">${s.pass ? "PASS" : "FAIL"}: ${s.check}</p>
<img src="${s.file}" alt="${s.caption}" loading="lazy"></div>`,
  )
  .join("\n")}
</body></html>\n`;
  writeFileSync(join(OUT_DIR, "index.html"), gallery);

  const failed = shots.filter((s) => !s.pass).length;
  console.log(`\n${shots.length - failed}/${shots.length} visual checks passed${failed ? ` — ${failed} FAILED` : " — ALL PASS"}`);
  console.log(`Gallery: docs/qa/f4/index.html (${shots.length} screenshots)`);
  process.exit(failed > 0 ? 1 : 0);
}

async function byEmail(admin: Admin, email: string) {
  const { data } = await admin
    .from("users")
    .select("id, email")
    .eq("email", email)
    .maybeSingle();
  if (!data) fail(`${email} not found — run npm run seed:testers`);
  return data;
}

main();
