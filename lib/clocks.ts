// Pure two-clock math and engagement state-transition guards (SPEC Flow 3/4,
// F3). These functions MIRROR the authoritative Postgres logic in
// supabase/migrations/20260717120000_f3_engagement_lifecycle.sql — the DB
// functions are the source of truth; this module exists so pages can
// pre-render eligibility/labels and so the rules are unit-testable.
// All day math is UTC; a "day" boundary is UTC midnight (SPEC §0.3).

export const GOOGLE_REQUIRED_TESTERS = 12;
export const STREAK_TARGET_DAYS = 14;
export const ENGAGEMENT_CLOCK_DAYS = 14;
export const ENGAGEMENT_AT_RISK_DAYS = 5;
export const CONFIRM_REMINDER_HOURS = 48;
export const PENDING_CANCEL_EMPHASIS_HOURS = 72;
export const RELIABILITY_JOIN_MIN = 60;
export const DROP_PENALTY = 15;

const DAY_MS = 86_400_000;

// Whole UTC days since the epoch for a timestamp or YYYY-MM-DD date string.
export function utcDayNumber(iso: string): number {
  return Math.floor(Date.parse(iso) / DAY_MS);
}

// YYYY-MM-DD (UTC) of a timestamp.
export function utcDateString(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function dayNumberToDateString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

// ------------------------------------------------------------
// Engagement clock (per tester): Day X of 14 from confirmed_at.
// Day 1 = the UTC day of confirmation.
// ------------------------------------------------------------

export function engagementDay(confirmedAt: string, now: string | Date): number {
  const nowIso = typeof now === "string" ? now : now.toISOString();
  return utcDayNumber(nowIso) - utcDayNumber(confirmedAt) + 1;
}

// Display form, capped: "Day 14/14" from day 14 onward.
export function engagementDayLabel(confirmedAt: string, now: string | Date): string {
  const day = Math.min(ENGAGEMENT_CLOCK_DAYS, Math.max(1, engagementDay(confirmedAt, now)));
  return `Day ${day}/${ENGAGEMENT_CLOCK_DAYS}`;
}

// 5 days without activity → at_risk. Until check-ins exist (F4), activity
// falls back to confirmed_at (approved F3 rule).
export function isEngagementInactive(
  lastCheckinAt: string | null,
  confirmedAt: string,
  now: string | Date,
): boolean {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  const activityMs = Date.parse(lastCheckinAt ?? confirmedAt);
  return activityMs < nowMs - ENGAGEMENT_AT_RISK_DAYS * DAY_MS;
}

// ------------------------------------------------------------
// Request streak (per request): mirror of the daily-clocks cron credit step.
// streak_ok_since = when confirmed_count last rose to >= 12 (null when below).
// streak_last_counted_day = last UTC day already credited (idempotency).
// The cron credits every COMPLETE UTC day after streak_ok_since's date, up to
// and including yesterday.
// ------------------------------------------------------------

export function computeStreakCredit(input: {
  streakOkSince: string | null;
  lastCountedDay: string | null; // YYYY-MM-DD
  today: string; // YYYY-MM-DD (UTC date the cron runs on)
}): { add: number; lastCountedDay: string | null } {
  const { streakOkSince, lastCountedDay, today } = input;
  if (!streakOkSince) return { add: 0, lastCountedDay };

  const yesterday = utcDayNumber(today) - 1;
  // First creditable day = the first full UTC day after the window opened.
  let from = utcDayNumber(utcDateString(streakOkSince)) + 1;
  if (lastCountedDay !== null) {
    from = Math.max(from, utcDayNumber(lastCountedDay) + 1);
  }
  const add = yesterday - from + 1;
  if (add <= 0) return { add: 0, lastCountedDay };
  return { add, lastCountedDay: dayNumberToDateString(yesterday) };
}

// ------------------------------------------------------------
// Join eligibility (SPEC Flow 3 step 1) — pre-render mirror of join_test.
// Ordered exactly like the DB checks so the UI shows the same first blocker.
// ------------------------------------------------------------

export type JoinBlockReason =
  | "not_joinable"
  | "own_request"
  | "reliability_low"
  | "cooldown"
  | "no_compatible_device"
  | "already_joined"
  | "full";

export type JoinEligibilityInput = {
  requestStatus: string;
  isOwner: boolean;
  reliabilityScore: number;
  joinBlockedUntil: string | null;
  deviceVersions: number[]; // the tester's devices
  minAndroidVersion: number;
  alreadyJoined: boolean; // a non-terminal engagement exists
  occupiedCount: number;
  slotsNeeded: number;
  now: string | Date;
};

export const JOINABLE_STATUSES = ["recruiting", "active", "at_risk"] as const;

export function joinEligibility(
  input: JoinEligibilityInput,
): { ok: true } | { ok: false; reason: JoinBlockReason } {
  const nowMs =
    typeof input.now === "string" ? Date.parse(input.now) : input.now.getTime();

  if (!(JOINABLE_STATUSES as readonly string[]).includes(input.requestStatus)) {
    return { ok: false, reason: "not_joinable" };
  }
  if (input.isOwner) return { ok: false, reason: "own_request" };
  if (input.reliabilityScore < RELIABILITY_JOIN_MIN) {
    return { ok: false, reason: "reliability_low" };
  }
  if (
    input.joinBlockedUntil !== null &&
    Date.parse(input.joinBlockedUntil) > nowMs
  ) {
    return { ok: false, reason: "cooldown" };
  }
  if (!input.deviceVersions.some((v) => v >= input.minAndroidVersion)) {
    return { ok: false, reason: "no_compatible_device" };
  }
  if (input.alreadyJoined) return { ok: false, reason: "already_joined" };
  if (input.occupiedCount >= input.slotsNeeded) return { ok: false, reason: "full" };
  return { ok: true };
}

// ------------------------------------------------------------
// Transition guards — mirror of confirm_engagement / drop_engagement.
// ------------------------------------------------------------

export type EngagementStatus =
  | "pending_developer"
  | "confirmed"
  | "at_risk"
  | "completed"
  | "dropped"
  | "cancelled";

export type ConfirmOutcome =
  | "ok"
  | "tester_cancelled"
  | "already_confirmed"
  | "not_pending";

export function confirmOutcome(status: EngagementStatus): ConfirmOutcome {
  if (status === "pending_developer") return "ok";
  if (status === "cancelled") return "tester_cancelled";
  if (status === "confirmed" || status === "at_risk") return "already_confirmed";
  return "not_pending";
}

export type DropOutcome =
  | "cancel_no_penalty" // pending_developer → cancelled (approved A5)
  | "drop_with_penalty" // confirmed/at_risk → dropped, −15
  | "closed"; // terminal — nothing to do

export function dropOutcome(status: EngagementStatus): DropOutcome {
  if (status === "pending_developer") return "cancel_no_penalty";
  if (status === "confirmed" || status === "at_risk") return "drop_with_penalty";
  return "closed";
}

// Streak-relevant statuses (decision A1) and slot-occupying statuses (A2).
export const STREAK_COUNTED_STATUSES: EngagementStatus[] = [
  "confirmed",
  "at_risk",
  "completed",
];
export const SLOT_OCCUPYING_STATUSES: EngagementStatus[] = [
  "pending_developer",
  "confirmed",
  "at_risk",
  "completed",
];

// Whether the pending-withdrawal UI switches to the amber "developer
// unresponsive" emphasis (72h — SPEC Flow 3 error state).
export function pendingCancelEmphasized(joinedAt: string, now: string | Date): boolean {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  return (
    Date.parse(joinedAt) < nowMs - PENDING_CANCEL_EMPHASIS_HOURS * 3_600_000
  );
}
