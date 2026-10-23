export type PositionRead = { status: "readable"; contracts: number; side?: "long" | "short" | "flat" } | { status: "unavailable" };

/** Unknown state is never treated as flat. */
export function isConfirmedFlat(input: {
  positions: PositionRead;
  lockedCollateral: bigint | null;
  hasOpenOrders: boolean | null;
}): boolean {
  if (input.positions.status !== "readable" || input.lockedCollateral === null || input.hasOpenOrders === null) return false;
  if (!Number.isFinite(input.positions.contracts) || input.positions.contracts < 0) return false;
  return input.positions.contracts === 0 && input.lockedCollateral === 0n && input.hasOpenOrders === false;
}

export type SubmissionObservation = {
  txHash: string | null;
  receiptStatus: "success" | "reverted" | "unknown";
  stateRead: "position-open" | "flat" | "unavailable";
};

/** Never rebroadcast after an ambiguous send until transaction/account state is reconciled. */
export function decideAfterAmbiguousSubmission(input: SubmissionObservation): "accept-open" | "fail-no-retry" | "reconcile-before-any-retry" {
  if (input.receiptStatus === "success" && input.stateRead === "position-open") return "accept-open";
  if (input.receiptStatus === "reverted") return "fail-no-retry";
  if (input.receiptStatus === "success" && input.stateRead === "flat") return "fail-no-retry";
  return "reconcile-before-any-retry";
}

export function shouldAttemptEmergencyCleanup(input: {
  entryWasAttempted: boolean;
  positionRead: PositionRead;
}): boolean {
  return input.entryWasAttempted && input.positionRead.status === "readable" &&
    Number.isFinite(input.positionRead.contracts) && input.positionRead.contracts > 0;
}
