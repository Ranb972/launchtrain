// Unit tests for engagement state-transition guards and join eligibility
// (lib/clocks.ts), mirroring the F3 DB functions. Run: npm test
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  confirmOutcome,
  dropOutcome,
  joinEligibility,
  type JoinEligibilityInput,
} from "../lib/clocks";

const ELIGIBLE: JoinEligibilityInput = {
  requestStatus: "recruiting",
  isOwner: false,
  reliabilityScore: 100,
  joinBlockedUntil: null,
  deviceVersions: [14],
  minAndroidVersion: 10,
  alreadyJoined: false,
  occupiedCount: 3,
  slotsNeeded: 14,
  now: "2026-07-17T12:00:00Z",
};

describe("joinEligibility (SPEC Flow 3 step 1)", () => {
  it("passes a fully eligible tester", () => {
    assert.deepEqual(joinEligibility(ELIGIBLE), { ok: true });
  });

  it("blocks non-joinable request statuses", () => {
    for (const status of ["draft", "completed", "cancelled", "expired"]) {
      assert.deepEqual(joinEligibility({ ...ELIGIBLE, requestStatus: status }), {
        ok: false,
        reason: "not_joinable",
      });
    }
    for (const status of ["recruiting", "active", "at_risk"]) {
      assert.equal(joinEligibility({ ...ELIGIBLE, requestStatus: status }).ok, true);
    }
  });

  it("blocks the owner", () => {
    assert.deepEqual(joinEligibility({ ...ELIGIBLE, isOwner: true }), {
      ok: false,
      reason: "own_request",
    });
  });

  it("blocks reliability below 60, allows exactly 60", () => {
    assert.deepEqual(joinEligibility({ ...ELIGIBLE, reliabilityScore: 59 }), {
      ok: false,
      reason: "reliability_low",
    });
    assert.equal(joinEligibility({ ...ELIGIBLE, reliabilityScore: 60 }).ok, true);
  });

  it("blocks an active cooldown even when the score recovered above 60", () => {
    assert.deepEqual(
      joinEligibility({
        ...ELIGIBLE,
        reliabilityScore: 62,
        joinBlockedUntil: "2026-07-20T00:00:00Z",
      }),
      { ok: false, reason: "cooldown" },
    );
  });

  it("allows joining once the cooldown expired", () => {
    assert.equal(
      joinEligibility({
        ...ELIGIBLE,
        joinBlockedUntil: "2026-07-17T11:59:00Z", // 1 min in the past
      }).ok,
      true,
    );
  });

  it("requires at least one device meeting the minimum Android version", () => {
    assert.deepEqual(
      joinEligibility({ ...ELIGIBLE, deviceVersions: [8, 9], minAndroidVersion: 10 }),
      { ok: false, reason: "no_compatible_device" },
    );
    assert.equal(
      joinEligibility({ ...ELIGIBLE, deviceVersions: [8, 10], minAndroidVersion: 10 }).ok,
      true,
    );
  });

  it("blocks a second live engagement on the same request", () => {
    assert.deepEqual(joinEligibility({ ...ELIGIBLE, alreadyJoined: true }), {
      ok: false,
      reason: "already_joined",
    });
  });

  it("blocks when every slot is occupied (last-slot race loser)", () => {
    assert.deepEqual(
      joinEligibility({ ...ELIGIBLE, occupiedCount: 14, slotsNeeded: 14 }),
      { ok: false, reason: "full" },
    );
    assert.equal(
      joinEligibility({ ...ELIGIBLE, occupiedCount: 13, slotsNeeded: 14 }).ok,
      true,
    );
  });
});

describe("confirmOutcome (developer confirm guard)", () => {
  it("confirms only pending_developer", () => {
    assert.equal(confirmOutcome("pending_developer"), "ok");
  });

  it("fails gracefully when the tester already cancelled", () => {
    assert.equal(confirmOutcome("cancelled"), "tester_cancelled");
  });

  it("reports already-confirmed states distinctly", () => {
    assert.equal(confirmOutcome("confirmed"), "already_confirmed");
    assert.equal(confirmOutcome("at_risk"), "already_confirmed");
  });

  it("rejects terminal states", () => {
    assert.equal(confirmOutcome("dropped"), "not_pending");
    assert.equal(confirmOutcome("completed"), "not_pending");
  });
});

describe("dropOutcome (tester exit guard — approved A5)", () => {
  it("pending withdrawal is penalty-free cancellation", () => {
    assert.equal(dropOutcome("pending_developer"), "cancel_no_penalty");
  });

  it("confirmed and at_risk exits take the −15 dropped path", () => {
    assert.equal(dropOutcome("confirmed"), "drop_with_penalty");
    assert.equal(dropOutcome("at_risk"), "drop_with_penalty");
  });

  it("terminal engagements have nothing to drop", () => {
    assert.equal(dropOutcome("completed"), "closed");
    assert.equal(dropOutcome("dropped"), "closed");
    assert.equal(dropOutcome("cancelled"), "closed");
  });
});
