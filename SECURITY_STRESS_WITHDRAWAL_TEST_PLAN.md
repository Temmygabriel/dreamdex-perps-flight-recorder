# Perps Stress Lab — Security, Stress-Model, Recovery and Spot-Withdrawal Campaign

## Scope and limits

This campaign separates deterministic model tests from protocol-backed testnet checks. It does not claim finite tests prove every possible security property or reproduce dreamDEX's internal liquidation engine. Scenario output remains an estimate, not an account-specific liquidation guarantee.

## Required deterministic checks

- Long/short P&L direction, symmetry and scaling.
- Funding disabled/enabled, payer/receiver sign, zero and multi-period cases.
- Shock boundaries: -100%, zero, positive shocks; reject below -100%.
- Margin/maintenance boundaries and threshold equality.
- Reject NaN, Infinity, invalid side, invalid quantity/prices/percentages, fractional or negative periods, and arithmetic overflow.
- Independently recompute outputs from inputs and assert equity = starting margin + P&L + funding; headroom = equity - maintenance; leverage = 100 / starting margin percent.
- Deterministic randomized sweeps over bounded valid inputs; no NaN/Infinity/negative stressed prices and formula identities remain within floating-point tolerance.
- UI/export must label values as estimates and never claim on-chain account data or liquidation verification unless actually read and independently checked.

## Protocol-backed testnet checks

- Chain ID must equal 50383 before signing.
- Refuse to run if wallet has an existing position or open orders; do not touch pre-existing exposure.
- Position round-trip: strict USDso notional band, guarded limits, independently read the resulting position, close it, and verify no position remains. Emergency cleanup applies only to a position created by that run.
- Withdrawal: after all positions/orders are flat, withdraw exactly 5 paper USDso only when withdrawable and unlocked collateral are each at least 5 USDso. Verify the wallet balance rises by exactly 5 and Perps unlocked collateral falls by exactly 5. Abort without signing if any precondition fails.
- Do not test a deliberately unsafe on-chain withdrawal by broadcasting a transaction expected to revert; use unit-level validation or a non-broadcast simulation.
- Save redacted receipts. Never log private key material.

## Failure-recovery cases to inspect or simulate

1. Wrong chain / missing key / malformed key: abort before transaction.
2. Existing position or open orders: abort before deposit or new entry.
3. Unavailable/stale order book or unpriceable size gate: no entry.
4. Entry call errors after possible broadcast: re-read chain state before retrying; never blindly duplicate.
5. Entry succeeds but indexer read is delayed: poll boundedly, then cleanup only if this run may have opened the position.
6. Close partially fills or indexer lags: re-read live position and retry only remaining quantity with guarded opposite-side order.
7. Cleanup fails or final read fails: mark failed, emit explicit warning and retain receipt; never report success.
8. Withdrawal call times out: inspect balances and transaction receipt before retrying.
9. Withdrawal amount exceeds withdrawable or active position/order exists: fail closed before signing.
10. RPC/indexer disagreement: mark unverified; never treat missing read as zero balance or flat position.

## Evidence classification

- PASS only when assertion and independent read-back both pass.
- FAIL when an assertion fails or a transaction violates an invariant.
- BLOCKED when required RPC, wallet secret or testnet precondition is unavailable.
- NOT TESTED when no safe execution or simulation was run.


## Implemented follow-up verification

- `src/protocol-reference.test.ts` checks published initial/maintenance/close-out tiers for 20x, 10x and 5x markets; checks the official 1 BTC × 100,000 USDso × 0.08%/8h example; and tests strict-below-maintenance boundary behavior.
- Funding in the app now treats the entered rate as a quoted 8-hour rate and applies one eighth for each hourly settlement. The user interface says “hourly settlements” rather than “8h periods”.
- `src/recovery-policy.test.ts` injects unavailable reads, ambiguous transaction outcomes, leftover locked collateral, open orders and cleanup eligibility. Unknown final state is never counted as flat; an ambiguous send is not authorized for blind rebroadcast.
- The position round-trip now requires a readable zero position, zero locked collateral and no open market orders to declare the tested BTC lifecycle flat. Cleanup is only considered after entry was attempted and a position read confirms exposure.
- `npm run check:protocol-reference` performs read-only checks on Hideki chain ID and compares each live MarginBank system config with the published collateral, factory, liquidation-engine and insurance-fund addresses.

## Protocol accuracy boundary

The public docs say cross margin is the default and liquidation begins when **account equity** falls below maintenance. A single-position formula cannot accurately infer the real account liquidation threshold without aggregate account equity, all positions and orders, fees/funding accounting, the protocol mark/index price, and exact contract rounding. The live config check confirms wiring only; it does not execute or prove the LiquidationEngine's internal liquidation algorithm. Controlled liquidation execution is deliberately not broadcast from this demo wallet because it would risk the position/account state. To prove contract-level liquidation behavior, obtain verified contract source/ABI and test it on a local fork or a dedicated disposable test account/stateful harness.
