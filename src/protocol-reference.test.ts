import { describe, expect, it } from "vitest";
import {
  documentedAccountMaintenanceStatus, documentedHourlyFundingUsd,
  documentedPositionMaintenanceUsd, documentedTierForLeverage,
} from "./protocol-reference.js";

describe("documented dreamDEX Perps reference benchmarks", () => {
  it("matches documented initial, maintenance and close-out tiers", () => {
    expect(documentedTierForLeverage(20)).toEqual({ maxLeverage: 20, initialMarginPercent: 5, maintenanceMarginPercent: 2.5, closeOutMarginPercent: 1.25 });
    expect(documentedTierForLeverage(10)).toEqual({ maxLeverage: 10, initialMarginPercent: 10, maintenanceMarginPercent: 5, closeOutMarginPercent: 2.5 });
    expect(documentedTierForLeverage(5)).toEqual({ maxLeverage: 5, initialMarginPercent: 20, maintenanceMarginPercent: 10, closeOutMarginPercent: 5 });
    expect(() => documentedTierForLeverage(15)).toThrow(/Unsupported/);
  });

  it("matches the official 1 BTC, 100000 USDso, 0.08% per 8h example: 10 USDso per hour", () => {
    expect(documentedHourlyFundingUsd({ quantity: 1, indexPrice: 100_000, fundingRate8hPercent: 0.08, hourlySettlements: 1, side: "long" })).toBeCloseTo(-10, 10);
    expect(documentedHourlyFundingUsd({ quantity: 1, indexPrice: 100_000, fundingRate8hPercent: 0.08, hourlySettlements: 1, side: "short" })).toBeCloseTo(10, 10);
    expect(documentedHourlyFundingUsd({ quantity: 1, indexPrice: 100_000, fundingRate8hPercent: 0.08, hourlySettlements: 8, side: "long" })).toBeCloseTo(-80, 10);
  });

  it("calculates position maintenance at each documented tier", () => {
    expect(documentedPositionMaintenanceUsd({ quantity: 1, stressedPrice: 100_000, maxLeverage: 20 })).toBe(2500);
    expect(documentedPositionMaintenanceUsd({ quantity: 1, stressedPrice: 100_000, maxLeverage: 10 })).toBe(5000);
    expect(documentedPositionMaintenanceUsd({ quantity: 1, stressedPrice: 100_000, maxLeverage: 5 })).toBe(10000);
  });

  it("treats equality as not below maintenance; only strictly lower equity triggers this documented threshold predicate", () => {
    expect(documentedAccountMaintenanceStatus(99, 100)).toBe("below-maintenance");
    expect(documentedAccountMaintenanceStatus(100, 100)).toBe("not-below-maintenance");
    expect(documentedAccountMaintenanceStatus(101, 100)).toBe("not-below-maintenance");
  });

  it("rejects malformed funding and account-state inputs rather than guessing", () => {
    expect(() => documentedHourlyFundingUsd({ quantity: 1, indexPrice: 100, fundingRate8hPercent: 0.1, hourlySettlements: 1.5, side: "long" })).toThrow(/invalid/);
    expect(() => documentedHourlyFundingUsd({ quantity: 1, indexPrice: 100, fundingRate8hPercent: Infinity, hourlySettlements: 1, side: "long" })).toThrow(/finite/);
    expect(() => documentedAccountMaintenanceStatus(NaN, 1)).toThrow(/finite/);
  });
});
