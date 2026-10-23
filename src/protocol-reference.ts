/**
 * Reference calculations transcribed from the public dreamDEX Perps testnet docs.
 * These are protocol-documentation benchmarks, NOT the LiquidationEngine implementation.
 */
export type DocumentedMarketTier = {
  maxLeverage: 5 | 10 | 20;
  initialMarginPercent: 20 | 10 | 5;
  maintenanceMarginPercent: 10 | 5 | 2.5;
  closeOutMarginPercent: 5 | 2.5 | 1.25;
};

export const DOCUMENTED_MARGIN_TIERS: readonly DocumentedMarketTier[] = [
  { maxLeverage: 20, initialMarginPercent: 5, maintenanceMarginPercent: 2.5, closeOutMarginPercent: 1.25 },
  { maxLeverage: 10, initialMarginPercent: 10, maintenanceMarginPercent: 5, closeOutMarginPercent: 2.5 },
  { maxLeverage: 5, initialMarginPercent: 20, maintenanceMarginPercent: 10, closeOutMarginPercent: 5 },
] as const;

export function documentedTierForLeverage(maxLeverage: number): DocumentedMarketTier {
  const tier = DOCUMENTED_MARGIN_TIERS.find((item) => item.maxLeverage === maxLeverage);
  if (!tier) throw new Error("Unsupported documented dreamDEX leverage tier.");
  return tier;
}

/** Docs quote a rate per 8-hour window, with settlement every hour (one eighth each hour). */
export function documentedHourlyFundingUsd(input: {
  quantity: number;
  indexPrice: number;
  fundingRate8hPercent: number;
  hourlySettlements: number;
  side: "long" | "short";
}): number {
  const { quantity, indexPrice, fundingRate8hPercent, hourlySettlements, side } = input;
  if (![quantity, indexPrice, fundingRate8hPercent, hourlySettlements].every(Number.isFinite)) {
    throw new Error("Funding inputs must be finite.");
  }
  if (quantity < 0 || indexPrice <= 0 || hourlySettlements < 0 || !Number.isInteger(hourlySettlements)) {
    throw new Error("Funding quantity, index price or hourly settlement count is invalid.");
  }
  const direction = side === "long" ? 1 : side === "short" ? -1 : 0;
  if (!direction) throw new Error("Position side must be long or short.");
  if (quantity === 0 || fundingRate8hPercent === 0 || hourlySettlements === 0) return 0;
  const result = -direction * quantity * indexPrice * (fundingRate8hPercent / 100) / 8 * hourlySettlements;
  if (!Number.isFinite(result)) throw new Error("Funding result exceeds supported numeric range.");
  return result;
}

/**
 * A one-position comparison only. Actual dreamDEX uses cross margin by default,
 * so account equity and aggregate maintenance across all positions are required
 * for a real account-level liquidation verdict.
 */
export function documentedPositionMaintenanceUsd(input: {
  quantity: number;
  stressedPrice: number;
  maxLeverage: number;
}): number {
  const tier = documentedTierForLeverage(input.maxLeverage);
  if (![input.quantity, input.stressedPrice].every(Number.isFinite) ||
      input.quantity < 0 || input.stressedPrice < 0) {
    throw new Error("Position quantity and stressed price must be finite and non-negative.");
  }
  const result = input.quantity * input.stressedPrice * tier.maintenanceMarginPercent / 100;
  if (!Number.isFinite(result)) throw new Error("Maintenance result exceeds supported numeric range.");
  return result;
}

export function documentedAccountMaintenanceStatus(accountEquityUsd: number, aggregateMaintenanceUsd: number): "below-maintenance" | "not-below-maintenance" {
  if (![accountEquityUsd, aggregateMaintenanceUsd].every(Number.isFinite) || aggregateMaintenanceUsd < 0) {
    throw new Error("Account equity and aggregate maintenance must be finite; maintenance cannot be negative.");
  }
  return accountEquityUsd < aggregateMaintenanceUsd ? "below-maintenance" : "not-below-maintenance";
}
