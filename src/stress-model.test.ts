import { describe, expect, it } from "vitest";
import { calculateStress } from "./stress-model.js";

const base = { side: "long" as const, entryPrice: 100_000, quantity: 0.01, startingMarginPercent: 10, shockPercent: -10, maintenancePercent: 2.5 };

describe("calculateStress", () => {
  it("calculates a long loss, equity, maintenance and headroom", () => {
    const result = calculateStress(base);
    expect(result.stressedPrice).toBe(90_000);
    expect(result.pnlUsd).toBe(-100);
    expect(result.startingMarginUsd).toBe(100);
    expect(result.equityUsd).toBe(0);
    expect(result.maintenanceUsd).toBe(22.5);
    expect(result.headroomUsd).toBe(-22.5);
    expect(result.thresholdStatus).toBe("at-or-below-estimate");
  });

  it("reverses directional P&L for a short", () => {
    const result = calculateStress({ ...base, side: "short", shockPercent: 10 });
    expect(result.stressedPrice).toBeCloseTo(110_000, 8);
    expect(result.pnlUsd).toBe(-100);
  });

  it("gives a short positive P&L when price falls", () => {
    expect(calculateStress({ ...base, side: "short", shockPercent: -10 }).pnlUsd).toBe(100);
  });

  it("treats positive funding as a cost for longs and income for shorts", () => {
    const long = calculateStress({ ...base, shockPercent: 0, fundingEnabled: true, fundingRate8hPercent: 0.08, fundingPeriods: 3 });
    const short = calculateStress({ ...base, side: "short", shockPercent: 0, fundingEnabled: true, fundingRate8hPercent: 0.08, fundingPeriods: 3 });
    expect(long.fundingUsd).toBeCloseTo(-2.4);
    expect(short.fundingUsd).toBeCloseTo(2.4);
  });

  it("handles zero shock as zero P&L", () => {
    expect(calculateStress({ ...base, shockPercent: 0 }).pnlUsd).toBe(0);
  });

  it("rejects invalid prices, quantities and margin assumptions", () => {
    expect(() => calculateStress({ ...base, entryPrice: 0 })).toThrow(/Entry price/);
    expect(() => calculateStress({ ...base, quantity: -1 })).toThrow(/Quantity/);
    expect(() => calculateStress({ ...base, startingMarginPercent: 0 })).toThrow(/Starting margin/);
    expect(() => calculateStress({ ...base, shockPercent: -101 })).toThrow(/negative price/);
    expect(() => calculateStress({ ...base, fundingPeriods: 1.5, fundingEnabled: true })).toThrow(/whole number/);
  });
});
