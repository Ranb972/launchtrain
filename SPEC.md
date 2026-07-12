# LaunchTrain — Product Spec (SPEC.md)
**Version:** 1.5 | **Date:** 2026-07-12 | **UI language:** English only | **Target market:** Global (US/EU first)
**Status:** Source of truth for implementation. The Hebrew companion document is for the product owner; if they ever diverge, THIS file governs the code.
**Changelog:** 1.5 (2026-07-12) — F2 post-publish edit rules: identity/eligibility fields frozen after publish, slots grow-only with escrow-backed atomic growth. | 1.4 (2026-07-11) — device data integrity: manufacturer becomes a curated select (+ "Other" free text), Apple/iOS manufacturer values rejected, `android_version` bounded 8–30 in form, server action, and DB CHECK. | 1.3 and earlier — see git history.

> **Product thesis:** Everyone else sells testers. LaunchTrain sells the approval.
> The single success metric is the % of developers who obtain Google Play Production Access.
> Every feature in this document is judged against that metric.

---

## 0. Ground Rules for the Implementing Agent

1. **This file governs.** Read it before any task. On conflict or ambiguity between code, chat instructions, and SPEC.md — stop and ask the human (Ran). Never improvise product rules.
2. **TypeScript strict.** Next.js 16 App Router (approved upgrade from the originally specced 15, 2026-06-12; note: `middleware.ts` is `proxy.ts` in v16), Server Components by default, Tailwind only.
3. **All date/time logic in UTC.** A "day" boundary is UTC midnight. Streaks, check-ins, and clocks are computed in UTC everywhere (DB, cron, UI labels may localize display only).
4. **Credits move only through `credit_transactions` rows**, created inside the same DB transaction as the state change that caused them. The `users` table has NO balance column.
5. **RLS on every table.** `SUPABASE_SERVICE_ROLE_KEY` is used server-side only. Never expose secrets to the client. Never read or print `.env*` files in logs.
6. **`testing_email` privacy:** visible only to the owner of a request that this tester joined. Never in public pages, never in API responses to other users.
7. **The Dossier AI never fabricates data.** It only summarizes records that exist in the database. Missing data is reported as a gap. See Appendix B for the exact prompt.
8. **UI copy is English only.** Code, comments, and commit messages in English. Conversation with Ran in Hebrew.
9. **Every completed feature ends with a manual verification recipe:** a short numbered list of steps Ran performs in the browser to confirm it works. Ran's lived experience is the acceptance test, not self-reported success.
10. **Build in the phase order of §10.** Do not pull Phase 2/3 features forward.

---

## 1. Overview (MVP)

- **Problem:** A developer with a personal Google Play account (created after Nov 13, 2023) must run a closed test with **at least 12 testers opted-in simultaneously and continuously for 14 days** before applying for Production Access. Developers fail at three points: they can't find 12 reliable testers; testers drop out mid-window and break the 14-day streak; and even after 14 days, Google rejects them for shallow engagement and an empty submission form ("Testers were not engaged").
- **Solution:** A reciprocal marketplace where developers test each other's apps. Three mechanisms map to the three failure points: a request board with a built-in tester buffer (solves recruiting); credits held in escrow and released only after a full 14 days + final feedback (solves dropouts); and an AI engine that turns accumulated feedback into a **Submission Dossier** — a ready-made package with draft answers for Google's production access form (solves the rejection).
- **Target users:** Global vibe-coders and indie developers launching their first/second app on Google Play. English-speaking or working in English. Most users wear both hats (developer and tester) — the system is built on reciprocity.
- **Success metric:** North star: % of requests that complete 14 streak days and obtain Production Access (target: 80%+). Secondary: median time to fill 12 slots (target: < 72h post-founding-phase); tester dropout before day 14 (target: < 10%); requests whose 12-streak breaks (target: < 5%, thanks to the buffer).

---

## 2. Users & Personas (MVP)

### Persona A: The Developer (developer hat)
- **Role:** Developer
- **Goal:** Pass the 12/14 gate and get Production Access — fast, without chasing strangers on Facebook.
- **Key actions:** Creates a Test Request, confirms joined testers, monitors the 14-day streak and buffer, rates feedback, generates the Submission Dossier.

### Persona B: The Tester (tester hat)
- **Role:** Tester (at this stage almost always the same physical person as A)
- **Goal:** Earn credits to fund their own request, keep a high Reliability Score.
- **Key actions:** Browses the board, joins compatible tests, opts in, performs check-ins, submits mid and final feedback.

> **Architectural decision:** There are no separate user types. There are `users` who act in both hats. All permissions are per-action, not per-user-type.

### Persona C: Admin (Ran)
- **Role:** Admin
- **Goal:** Operate the founding phase, handle edge cases and fraud, tune the credit economy.
- **Key actions:** Manages `system_config` (flags and pricing), views all entities, `admin_adjust` credit moves, suspends users.

---

## 3. User Flows (MVP)

### Flow 1: Signup & Onboarding
**Trigger:** First visit, click "Board the Train".
**Steps:**
1. Landing page → "Sign in with Google" → Supabase Auth (OAuth) → redirected back, authenticated.
2. Onboarding form (single step): display name (default from Google), country (dropdown, ISO-2), testing Gmail (default = login email; editable — this is the email used for Play opt-in), and at least one device: manufacturer (curated select; "Other" reveals a required free-text input), model, Android version (8–30).
3. → Empty Dashboard with two CTAs: "Get your app tested" / "Test apps & earn credits".
**Success state:** User with complete profile + ≥1 device sees the Dashboard.
**Error states:** OAuth fails → error screen + Retry. User abandons onboarding → next login returns them to the form (not the Dashboard); no actions allowed before onboarding completes. Existing email → Supabase signs into existing account.

### Flow 2: Create Test Request (Developer)
**Trigger:** "New Test Request" from Dashboard.
**Steps:**
1. Form: app name, short description (≤ 300 chars), category (dropdown), join method — one of `email_list` (developer adds emails manually in Play Console) or `google_group` (testers self-join a Google Group), opt-in URL (required), group URL (required iff google_group), instructions for testers (what to test, ≤ 1000 chars), min Android version, slots_needed (1–20, **default 14** — UI explains: "Google requires 12 simultaneous testers. We recommend 14+ to absorb dropouts."), up to 4 screenshots + icon (optional, Supabase Storage).
2. Validation: opt-in URL must start with `https://play.google.com/apps/testing/`; the system extracts `package_name` from it automatically. Group URL must start with `https://groups.google.com/`.
3. Cost shown: `slots_needed × 1 credit` (during founding phase: 0, with a "Founding launch — free" badge). Insufficient balance → button locked + "You need X more credits" + link to the board ("Earn by testing").
4. Save as draft → preview screen → Publish → status `recruiting`, credits move from user balance into the request's escrow, request appears on the board.
**Success state:** Request in `recruiting` on the board; credits locked in request escrow.
**Error states:** Invalid URL → precise field error. Same `package_name` already active for this user → blocked ("You already have an active request for this app"). Insufficient credits → blocked as described. Upload failure → request saves without the image + notice.

### Flow 3: Join a Test (Tester)
**Trigger:** "Join this test" on a request page.
**Steps:**
1. Automatic eligibility checks: user has a device with Android version ≥ min? Not the request owner? Not already participating? Open slots remain? Reliability Score ≥ 60?
2. Tester picks which device they'll test with → an `engagement` is created in `pending_developer`.
3. By join method: `email_list` → the system reveals the tester's testing Gmail to the developer + notification "Add this email in Play Console, then confirm". Tester sees "Waiting for developer to add you". `google_group` → tester immediately receives both links (group + opt-in) and self-joins.
4. Tester opts in + installs → clicks "I've opted in & installed".
5. Developer verifies in Play Console (email_list: sees the email in the list; google_group: sees the opted-in counter rise) → clicks Confirm on the manage page → engagement becomes `confirmed`, the tester's personal 14-day clock starts, and 1 credit is earmarked for them in escrow.
**Success state:** Engagement `confirmed` with `confirmed_at`.
**Error states:** Developer doesn't confirm within 48h → automatic reminder to developer. Within 72h → tester may cancel with no Reliability penalty; slot reopens. Slots filled between viewing and clicking → "This test just filled up". Incompatible device → Join button locked with explanation.

### Flow 4: The 14-Day Track (Tester) — the Two-Clock Mechanism
**Trigger:** Engagement becomes `confirmed`.
**Core definition (critical to implement correctly):** There are two separate clocks —
- **Engagement clock (per tester):** counts 14 consecutive days from `confirmed_at`. At its end + final feedback submission → escrow release to the tester. Fair to the tester even if the request as a whole is delayed.
- **Request clock (per request):** Google requires **12 testers simultaneously, continuously, for 14 days**. Therefore the request's `streak_days` advances on a given day only if `confirmed_count ≥ 12` throughout that entire UTC day (daily cron check). Dropping below 12 → streak resets to 0, request becomes `at_risk`, gets a priority boost on the board, and the developer receives an urgent notification.
**Steps:**
1. Dashboard → "My Tests": each active engagement shows Day X/14, a Check-in button, status.
2. Check-in = "I opened the app today" + choice: "Works fine" / "Found an issue" (+ note field, required if issue). Required minimum: **3 check-ins per week** per engagement. One check-in per engagement per UTC day (button locks after use until UTC midnight).
3. Day 7: system requests mid-test feedback (short form). Day 14: final feedback (full form, see Flow 5).
4. Final feedback submitted on/after day 14 → engagement becomes `completed`, escrow release: +1 credit from the request escrow to the tester, +2 Reliability Score.
**Success state:** `completed` + credit settled for the tester.
**Error states:** No check-in for 3 days → reminder email to tester. No check-in for 5 days → engagement `at_risk`, developer notified with a "Request replacement" option (opens an extra slot without dropping the tester yet). Tester opts out / clicks "Drop out" → status `dropped`: the credit stays in the request escrow, the slot reopens with priority, tester takes −15 Reliability. Reliability < 60 → blocked from joining new tests for 14 days (cooldown).

### Flow 5: Feedback → Submission Dossier (Developer)
**Trigger:** Every incoming feedback updates the request's Feedback Hub; when `streak_days ≥ 14`, the "Generate Submission Dossier" button unlocks.
**Steps:**
1. Final feedback structure (tester side): 1–5 ratings: stability, UX, value; bug list (text + severity: low/medium/high); suggestions (free text); usage_frequency (daily / few times a week / once or twice); device carried from the engagement.
2. The developer may rate each feedback: helpful → tester receives +1 bonus credit (source: system mint — a deliberate quality incentive, once per feedback).
3. Generate → the server calls the AI Provider layer (default: Google Gemini) with all feedback + engagement data (devices, check-in timeline, streak) and a prompt that produces, in English: Device Coverage Matrix; Engagement Summary (real numbers: testers, check-ins, days); Consolidated Bug List with a "Fixed?" column the developer can mark; Draft answers to Google's Production Access form questions.
4. The Dossier is saved, editable (markdown editor), with Copy + Export buttons.
**Built-in red line (non-negotiable, see Appendix B):** the AI summarizes ONLY feedback that exists in the system. It must never invent testers, quotes, or numbers. Thin data → the Dossier explicitly lists the gaps and what to collect. A platform caught by Google fabricating evidence is dead — this is a quality bar, not a suggestion.
**Success state:** Dossier saved and displayed; developer copies answers into Google's form.
**Error states:** AI call fails → 3 retries with exponential backoff → "Generation failed, try again". Fewer than 8 final feedbacks → button stays active but shows a warning: "Dossier will be thin — consider waiting for more final feedback".

### Flow 6: Founding Phase (cold-start solution)
**Trigger:** `system_config.founding_phase = true` (launch mode).
**Steps:**
1. While the flag is on: publishing a request costs 0 (up to `founding_cap` = 100 requests). Earning works normally — testers accumulate real credits.
2. Anyone who published or completed a test during the phase → `is_founding_member = true` + a permanent profile badge.
3. Board sorting during the phase boosts requests from users who actively test (ratio of active tests to own requests) — a free-rider brake.
4. Admin turns the flag off once liquidity exists → normal pricing applies, and the economy is already populated with work-backed credits.
**Success state:** First 100 requests run; real credits in the system; a core community with badges.
**Error states:** Abuse (user posts but never tests) → their request sinks in the sort; Admin may suspend. Cap reached → new requests automatically revert to normal pricing + a transparent notice.

### Flow 7: Notifications
**Trigger:** System events.
**Channels:** in-app (notifications table + bell icon) + email (Resend, English templates).
**Events:** tester joined (→developer) | confirm needed + 48h reminder (→developer) | you're confirmed, clock started (→tester) | check-in reminder day 3 (→tester) | engagement at risk (→both) | request reached 12 — Google clock started (→developer) | streak broken — refill now (→developer, urgent) | day 14 complete (→both) | dossier ready (→developer) | escrow released +X credits (→tester) | tester dropped, slot reopened (→developer).
**Success state:** Every event creates an in-app record; email-flagged events also send a mail.
**Error states:** Email send failure → logged, in-app record remains; max 3 retries.

---

## 4. Feature Breakdown (MVP)

### Feature F1: Auth & Profiles
- **Description:** Google-only sign-in (Supabase Auth OAuth); profile with testing details and devices.
- **User-facing behavior:** Single "Sign in with Google" button. Settings page: edit display name, country, testing Gmail, manage devices (add/remove; manufacturer is a curated select with an "Other" free-text option, same as onboarding). Public profile page: name, badges, Reliability Score, completed-tests counter.
- **Business logic:** User is blocked from all actions until onboarding completes (profile + ≥1 device). `testing_email` defaults to login email. Default `role` = `user`. Device data is Google Play-only: manufacturer values matching apple/iphone/ipad/ios (case-insensitive) are rejected server-side; `android_version` must be 8–30, enforced in the form, the server action, and a DB CHECK.
- **Edge cases:** Deleting a device linked to an active engagement → blocked. Changing `testing_email` while any engagement is active → blocked (it's already on developers' lists).
- **Priority:** MVP

### Feature F2: Test Request Board
- **Description:** Public board of `recruiting`/`at_risk` requests + request pages + request creation/management.
- **User-facing behavior:** `/board` — cards: icon, name, category, slots filled/needed, min Android, credits per test, "Founding" badge. Filters: category, min Android version, "compatible with my devices". Sort: `at_risk` first (priority refill), then reciprocity boost, then `published_at`. Public request page (read-only for guests — SEO; Join requires login). Manage page for the owner: engagement list with statuses, Confirm buttons, streak clock, buffer indicator.
- **Business logic:** Request statuses: `draft → recruiting → active (streak running) ↔ at_risk → completed / cancelled / expired`. `recruiting` with zero confirms for 30 days → `expired` + full escrow refund. Cancel by owner: unfilled slots → refund; active engagements → immediate escrow release to those testers (fairness rule).
- **Post-publish edit rules (v1.5, approved):** after publish, `package_name`, `opt_in_url`, `group_url`, `join_method`, `app_name`, `category`, and `min_android_version` are FROZEN — fixing one means cancel and republish. `description`, `instructions`, and screenshots/icon stay editable. `slots_needed` may only increase (max 20), never decrease; on non-founding requests an increase creates matching `spend_post`/`escrow_hold` rows in the same DB transaction, so every slot stays escrow-backed (preserves the F6 mint = burn invariant). Founding requests grow free, consistent with their free publish. Enforced in the server actions and backstopped by a DB trigger.
- **Edge cases:** Public pages never expose testers' testing emails. Two users hit Join on the last slot → atomic transaction; the loser gets "This test just filled up".
- **Priority:** MVP

### Feature F3: Engagement Lifecycle & Two Clocks
- **Description:** The engagement state machine and the two clocks (engagement clock + request streak) — the heart of the system.
- **User-facing behavior:** "My Tests" for the tester (Day X/14, check-in, status); manage page for the developer (live buffer: "13 of 14 slots confirmed — streak day 6").
- **Business logic:** Engagement states: `pending_developer → confirmed → at_risk ↔ confirmed → completed | dropped | cancelled`. Daily cron (00:15 UTC): for each request — if `confirmed_count ≥ 12` held throughout the previous UTC day → `streak_days++`; else `streak_days = 0` + transition to `at_risk` + notifications. For each engagement — compute days since `confirmed_at`; mark `at_risk` if no check-in for 5 days; send day-3 reminders.
- **Edge cases:** All day math in UTC. A tester who joined, dropped, and rejoins → a new engagement; their clock restarts. Developer confirms after the tester already cancelled → fails gracefully.
- **Priority:** MVP

### Feature F4: Check-ins & Structured Feedback
- **Description:** Collecting the engagement evidence: daily check-ins, mid-test (day 7), final feedback (day 14).
- **User-facing behavior:** Big check-in button in My Tests; short structured forms (no essays) — one minute to fill.
- **Business logic:** Check-in: once per engagement per UTC day, minimum 3 per week. Final feedback unlocks from engagement day 14. Reliability Score: starts at 100; `completed` +2 (cap 100); `dropped` −15; `at_risk` −5; below 60 → 14-day join cooldown.
- **Edge cases:** An "issue" check-in requires a note. Feedback is immutable after submission (evidential integrity) — an addendum note may be added.
- **Priority:** MVP

### Feature F5: AI Submission Dossier
- **Description:** Engine converting all feedback and telemetry into a submission package for the Production Access form.
- **User-facing behavior:** Generate button on the manage page (unlocks at streak ≥ 14); Dossier screen with edit, Copy, Export.
- **Business logic:** Server-side call through the AI Provider layer (see §5.1); the prompt receives ONLY database data; `model_version` recorded as `provider:model`. Regenerate allowed (overwrites, with confirmation).
- **Edge cases:** Red line: no fabricated data — data shortage is reported as a gap. API failure → 3 retries + message.
- **Priority:** MVP

### Feature F6: Credits Ledger with Escrow
- **Description:** A full ledger, ready from day one to carry real money later without a rewrite.
- **User-facing behavior:** Balance in header; Transactions page (full history); "How credits work" explainer.
- **Business logic:** `credit_transactions` is the only source of truth — no balance column on users; available balance = sum of `settled` rows (`balance_after` stored for performance). Transaction types: `spend_post` (publish: −slots, settled), `escrow_hold` (request side), `escrow_release` (+1 to tester, settled), `refund` (cancel/expiry), `bonus` (+1 helpful, settled, system source), `admin_adjust`. **Monetary balance:** mint (1 per completed test) = burn (1 per slot) — the only deliberate inflation is the quality bonus. During `founding_phase`: `spend_post` = 0.
- **Edge cases:** Every transaction is atomic with the state change that caused it (single DB transaction). No transaction may exist without `engagement_id` or `request_id` (except `admin_adjust`).
- **Priority:** MVP

### Deferred (detailed in §10):
- **F7 Launch Trains (automated cohorts)** — Phase 2
- **F8 Reputation Tiers & Badges** (beyond the basic score) — Phase 2
- **F9 Developer Analytics Dashboard** — Phase 2
- **F10 Deep-link Engagement Verification** — Phase 3
- **F11 PWA + Web Push** — Phase 3
- **F12 SEO Content Hub** — Phase 3
- **F13 Real-money Payouts** — out of scope (the ledger is ready; separate business decision)

---

## 5. Technical Architecture (MVP)

- **Stack:**
  - Frontend: Next.js 16 (App Router) + TypeScript (strict) + Tailwind CSS v4
  - Backend: Next.js Route Handlers + Server Actions (no separate server)
  - Scheduled jobs: Vercel Cron → `/api/cron/daily-clocks` (daily 00:15 UTC), `/api/cron/reminders` (hourly)
  - DB / Auth / Storage: Supabase (Postgres + Row Level Security, Google OAuth, Storage for images)
  - Email: Resend
  - AI: **Vercel AI SDK as a provider abstraction** — see §5.1
  - Hosting: Vercel (Hobby tier is enough at launch)

### 5.1 AI Provider Layer (feasibility-first, swap-ready)
- **Packages:** `ai`, `@ai-sdk/google`, `@ai-sdk/anthropic`, `@ai-sdk/openai`.
- **Module:** `lib/ai/provider.ts` exports `getModel()` which reads `AI_PROVIDER` (`google` | `anthropic` | `openai`) and `AI_MODEL` from env and returns the corresponding AI SDK model instance. No other file imports a provider SDK directly.
- **Defaults:** `AI_PROVIDER=google`, `AI_MODEL=gemini-2.5-flash` (free tier — feasibility stage). Swap targets: `anthropic` / `claude-sonnet-4-6`, `openai` / current GPT model. **Verify current model IDs at build time** — do not hardcode model names outside env defaults.
- **Call shape:** `generateText` with `temperature: 0.3`, `maxOutputTokens: 4000`; 3 retries with exponential backoff; on success store `model_version = "${AI_PROVIDER}:${AI_MODEL}"` on the dossier.
- **Rate-limit note:** Gemini free tier has per-minute/per-day caps; dossier generation is a rare event (once per completed request) and fits comfortably. If a 429 persists after retries, surface "Generation is busy — try again in a minute."

### 5.2 Environment Variables
| Var | Example | Scope / Notes |
|---|---|---|
| NEXT_PUBLIC_SUPABASE_URL | https://xxxx.supabase.co | client+server |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | eyJ... | client+server |
| SUPABASE_SERVICE_ROLE_KEY | eyJ... | **server only** (cron, admin) |
| AI_PROVIDER | google | google / anthropic / openai |
| AI_MODEL | gemini-2.5-flash | provider-matching model ID |
| GOOGLE_GENERATIVE_AI_API_KEY | AIza... | required while AI_PROVIDER=google |
| ANTHROPIC_API_KEY | sk-ant-... | optional until swap |
| OPENAI_API_KEY | sk-... | optional until swap |
| RESEND_API_KEY | re_... | server only |
| EMAIL_FROM | LaunchTrain <noreply@domain> | sender identity |
| CRON_SECRET | random-string | guards /api/cron/* |
| NEXT_PUBLIC_APP_URL | http://localhost:3000 | links in emails |

- **System diagram:**
```
Browser ── Next.js (Vercel) ──┬── Supabase Postgres (RLS)
   │            │             ├── Supabase Auth (Google OAuth)
   │            │             └── Supabase Storage (screenshots)
   │            ├── Resend API (emails)
   │            └── AI Provider Layer → Gemini / Claude / OpenAI (dossier)
   └── Vercel Cron ──→ /api/cron/* ──→ Postgres (clocks, reminders)
```
- **Third-party services:** Supabase, Resend, Google AI (Gemini — feasibility stage), Anthropic/OpenAI (swap-ready), Vercel. No payments in MVP.
- **Auth model:** Google OAuth only. Guests: Landing, Board, request pages (read-only), content pages. Every write action + Dashboard → session required. RLS: public read for published requests; users write/read only entities they own; a tester's `testing_email` is exposed only to the owner of the request they joined; `role=admin` bypasses. Secrets live in Vercel env only — never client-side.

---

## 6. Data Model (MVP)

### users
| Field | Type | Required | Notes |
|---|---|---|---|
| id | uuid | yes | PK, = auth.users.id |
| email | text | yes | from OAuth |
| testing_email | text | yes | default = email |
| display_name | text | yes | |
| country | text | yes | ISO-2; DB default `''` until onboarding completes, CHECK enforces ISO-2 once onboarded |
| avatar_url | text | no | from Google |
| role | enum(user,admin) | yes | default user |
| reliability_score | int | yes | default 100, range 0–100 |
| is_founding_member | bool | yes | default false |
| onboarded_at | timestamptz | no | null = onboarding incomplete |
| created_at | timestamptz | yes | |

> **Row creation:** a DB trigger creates the profile row at first sign-in (display name from Google metadata, `testing_email` = login email, `country` = `''` placeholder). `onboarded_at` stays NULL until onboarding completes; a DB guard allows setting it only with a real country, display name, and ≥1 device. A DB guard also freezes `testing_email` while any engagement is active (pending_developer/confirmed/at_risk).

### devices
| Field | Type | Required | Notes |
|---|---|---|---|
| id | uuid | yes | PK |
| user_id | uuid | yes | FK → users |
| manufacturer | text | yes | curated select (Samsung, Google, Xiaomi, OnePlus, Oppo, Vivo, Motorola, Huawei, Honor, Realme, Nothing, Sony, Asus) or free text via "Other"; Apple/iOS values rejected — Google Play only |
| model | text | yes | |
| android_version | int | yes | API major, e.g. 14; range 8–30 (DB CHECK — Android 8.0 Oreo floor, generous future ceiling) |
| created_at | timestamptz | yes | |

### test_requests
| Field | Type | Required | Notes |
|---|---|---|---|
| id | uuid | yes | PK |
| owner_id | uuid | yes | FK → users |
| app_name | text | yes | |
| package_name | text | yes | extracted from opt-in URL |
| description | text | yes | ≤ 300 |
| category | enum | yes | games, productivity, social, tools, lifestyle, education, finance, health, other |
| join_method | enum(email_list,google_group) | yes | |
| opt_in_url | text | yes | validated prefix |
| group_url | text | conditional | required iff google_group |
| instructions | text | yes | ≤ 1000 |
| min_android_version | int | yes | |
| slots_needed | int | yes | 1–20, default 14 |
| status | enum | yes | draft, recruiting, active, at_risk, completed, cancelled, expired |
| streak_days | int | yes | default 0 |
| clock_started_at | timestamptz | no | first time ≥12 was reached |
| is_founding | bool | yes | default false |
| icon_url / screenshots | text / jsonb | no | Storage paths |
| created_at / published_at | timestamptz | yes/no | |

> **Unique constraint:** one non-terminal request per (owner_id, package_name) — draft/recruiting/active/at_risk block a duplicate; completed/cancelled/expired do not.
> **Public visibility (RLS):** guests read statuses recruiting/at_risk/active/completed; draft is owner-only; cancelled/expired are not publicly readable.

### engagements
| Field | Type | Required | Notes |
|---|---|---|---|
| id | uuid | yes | PK |
| request_id | uuid | yes | FK → test_requests |
| tester_id | uuid | yes | FK → users |
| device_id | uuid | yes | FK → devices |
| status | enum | yes | pending_developer, confirmed, at_risk, completed, dropped, cancelled |
| joined_at | timestamptz | yes | |
| opted_in_at | timestamptz | no | set by markOptedIn ("I've opted in & installed") |
| confirmed_at | timestamptz | no | personal clock start |
| completed_at | timestamptz | no | |
| last_checkin_at | timestamptz | no | |
| checkin_count | int | yes | default 0 |

> **Unique constraint:** (request_id, tester_id) among non-terminal rows — one tester per request. A re-join after drop = a new row, allowed only if the previous row is dropped/cancelled.

### checkins
| Field | Type | Required | Notes |
|---|---|---|---|
| id | uuid | yes | PK |
| engagement_id | uuid | yes | FK → engagements |
| status | enum(ok,issue) | yes | |
| note | text | conditional | required if issue |
| created_at | timestamptz | yes | unique per (engagement_id, UTC date) |

### feedback
| Field | Type | Required | Notes |
|---|---|---|---|
| id | uuid | yes | PK |
| engagement_id | uuid | yes | FK → engagements |
| type | enum(mid,final) | yes | unique per (engagement_id, type) |
| stability / ux / value | int | yes | 1–5 |
| bugs | jsonb | yes | [{text, severity}] may be empty |
| suggestions | text | no | |
| usage_frequency | enum(daily,few_weekly,rarely) | yes | |
| developer_rating | enum(helpful,not_helpful) | no | triggers bonus once |
| addendum | text | no | post-submission addendum note; all other fields immutable after submit (F4) |
| created_at | timestamptz | yes | |

### credit_transactions
| Field | Type | Required | Notes |
|---|---|---|---|
| id | uuid | yes | PK |
| user_id | uuid | yes | FK → users (credited/debited side) |
| amount | int | yes | positive/negative |
| type | enum | yes | spend_post, escrow_hold, escrow_release, refund, bonus, admin_adjust |
| status | enum(pending,settled,cancelled) | yes | escrow = pending |
| request_id | uuid | conditional | FK → test_requests |
| engagement_id | uuid | conditional | FK → engagements |
| balance_after | int | yes | settled balance after this row |
| created_at | timestamptz | yes | |

### dossiers
| Field | Type | Required | Notes |
|---|---|---|---|
| id | uuid | yes | PK |
| request_id | uuid | yes | FK → test_requests, unique |
| content_md | text | yes | |
| model_version | text | yes | format provider:model |
| generated_at | timestamptz | yes | |

### notifications
| Field | Type | Required | Notes |
|---|---|---|---|
| id | uuid | yes | PK |
| user_id | uuid | yes | FK → users |
| type | text | yes | from the Flow 7 list |
| payload | jsonb | yes | ids + text |
| emailed_at / read_at | timestamptz | no | |
| created_at | timestamptz | yes | |

### system_config
| Field | Type | Required | Notes |
|---|---|---|---|
| key | text | yes | PK: founding_phase, founding_cap, founding_used, credit_price_per_slot, checkin_min_weekly |
| value | jsonb | yes | |

**Relationships:**
- users — has many → devices, test_requests (as owner), engagements (as tester), credit_transactions, notifications
- test_requests — has many → engagements, credit_transactions; has one → dossiers
- engagements — has many → checkins, feedback (max 2); belongs to → users (tester), devices, test_requests
- credit_transactions — belongs to → users; optionally → test_requests / engagements

---

## 7. API / Routes (MVP)

### Pages (App Router)
| Route | Description | Auth |
|---|---|---|
| / | Landing: thesis, how it works, CTA | No |
| /board | Request board + filters | No (read-only) |
| /requests/[id] | Public request page | No (Join requires login) |
| /requests/new | Create request (form + preview) | Yes |
| /requests/[id]/manage | Manage: engagements, confirms, streak, buffer | Yes (owner) |
| /requests/[id]/dossier | View/edit Dossier | Yes (owner) |
| /dashboard | My Requests + My Tests + check-ins | Yes |
| /profile/[id] | Public profile: badges, reliability, counters | No |
| /settings | Profile, devices, testing email | Yes |
| /credits | Balance + Transactions + How credits work | Yes |
| /admin | Config, entity search, admin_adjust, suspensions | Yes (admin) |
| /onboarding | Profile completion form | Yes |

### Server Actions / API
| Method | Route / Action | Description | Auth |
|---|---|---|---|
| POST | createRequest | Create draft + validations + package extraction | Yes |
| POST | publishRequest | draft→recruiting + atomic spend_post/escrow_hold | Yes (owner) |
| POST | cancelRequest | Cancel + refunds/releases per the rules | Yes (owner) |
| POST | joinTest | Eligibility + engagement creation (atomic vs slots) | Yes |
| POST | markOptedIn | Tester marks opted-in & installed | Yes (tester) |
| POST | confirmEngagement | pending→confirmed, personal clock starts | Yes (owner) |
| POST | dropEngagement | Voluntary drop + consequences | Yes (tester) |
| POST | requestReplacement | Open extra slot for an at_risk engagement | Yes (owner) |
| POST | createCheckin | Daily check-in (unique per UTC day) | Yes (tester) |
| POST | submitFeedback | mid/final + completed/escrow_release trigger | Yes (tester) |
| POST | rateFeedback | helpful → bonus (idempotent) | Yes (owner) |
| POST | generateDossier | AI Provider call + save | Yes (owner) |
| GET | /api/notifications | List notifications + mark read | Yes |
| POST | /api/cron/daily-clocks | Streaks, engagement days, at_risk, expiry | CRON_SECRET |
| POST | /api/cron/reminders | Check-in / confirm reminders | CRON_SECRET |
| POST | adminAdjust / adminConfig | Admin operations | Yes (admin) |

> **Quality bar:** every feature in §4 is covered by a row here; no orphan endpoints.

---

## 8. UI/UX Requirements (MVP)

- **Pages/screens:** the 12 pages of §7. UI language: **English only**. Tone: friendly-playful but professional ("All aboard", "Next station: Production") — sparingly; short copy.
- **Navigation:** Persistent header: Logo | Board | Dashboard | Credits (balance) | bell | Avatar. Mobile: bottom nav (Board / My Tests / My Requests / Profile).
- **Responsive:** Mobile-first — testers check in from their phones. Standard Tailwind breakpoints (sm/md/lg).
- **Key UI components:** RequestCard, SlotBuffer (visual 14/12), **TrackProgress** — a railway-track progress bar with 14 stations (the brand's signature component), CheckinButton (done/locked states), StatusChip, FeedbackForm, CreditBadge, NotificationBell, DossierViewer.
- **Design direction:** railway-journey metaphor: signal-green accent on dark neutrals; station/ticket iconography. Clean, not cartoonish. (Full visual pass at build time with the frontend-design skill.)
- **Empty states:** every page defines one, with a CTA (empty board → "Be the first to board"; empty My Tests → "Earn your first credit").

---

## 9. MVP Scope (MVP)

### ✅ In MVP (Round 1 — six features):
- F1 Auth & Profiles (Google OAuth, devices, testing email)
- F2 Test Request Board (create, board, request page, manage)
- F3 Engagement Lifecycle & Two Clocks (incl. cron, at_risk, buffer)
- F4 Check-ins & Structured Feedback (incl. basic Reliability Score)
- F5 AI Submission Dossier (via the AI Provider layer)
- F6 Credits Ledger with Escrow (incl. Founding Phase flag)

### ❌ NOT in MVP (deliberately deferred):
- F7 Automated Launch Trains → Phase 2 (in Round 1 the "train" is the brand metaphor and the track UI, not a cohort feature)
- F8 Reputation Tiers & Badges beyond the score → Phase 2
- F9 Developer Analytics → Phase 2
- F10 Deep-link Verification → Phase 3
- F11 PWA + Web Push → Phase 3
- F12 SEO Content Hub → Phase 3
- F13 Real-money payouts → out of scope; the ledger is ready

---

## 10. Development Phases (FULL)

### Phase 1 — MVP "The Working Line" (Round 1)
- Scaffold: Next.js + Supabase + Auth + full schema incl. RLS — **M**
- F1 Profiles & devices — **S**
- F2 Board + request create/manage + Storage — **M**
- F3 Engagement loop + the two clocks + cron — **L** (the core; build first after the schema)
- F4 Check-ins + feedback forms + reliability — **M**
- F6 Ledger + escrow + founding flag — **M**
- F5 Dossier (AI Provider layer) — **M**
- Emails (Resend) + in-app notifications — **S**
- **Goal:** A real developer goes end-to-end: sign up → publish → 14 testers join and get confirmed → streak reaches 14 → Dossier generated → credits released. This is the 0.8 — no step of the experience is missing.

### Phase 2 — "Full Steam" (Round 2 → v1.0)
- F7 Launch Trains: automatic cohort formation (13 synced requests, shared train page, countdown), credit-neutral
- F8 Tiers & Badges (Conductor, First Class, ...) on top of the existing score
- F9 Developer analytics: streak graph, device map, engagement heatmap
- Board upgrades: search, saved filters
- **Goal:** A returning user gets a reason to stay: status, data, and trains that fill a request within hours.

### Phase 3 — "Express" (Round 3)
- F10 Deep-link verification (real open-event verification, optional per developer)
- F11 PWA + Web Push (check-in reminders without email)
- F12 SEO Content Hub: "12 testers / production access" guides — the category's acquisition engine
- i18n infrastructure (no actual translations yet)
- **Goal:** Organic user acquisition + verification credibility competitors don't offer for free.

---

## 11. Open Questions

- [ ] **Domain:** check availability of launchtrain.com / .dev / .app and purchase before first deploy (10 minutes, Namecheap). Blocks publishing, not development.
- [ ] **founding_cap:** default 100 requests — confirm or change before launch (business decision, not technical).
- [ ] **Minimum check-in cadence:** 3/week default in system_config — calibrate after real founding-cohort data.
- [ ] **Founding cohort recruitment:** channels — the Facebook groups where the pain was first observed, r/AndroidClosedTesting and similar subreddits, vibe-coding communities. Prepare an English launch post (content task, not code).
- [ ] **Dossier engine upgrade:** after validating quality on free Gemini — decide whether to switch to Claude; env-only change.
- [ ] **Payments (future):** Stripe Connect vs alternatives — deferred until usage data exists; the ledger already supports it.

---

## Appendix A: Ground-Truth Anchors (Source of Truth)

1. Google's requirement: **at least 12 testers opted-in simultaneously, continuously for 14 days**, for personal accounts created after Nov 13, 2023. The tester count was reduced from 20 to 12 in December 2024. The system is built around this exact wording (hence the streak mechanism and the buffer).
2. Google's Production Access form evaluates testing **quality**, not just the count — hence the Dossier.
3. The AI never invents testing data. A data gap is reported as a gap.

## Appendix B: Dossier Generation Prompt (skeleton)

System prompt for the AI Provider call (final wording may be tuned, the rules may not):

```
You generate a "Submission Dossier" for a Google Play closed-testing campaign.

NON-NEGOTIABLE RULES:
- Use ONLY the JSON data provided in this request. Never invent testers,
  quotes, numbers, devices, dates, or feedback.
- If data is missing or thin, say so explicitly in a "Gaps & Recommendations"
  section instead of filling the hole.
- Output language: English. Output format: markdown.

OUTPUT SECTIONS (in this order):
1. Device Coverage Matrix (manufacturer / model / Android version / tester count)
2. Engagement Summary (testers confirmed, total check-ins, streak days, dates)
3. Consolidated Bug List (deduplicated, with severity and a "Fixed?" checkbox column)
4. Improvements Made During Testing (ONLY items the developer marked as fixed)
5. Draft Answers for the Google Play production access questions
   (testing process, tester recruitment, feedback collected, changes made)
6. Gaps & Recommendations
```

User content of the call: a single JSON object with `request`, `engagements` (incl. devices and check-in timelines), and `feedback` arrays, exactly as stored in the database.
