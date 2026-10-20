import { describe, expect, it } from "vitest";
import { canPassLocalPreflight, validateOrderGeometry } from "../src/order-rules.js";

const valid = {
  price: 100_000n,
  tickSize: 100n,
  quantity: 25n,
  lotSize: 5n,
  minQuantity: 10n,
};

describe("validateOrderGeometry", () => {
  it("accepts a price and quantity on the required increments", () => {
    expect(validateOrderGeometry(valid)).toEqual([]);
    expect(canPassLocalPreflight(valid)).toBe(true);
  });

  it("rejects a price that does not follow the market tick", () => {
    expect(validateOrderGeometry({ ...valid, price: 100_001n }).map((x) => x.code))
      .toContain("PRICE_OFF_TICK");
  });

  it("rejects a quantity that does not follow the market lot size", () => {
    expect(validateOrderGeometry({ ...valid, quantity: 26n }).map((x) => x.code))
      .toContain("QUANTITY_OFF_LOT");
  });

  it("rejects a quantity below the market minimum", () => {
    expect(validateOrderGeometry({ ...valid, quantity: 5n }).map((x) => x.code))
      .toContain("BELOW_MIN_QUANTITY");
  });

  it("rejects zero and negative price or quantity", () => {
    const failures = validateOrderGeometry({ ...valid, price: 0n, quantity: -5n });
    expect(failures.map((x) => x.code)).toContain("INVALID_PRICE");
    expect(failures.map((x) => x.code)).toContain("INVALID_QUANTITY");
  });

  it("does not treat a local pass as an on-chain acceptance claim", () => {
    // This tests only the pure local rules; current mark, voucher, margin,
    // account mode, position caps, gas, and network state need live checks.
    expect(canPassLocalPreflight(valid)).toBe(true);
  });
});
