# Liquidation investigation and live-test gate

**Date:** 2026-10-24  
**Network:** Somnia Hideki testnet, chain ID 50383  
**Decision:** Do not submit a live liquidation transaction yet. Keep the account unchanged while the exact write ABI / entry point and an isolated exposure boundary are unresolved.

## 1. Deployed contract identity

The MarginBank's live system config points to LiquidationEngine proxy `0xA66d3C24Ad4a389d863846905D8173e1017e9F4D`. EIP-1967 storage at block 32234382 resolves the implementation to `0xf46c4966f2f17703b39e1208f98cd3dc80e4702d`.

- Proxy runtime: 176 bytes, Keccak-256 `0x5e1adae82df2682fa7aa58621e2ffcafb478ccccad46eaf3feeab9180be3afa9`
- Implementation runtime: 75,969 bytes, Keccak-256 `0x9c02bc18c416e765e2e3299fa77c0e35098655534d2d313588c288b9bff0aea7`
- The official Hideki docs publish the proxy address, not the implementation source.

Initial read-only source discovery queried Sourcify full/partial-match metadata and the published explorer source endpoint. Those probes did not establish verified implementation source or ABI. An expanded explorer ABI probe is included in the follow-up CI workflow; its receipt must be checked before declaring the ABI search complete. Bytecode presence/hash does not establish source verification or contract correctness.

## 2. What the authoritative SDK documentation establishes

The official Somnia Markets SDK reference states:

- Account liquidation begins at the maintenance boundary, `equity == mmReq`; a position's liquidation price is a client-side estimate, while the MarginBank's bankruptcy price is a distinct contract-computed value.
- Margin is cross-margin by default. Equity nets the account's positions and funding, so a one-position toy formula is not the exact wallet liquidation forecast.
- The waterfall has six published stages. `AccountLiquidated.stageReached` is a zero-indexed enum, not the published stage number: 0 = OrderCancellation; 1 = CLOBPartial; 2 = BidderTakeover; 3 = InsuranceFund; 4 = ADL; 5 = Deferred (a rate-limit marker). The deepest stage that acted is reported, and a `CLOBPartial` row with `positionsProcessed = 0` does not prove a position was closed.
- LiquidationEngine events and MarginBank settlement events are split across the two contracts. All rows from one cascade share a transaction hash. Event rows must be grouped by transaction and interpreted by `kind`; levels such as `badDebt` must not be summed with overlapping stage views.

Sources:
- https://app.testnet.dreamdex.io/docs/developers/perps-testnet
- https://app.testnet.dreamdex.io/docs/trading/perps-testnet/margin-and-liquidations
- https://prd.smk.somnia.host/docs/typescript/perps

The SDK publishes event ABIs for `LiquidationEngine` and `MarginBank`; this is sufficient to decode events but does not itself establish the engine's permissionless write ABI or every write precondition.

## 3. Current live account snapshot (read-only)

Source artifact: `hideki-liquidation-observability-audit`, recorded 2026-10-24 21:09:51 UTC, account health block 32240933.

- Account: `0x19393aEd711c5C17C8B62C4cB6Cc2c32A31B5f7A`
- Spot wallet USDso: 93.5
- Perps unlocked collateral / equity / withdrawable: 6.498306 USDso
- Locked collateral: 0
- IM / MM / close-out requirements: 0 / 0 / 0
- Margin status: Healthy
- Open positions: none
- Open orders: none; reads succeeded across all markets
- Account liquidation history: 0 indexed rows
- Transactions submitted by these audits: none

Live BTC-PERP risk params at the audited block: initial margin 500 bps, maintenance margin 250 bps, close-out margin 125 bps. The live mark snapshot was approximately 80,389 USDso per BTC. BTC minimum order size is 0.00013 BTC, around 10.45 USDso notional at that snapshot, subject to live price and market constraints.

The live engine configuration returned `bidderCount = 1`, while the trading docs say no backstop bidders are registered on testnet. This mismatch has been publicly noted elsewhere and is not treated as a new finding here. It must nevertheless be re-read before any test because the waterfall and recovery outcome may depend on it.

## 4. Observed historical liquidation sample

The read-only SDK query returned the newest 500 indexed `AccountLiquidated` summary rows:

- `stageReached = 0`: 5 rows
- `stageReached = 1`: 495 rows
- `positionsProcessed = 0`: 24 rows
- `positionsProcessed = 1`: 476 rows

This is a bounded, indexer-backed sample, not a full historical scan or a proof of all on-chain execution semantics. It confirms why a receipt must include the full transaction's sibling rows and position deltas, not just the account summary.

## 5. Bounded live-test design (proposal, not executed)

**Proposed hard cap:** no more than 0.75 USDso collateral accessible to the test position, plus a separately budgeted small amount of STT for gas. This is a proposed maximum loss budget, not a claim that current account state meets it.

1. Use a dedicated test wallet, not the main account. Confirm it has no voucher-credit restrictions, linked-wallet funding, open orders, or positions. Keep no excess USDso in its wallet that the order path could auto-pull. A separate wallet is necessary because the current wallet has 93.5 USDso in Spot and 6.498306 USDso in Perps; simply withdrawing Perps margin to Spot does not cap total accessible collateral.
2. Re-read live market risk params, min quantity/lot size/tick size, mark freshness, account health, system wiring, engine config and insurance state immediately before the test.
3. Place only one minimum-size BTC position (currently around 10.45 USDso notional, recalculated at execution time) with no other positions or resting orders. Never add collateral automatically. Never manipulate the oracle/mark feed or use large opposing orders to force a price.
4. Simulate the intended keeper call with `eth_call` first against the same state and calldata; it must revert when the account is healthy and must be expected to pass only after the health precondition is independently satisfied. Exact function signature and call conditions must come from an authoritative ABI/source before this step.
5. On a fork, validate the exact entry point, health gate, event emission, state transition and recovery calls. A local fork test must be labeled simulation, not a live liquidation.
6. A live test is only considered if the account is genuinely below maintenance under the live mark, the exact write ABI and caller authorization are known, the test wallet is isolated to the 0.75 USDso cap, and the recovery procedure is rehearsed. A naturally adverse price move is not guaranteed; do not force it by manipulating protocol price inputs.

### Stop and recovery rules

- Before entry, record the wallet address, block, balances, current health, market mark, position size, and all open orders.
- If a position is opened but the account is not liquidatable, close it with a reduce-only order; verify the account is flat before withdrawing.
- If liquidation fires, save the transaction receipt and all logs from both LiquidationEngine and MarginBank; group sibling rows by transaction hash and decode `kind`, `stageReached`, `positionsProcessed`, `sizeDelta`, price, fee, takeover, insurance coverage and any residual-debt markers.
- Re-read chain state after confirmation. Verify all-market positions/orders are empty, locked collateral is zero, and margin/withdrawable balances reconcile. Withdraw remaining free collateral only after the position is confirmed flat.
- If the account is in terminal `CloseOut` with residual debt, or any state is ambiguous, stop. Do not automatically top up or make further trades; preserve evidence and ask DreamDEX for recovery guidance.
- Call cleanup complete only when the final chain reads confirm no positions, no orders, no locked collateral and a reconciled margin state. A flat position alone is not sufficient.

## 6. Why no live liquidation was sent

Two mandatory gates are still open:

1. The exact LiquidationEngine write entry point and its deployed preconditions have not yet been established from verified source or an authoritative write ABI. The read-only SDK event ABI is not a substitute.
2. The current wallet is cross-margin and has substantial Spot USDso that can potentially be pulled into a Perps order. There is no demonstrated way to enforce the proposed 0.75 USDso exposure cap on this account without isolating a separate wallet.

The existing deterministic Stress Lab model calibration and CI tests passed, but they are not a local fork of the deployed liquidation path. No liquidation transaction, liquidation receipt, or test-position result is claimed in this report.
