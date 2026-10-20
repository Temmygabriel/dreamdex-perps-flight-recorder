export type OrderGeometry = {
  price: bigint;
  tickSize: bigint;
  quantity: bigint;
  lotSize: bigint;
  minQuantity: bigint;
};

export type OrderRuleCode =
  | "INVALID_PRICE"
  | "INVALID_TICK_SIZE"
  | "PRICE_OFF_TICK"
  | "INVALID_QUANTITY"
  | "INVALID_LOT_SIZE"
  | "QUANTITY_OFF_LOT"
  | "BELOW_MIN_QUANTITY";

export type OrderRuleFailure = {
  code: OrderRuleCode;
  message: string;
};

/**
 * Checks raw on-chain units only. The caller must use each market row's
 * quoteDecimals/baseDecimals; do not assume every market uses 18 decimals.
 * This function does not estimate margin or prove the order will be accepted.
 */
export function validateOrderGeometry(input: OrderGeometry): OrderRuleFailure[] {
  const failures: OrderRuleFailure[] = [];

  if (input.price <= 0n) {
    failures.push({ code: "INVALID_PRICE", message: "Price must be greater than zero." });
  }
  if (input.tickSize <= 0n) {
    failures.push({ code: "INVALID_TICK_SIZE", message: "Market tick size must be greater than zero." });
  } else if (input.price > 0n && input.price % input.tickSize !== 0n) {
    failures.push({ code: "PRICE_OFF_TICK", message: "Price is not a multiple of the market tick size." });
  }

  if (input.quantity <= 0n) {
    failures.push({ code: "INVALID_QUANTITY", message: "Quantity must be greater than zero." });
  }
  if (input.lotSize <= 0n) {
    failures.push({ code: "INVALID_LOT_SIZE", message: "Market lot size must be greater than zero." });
  } else if (input.quantity > 0n && input.quantity % input.lotSize !== 0n) {
    failures.push({ code: "QUANTITY_OFF_LOT", message: "Quantity is not a multiple of the market lot size." });
  }
  if (input.minQuantity < 0n) {
    failures.push({ code: "BELOW_MIN_QUANTITY", message: "Market minimum quantity is invalid." });
  } else if (input.quantity > 0n && input.quantity < input.minQuantity) {
    failures.push({ code: "BELOW_MIN_QUANTITY", message: "Quantity is below the market minimum." });
  }

  return failures;
}

export function canPassLocalPreflight(input: OrderGeometry): boolean {
  return validateOrderGeometry(input).length === 0;
}
