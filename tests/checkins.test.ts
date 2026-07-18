// Unit tests for the F4 pure logic (lib/clocks.ts): check-in day lock,
// rolling cadence window, feedback gates, reliability arithmetic.
// Mirrors the authoritative DB functions in the F4 migration. Run: npm test
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyReliabilityDelta,
  AT_RISK_PENALTY,
  checkinsInLastDays,
  COMPLETION_REWARD,
  DROP_PENALTY,
  feedbackGate,
  hasCheckedInToday,
} from "../lib/clocks";

describe("hasCheckedInToday (once per UTC day)", () => {
  it("is false with no check-ins", () => {
    assert.equal(hasCheckedInToday(null, "2026-07-18T10:00:00Z"), false);
  });

  it("locks for the rest of the same UTC day", () => {
    assert.equal(
      hasCheckedInToday("2026-07-18T00:05:00Z", "2026-07-18T23:59:00Z"),
      true,
    );
  });

  it("unlocks exactly at UTC midnight, not 24h later", () => {
    assert.equal(
      hasCheckedInToday("2026-07-18T23:50:00Z", "2026-07-19T00:01:00Z"),
      false,
    );
  });
});

describe("checkinsInLastDays (rolling 3/week meter — approved B3)", () => {
  const now = "2026-07-18T12:00:00Z";

  it("counts only check-ins inside the rolling 7-day window", () => {
    assert.equal(
      checkinsInLastDays(
        [
          "2026-07-18T09:00:00Z", // today
          "2026-07-16T09:00:00Z", // 2 days ago
          "2026-07-12T09:00:00Z", // 6 days ago
          "2026-07-11T11:00:00Z", // 7 days + 1h ago — outside
          "2026-07-01T09:00:00Z", // long gone
        ],
        now,
      ),
      3,
    );
  });

  it("returns 0 for an empty history", () => {
    assert.equal(checkinsInLastDays([], now), 0);
  });
});

describe("feedbackGate (mid day 7 / final day 14 — approved B6)", () => {
  it("blocks mid before day 7 and allows from day 7", () => {
    assert.deepEqual(feedbackGate("mid", 6), { allowed: false, unlocksOnDay: 7 });
    assert.deepEqual(feedbackGate("mid", 7), { allowed: true });
    assert.deepEqual(feedbackGate("mid", 20), { allowed: true }); // no upper bound
  });

  it("blocks final before day 14 and allows from day 14", () => {
    assert.deepEqual(feedbackGate("final", 13), {
      allowed: false,
      unlocksOnDay: 14,
    });
    assert.deepEqual(feedbackGate("final", 14), { allowed: true });
  });
});

describe("applyReliabilityDelta (SPEC F4 score rules)", () => {
  it("completion +2 caps at 100", () => {
    assert.equal(applyReliabilityDelta(99, COMPLETION_REWARD), 100);
    assert.equal(applyReliabilityDelta(100, COMPLETION_REWARD), 100);
    assert.equal(applyReliabilityDelta(95, COMPLETION_REWARD), 97);
  });

  it("at-risk −5 and drop −15 floor at 0", () => {
    assert.equal(applyReliabilityDelta(100, -AT_RISK_PENALTY), 95);
    assert.equal(applyReliabilityDelta(3, -AT_RISK_PENALTY), 0);
    assert.equal(applyReliabilityDelta(10, -DROP_PENALTY), 0);
  });

  it("the flip-then-drop sequence lands on 80 (walkthrough Stage 7)", () => {
    const afterFlip = applyReliabilityDelta(100, -AT_RISK_PENALTY);
    assert.equal(applyReliabilityDelta(afterFlip, -DROP_PENALTY), 80);
  });

  it("crossing below 60 is what arms the cooldown", () => {
    assert.equal(applyReliabilityDelta(62, -AT_RISK_PENALTY) < 60, true);
    assert.equal(applyReliabilityDelta(65, -AT_RISK_PENALTY) < 60, false);
  });
});
