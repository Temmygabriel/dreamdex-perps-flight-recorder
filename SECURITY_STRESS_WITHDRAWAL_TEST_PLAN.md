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
