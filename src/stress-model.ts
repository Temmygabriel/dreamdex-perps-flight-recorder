import { documentedHourlyFundingUsd } from "./protocol-reference.js";

export type PositionSide = "long" | "short";

export type StressInput = {
  side: PositionSide;
  entryPrice: number;
  quantity: number;
  startingMarginPercent: number;
  shockPercent: number;
  maintenancePercent: number;
  fundingEnabled?: boolean;
  fundingRate8hPercent?: number;
  fundingPeriods?: number; // hourly settlement count; the rate is quoted per 8-hour window
};

export type StressOutput = {
  stressedPrice: number;
  pnlUsd: number;
  startingMarginUsd: number;
  fundingUsd: number;
  equityUsd: number;
  maintenanceUsd: number;
  headroomUsd: number;
  leverage: number;
  thresholdStatus: "above-estimate" | "at-or-below-estimate";
};

export function calculateStress(input: StressInput): StressOutput {
  const {
    side, entryPrice, quantity, startingMarginPercent, shockPercent, maintenancePercent,
  } = input;
  const fundingEnabled = input.fundingEnabled === true;
  const fundingRate = input.fundingRate8hPercent ?? 0;
  const periods = input.fundingPeriods ?? 0;

  if (side !== "long" && side !== "short") {
    throw new Error("Position side must be long or short.");
  }
  if (![entryPrice, quantity, startingMarginPercent, shockPercent, maintenancePercent, fundingRate, periods]
    .every(Number.isFinite)) {
    throw new Error("All scenario values must be finite numbers.");
  }
  if (entryPrice <= 0) throw new Error("Entry price must be greater than zero.");
  if (quantity <= 0) throw new Error("Quantity must be greater than zero.");
  if (startingMarginPercent <= 0 || startingMarginPercent > 100) {
    throw new Error("Starting margin must be greater than 0% and at most 100%.");
  }
  if (shockPercent < -100) throw new Error("A price shock below -100% would create a negative price.");
  if (maintenancePercent <= 0 || maintenancePercent > 50) {
    throw new Error("Maintenance margin must be greater than 0% and at most 50%.");
  }
  if (periods < 0 || !Number.isInteger(periods)) {
    throw new Error("Funding periods must be a non-negative whole number.");
  }

  const stressedPrice = entryPrice * (1 + shockPercent / 100);
  const direction = side === "long" ? 1 : -1;
  const pnlUsd = quantity * (stressedPrice - entryPrice) * direction;
  const startingMarginUsd = quantity * entryPrice * startingMarginPercent / 100;
  // dreamDEX quotes funding per 8-hour window but settles one eighth each hour.
  // The UI input is the number of hourly settlements at a constant assumed rate.
  const fundingUsd = fundingEnabled
    ? documentedHourlyFundingUsd({
        quantity, indexPrice: entryPrice, fundingRate8hPercent: fundingRate,
        hourlySettlements: periods, side,
      })
    : 0;
  const equityUsd = startingMarginUsd + pnlUsd + fundingUsd;
  const maintenanceUsd = quantity * stressedPrice * maintenancePercent / 100;
  const headroomUsd = equityUsd - maintenanceUsd;
  const leverage = 100 / startingMarginPercent;

  // Finite inputs can still overflow during multiplication. Never return misleading
  // Infinity/NaN values to the UI or export.
  if (![stressedPrice, pnlUsd, startingMarginUsd, fundingUsd, equityUsd, maintenanceUsd, headroomUsd, leverage]
    .every(Number.isFinite)) {
    throw new Error("Scenario values exceed the supported numeric range.");
  }

  return {
    stressedPrice, pnlUsd, startingMarginUsd, fundingUsd, equityUsd, maintenanceUsd, headroomUsd,
    leverage,
    thresholdStatus: headroomUsd > 0 ? "above-estimate" : "at-or-below-estimate",
  };
}
