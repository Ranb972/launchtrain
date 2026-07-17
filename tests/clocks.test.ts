// Unit tests for the pure two-clock math (lib/clocks.ts), mirroring the
// authoritative DB logic in the F3 migration. Run: npm test
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeStreakCredit,
  engagementDay,
  engagementDayLabel,
  isEngagementInactive,
  pendingCancelEmphasized,
  utcDateString,
  utcDayNumber,
} from "../lib/clocks";

describe("utc helpers", () => {
  it("utcDateString truncates to the UTC date", () => {
    assert.equal(utcDateString("2026-07-10T23:59:59.999Z"), "2026-07-10");
    assert.equal(utcDateString("2026-07-10T00:00:00Z"), "2026-07-10");
  });

  it("utcDayNumber flips exactly at UTC midnight", () => {
    assert.equal(
      utcDayNumber("2026-07-11T00:00:00Z") - utcDayNumber("2026-07-10T23:59:59Z"),
      1,
    );
  });
});

describe("computeStreakCredit (request clock)", () => {
  it("credits nothing while the 12+ window is closed", () => {
    assert.deepEqual(
      computeStreakCredit({
        streakOkSince: null,
        lastCountedDay: null,
        today: "2026-07-12",
      }),
      { add: 0, lastCountedDay: null },
    );
  });

  it("does not credit the partial day the request reached 12", () => {
    // Reached 12 on Jul 10 at 14:00 → Jul 10 was not fully covered.
    assert.deepEqual(
      computeStreakCredit({
        streakOkSince: "2026-07-10T14:00:00Z",
        lastCountedDay: null,
        today: "2026-07-11",
      }),
      { add: 0, lastCountedDay: null },
    );
  });

  it("credits the first full day on the following cron run", () => {
    assert.deepEqual(
      computeStreakCredit({
        streakOkSince: "2026-07-10T14:00:00Z",
        lastCountedDay: null,
        today: "2026-07-12",
      }),
      { add: 1, lastCountedDay: "2026-07-11" },
    );
  });

  it("is idempotent — a re-run on the same day credits nothing", () => {
    assert.deepEqual(
      computeStreakCredit({
        streakOkSince: "2026-07-10T14:00:00Z",
        lastCountedDay: "2026-07-11",
        today: "2026-07-12",
      }),
      { add: 0, lastCountedDay: "2026-07-11" },
    );
  });

  it("catches up after missed cron days", () => {
    // Counted through Jul 11, cron next runs Jul 15 → Jul 12+13+14 owed.
    assert.deepEqual(
      computeStreakCredit({
        streakOkSince: "2026-07-10T14:00:00Z",
        lastCountedDay: "2026-07-11",
        today: "2026-07-15",
      }),
      { add: 3, lastCountedDay: "2026-07-14" },
    );
  });

  it("a refill mid-yesterday earns nothing yet (12 was not held all day)", () => {
    // Streak broke, refilled to 12 on Jul 11 at 20:00; cron on Jul 12 must
    // NOT credit Jul 11. First creditable day is Jul 12, on the Jul 13 run.
    assert.deepEqual(
      computeStreakCredit({
        streakOkSince: "2026-07-11T20:00:00Z",
        lastCountedDay: null,
        today: "2026-07-12",
      }),
      { add: 0, lastCountedDay: null },
    );
    assert.deepEqual(
      computeStreakCredit({
        streakOkSince: "2026-07-11T20:00:00Z",
        lastCountedDay: null,
        today: "2026-07-13",
      }),
      { add: 1, lastCountedDay: "2026-07-12" },
    );
  });

  it("reaching 12 exactly at midnight is conservatively NOT credited for that day", () => {
    // Sub-second boundary: the day of the crossing never counts, by design.
    assert.deepEqual(
      computeStreakCredit({
        streakOkSince: "2026-07-10T00:00:00Z",
        lastCountedDay: null,
        today: "2026-07-11",
      }),
      { add: 0, lastCountedDay: null },
    );
  });

  it("a stale lastCountedDay before the window open is superseded by streakOkSince", () => {
    // Streak broke and re-opened later; the old counted day must not let
    // pre-break days leak into the new window.
    assert.deepEqual(
      computeStreakCredit({
        streakOkSince: "2026-07-20T09:00:00Z",
        lastCountedDay: "2026-07-11",
        today: "2026-07-23",
      }),
      { add: 2, lastCountedDay: "2026-07-22" },
    );
  });
});

describe("engagementDay (personal clock)", () => {
  it("is day 1 on the confirmation day", () => {
    assert.equal(
      engagementDay("2026-07-10T08:00:00Z", "2026-07-10T20:00:00Z"),
      1,
    );
  });

  it("flips at UTC midnight, not 24h elapsed", () => {
    assert.equal(
      engagementDay("2026-07-10T23:59:00Z", "2026-07-11T00:01:00Z"),
      2,
    );
  });

  it("label caps at Day 14/14", () => {
    assert.equal(
      engagementDayLabel("2026-07-01T10:00:00Z", "2026-07-20T10:00:00Z"),
      "Day 14/14",
    );
    assert.equal(
      engagementDayLabel("2026-07-10T10:00:00Z", "2026-07-12T10:00:00Z"),
      "Day 3/14",
    );
  });
});

describe("isEngagementInactive (5-day at-risk rule)", () => {
  it("uses confirmed_at as fallback while no check-ins exist", () => {
    assert.equal(
      isEngagementInactive(null, "2026-07-05T10:00:00Z", "2026-07-09T10:00:00Z"),
      false, // 4 days
    );
    assert.equal(
      isEngagementInactive(null, "2026-07-05T10:00:00Z", "2026-07-10T10:01:00Z"),
      true, // 5 days + 1 min
    );
  });

  it("is exclusive at exactly 5 days", () => {
    assert.equal(
      isEngagementInactive(null, "2026-07-05T10:00:00Z", "2026-07-10T10:00:00Z"),
      false,
    );
  });

  it("a recent check-in overrides an old confirmation", () => {
    assert.equal(
      isEngagementInactive(
        "2026-07-14T09:00:00Z",
        "2026-07-01T10:00:00Z",
        "2026-07-15T10:00:00Z",
      ),
      false,
    );
  });
});

describe("pendingCancelEmphasized (72h window)", () => {
  it("stays low-key before 72h and emphasizes after", () => {
    const joined = "2026-07-10T10:00:00Z";
    assert.equal(pendingCancelEmphasized(joined, "2026-07-13T09:00:00Z"), false); // 71h
    assert.equal(pendingCancelEmphasized(joined, "2026-07-13T11:00:00Z"), true); // 73h
  });
});
