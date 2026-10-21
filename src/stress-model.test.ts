import { describe, expect, it } from "vitest";
import { calculateStress } from "./stress-model.js";

const base = {
  side: "long" as const,
  entryPrice: 100_000,
  quantity: 0.01,
  startingMarginPercent: 10,
  shockPercent: -10,
  maintenancePercent: 2.5,
};

describe("calculateStress", () => {
  it("calculates a long loss, equity, maintenance and headroom", () => {
    const result = calculateStress(base);
    expect(result.stressedPrice).toBe(90_000);
    expect(result.pnlUsd).toBeCloseTo(-100, 8);
    expect(result.startingMarginUsd).toBe(100);
    expect(result.equityUsd).toBe(0);
    expect(result.maintenanceUsd).toBe(22.5);
    expect(result.headroomUsd).toBe(-22.5);
    expect(result.thresholdStatus).toBe("at-or-below-estimate");
  });

  it("reverses directional P&L for a short", () => {
    const result = calculateStress({ ...base, side: "short", shockPercent: 10 });
    expect(result.stressedPrice).toBeCloseTo(110_000, 8);
    expect(result.pnlUsd).toBeCloseTo(-100, 8);
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

  it("ignores a supplied funding rate when funding is disabled", () => {
    const result = calculateStress({ ...base, shockPercent: 0, fundingEnabled: false, fundingRate8hPercent: 12, fundingPeriods: 9 });
    expect(result.fundingUsd).toBe(0);
    expect(result.equityUsd).toBe(result.startingMarginUsd);
  });

  it("handles zero shock as zero P&L and unchanged price", () => {
    const result = calculateStress({ ...base, shockPercent: 0 });
    expect(result.pnlUsd).toBe(0);
    expect(result.stressedPrice).toBe(base.entryPrice);
  });

  it("handles a total price loss without producing a negative price", () => {
    const result = calculateStress({ ...base, shockPercent: -100 });
    expect(result.stressedPrice).toBe(0);
    expect(result.maintenanceUsd).toBe(0);
    expect(result.pnlUsd).toBe(-base.entryPrice * base.quantity);
  });

  it("preserves long/short symmetry for equal absolute shocks", () => {
    const longUp = calculateStress({ ...base, shockPercent: 7 });
    const shortUp = calculateStress({ ...base, side: "short", shockPercent: 7 });
    expect(longUp.pnlUsd).toBe(-shortUp.pnlUsd);
    const longDown = calculateStress({ ...base, shockPercent: -7 });
    const shortDown = calculateStress({ ...base, side: "short", shockPercent: -7 });
    expect(longDown.pnlUsd).toBe(-shortDown.pnlUsd);
  });

  it("scales P&L and maintenance linearly with quantity", () => {
    const one = calculateStress({ ...base, quantity: 0.01 });
    const two = calculateStress({ ...base, quantity: 0.02 });
    expect(two.pnlUsd).toBeCloseTo(one.pnlUsd * 2, 8);
    expect(two.maintenanceUsd).toBeCloseTo(one.maintenanceUsd * 2, 8);
    expect(two.startingMarginUsd).toBeCloseTo(one.startingMarginUsd * 2, 8);
  });

  it("reports headroom as equity minus maintenance and status consistently", () => {
    for (const shockPercent of [-100, -50, -10, 0, 10, 50]) {
      const result = calculateStress({ ...base, shockPercent });
      expect(result.headroomUsd).toBeCloseTo(result.equityUsd - result.maintenanceUsd, 8);
      expect(result.thresholdStatus).toBe(result.headroomUsd > 0 ? "above-estimate" : "at-or-below-estimate");
    }
  });

  it("rejects invalid prices, quantities and margin assumptions", () => {
    expect(() => calculateStress({ ...base, entryPrice: 0 })).toThrow(/Entry price/);
    expect(() => calculateStress({ ...base, quantity: -1 })).toThrow(/Quantity/);
    expect(() => calculateStress({ ...base, startingMarginPercent: 0 })).toThrow(/Starting margin/);
    expect(() => calculateStress({ ...base, startingMarginPercent: 101 })).toThrow(/Starting margin/);
    expect(() => calculateStress({ ...base, shockPercent: -101 })).toThrow(/negative price/);
    expect(() => calculateStress({ ...base, maintenancePercent: 0 })).toThrow(/Maintenance margin/);
    expect(() => calculateStress({ ...base, fundingPeriods: 1.5, fundingEnabled: true })).toThrow(/whole number/);
  });

  it("rejects non-finite values and runtime-invalid side values", () => {
    expect(() => calculateStress({ ...base, entryPrice: Number.NaN })).toThrow(/finite numbers/);
    expect(() => calculateStress({ ...base, quantity: Number.POSITIVE_INFINITY })).toThrow(/finite numbers/);
    expect(() => calculateStress({ ...base, fundingRate8hPercent: Number.NaN })).toThrow(/finite numbers/);
    expect(() => calculateStress({ ...base, side: "flat" as "long" })).toThrow(/side must be long or short/i);
  });

  it("rejects arithmetic overflow instead of returning infinite output", () => {
    expect(() => calculateStress({
      ...base, entryPrice: Number.MAX_VALUE, quantity: Number.MAX_VALUE, shockPercent: 50,
    })).toThrow(/numeric range/);
  });
});
