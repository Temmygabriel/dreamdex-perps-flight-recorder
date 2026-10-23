import { describe, expect, it } from "vitest";
import { decideAfterAmbiguousSubmission, isConfirmedFlat, shouldAttemptEmergencyCleanup } from "./recovery-policy.js";

describe("position lifecycle failure-recovery policy", () => {
  it("fails closed when any final-state source is unavailable", () => {
    expect(isConfirmedFlat({ positions: { status: "unavailable" }, lockedCollateral: 0n, hasOpenOrders: false })).toBe(false);
    expect(isConfirmedFlat({ positions: { status: "readable", contracts: 0 }, lockedCollateral: null, hasOpenOrders: false })).toBe(false);
    expect(isConfirmedFlat({ positions: { status: "readable", contracts: 0 }, lockedCollateral: 0n, hasOpenOrders: null })).toBe(false);
  });

  it("does not call a position flat if collateral remains locked or orders remain open", () => {
    expect(isConfirmedFlat({ positions: { status: "readable", contracts: 0 }, lockedCollateral: 1n, hasOpenOrders: false })).toBe(false);
    expect(isConfirmedFlat({ positions: { status: "readable", contracts: 0 }, lockedCollateral: 0n, hasOpenOrders: true })).toBe(false);
    expect(isConfirmedFlat({ positions: { status: "readable", contracts: 0 }, lockedCollateral: 0n, hasOpenOrders: false })).toBe(true);
  });

  it("never rebroadcasts after an unknown transaction outcome without reconciliation", () => {
    expect(decideAfterAmbiguousSubmission({ txHash: null, receiptStatus: "unknown", stateRead: "unavailable" })).toBe("reconcile-before-any-retry");
    expect(decideAfterAmbiguousSubmission({ txHash: "0xabc", receiptStatus: "unknown", stateRead: "flat" })).toBe("reconcile-before-any-retry");
    expect(decideAfterAmbiguousSubmission({ txHash: "0xabc", receiptStatus: "success", stateRead: "position-open" })).toBe("accept-open");
    expect(decideAfterAmbiguousSubmission({ txHash: "0xabc", receiptStatus: "reverted", stateRead: "flat" })).toBe("fail-no-retry");
  });

  it("only authorizes emergency cleanup when entry was attempted and a live position read confirms exposure", () => {
    expect(shouldAttemptEmergencyCleanup({ entryWasAttempted: false, positionRead: { status: "readable", contracts: 1 } })).toBe(false);
    expect(shouldAttemptEmergencyCleanup({ entryWasAttempted: true, positionRead: { status: "unavailable" } })).toBe(false);
    expect(shouldAttemptEmergencyCleanup({ entryWasAttempted: true, positionRead: { status: "readable", contracts: 0 } })).toBe(false);
    expect(shouldAttemptEmergencyCleanup({ entryWasAttempted: true, positionRead: { status: "readable", contracts: 1, side: "long" } })).toBe(true);
  });
});
