# Feedback Track Test Matrix

**Purpose:** find and document genuine, reproducible dreamDEX Perps/SDK issues for the dreamDEX Perps Builder Bounty. This is a list of test ideas, **not a list of confirmed bugs**.

**Rule:** every item stays `NOT TESTED` until the steps below produce repeatable evidence. Do not submit documented restrictions as bugs, do not duplicate another report, and do not publish security vulnerabilities here. Security issues go through dreamDEX's private disclosure route.

## Prioritised test plan

| ID | Priority | Hypothesis to test | Safe reproduction plan | Evidence needed | Status |
|---|---|---|---|---|---|
| FB-01 | High | SDK market metadata disagrees with the live pool/system configuration | Read several current Perps market rows. Compare pool address, MarginBank, quote token, decimals, tick, lot and minimum values with the documented system-config / pool reads. No transaction needed. | Chain ID/block, SDK version, market symbol, raw SDK row and on-chain values, small script output. | NOT TESTED |
| FB-02 | High | Perps order-size preflight can give a confusing or inconsistent limiting reason when the account's margin and wallet balances differ | With the builder's explicit permission, read the same testnet account's MarginBank snapshot and USDso wallet balance. Compare `getMaxPerpOrderSize` results with `autoPull: false` and `autoPull: true` where the documented API allows both. Read-only only. | Public address, market, time/block, unlocked/equity margin, wallet USDso balance, both full SDK results and matching documentation. | NOT TESTED |
| FB-03 | High | SDK market parameters and exact tick/lot/minimum boundaries do not agree | Select markets with different base decimals. Use bigint-only arithmetic to test values just below, exactly at, and just above each grid boundary; cross-check raw values against on-chain parameters. Do not send transactions. | Raw integer inputs, SDK metadata, on-chain values, expected calculation, script/test output. | NOT TESTED |
| FB-04 | Medium | Read-only mark, quote and order-book APIs return contradictory or stale values without identifying the state | Take a small number of timestamped snapshots for selected markets. Compare SDK mark/priceable values, top-of-book bid/ask and any available timestamps. No stress tests or rapid polling. | UTC timestamps, market, raw responses, SDK version, expected versus actual behaviour. | NOT TESTED |
| FB-05 | Medium — requires one authorised testnet write | A confirmed order can be reported as an incorrect final state by documented read-back paths | Only after the first normal order flow is safely enabled, place one small post-only test order, record the transaction receipt/block/order ID, and compare indexed open-order results with canonical state at controlled intervals. Explicitly cancel the order and verify cleanup. | User-approved test, transaction hashes, receipt status/block, order ID/event, timestamps and every read-back result. | NOT TESTED |
| FB-06 | Medium | A documented perps error/restriction is not represented consistently by the SDK or developer docs | First test using local validation and read-only call/simulation paths. Check the documented handling of voucher-restricted markets, isolated-market restrictions, stale marks and post-only crossing. Only escalate to a transaction if necessary and explicitly approved. | Exact request or simulated call, SDK output/error, matching docs/ABI reference, repeat steps. | NOT TESTED |

## Known duplicate / don't waste time

- The public bot-kit already has [issue #31](https://github.com/somnia-chain/dreamdex-bot-kit/issues/31) about intermittent `RegistryMarkets` indexer fetch failures. Do not submit a generic "indexer sometimes fails" report. A distinct Perps-specific issue would need separate, reproducible evidence.
- The current project pins `@somnia-chain/markets-sdk` `0.32.1`, and the project's CI has already installed/built that dependency. Do not submit "version 0.32.1 cannot be installed" without fresh evidence that contradicts that result or a separate official docs/package mismatch.

## Report gate

Before creating an individual report file under this directory:

1. Reproduce the same unexpected result at least twice with a minimal example.
2. Check current official docs, SDK/bot-kit issues and pull requests for duplicates.
3. State what should have happened and what actually happened.
4. Save raw, redacted evidence with SDK version and chain ID `50383`.
5. Confirm this is not an expected restriction (for example, empty Perps margin, paper USDso market allowlist, isolated account rules or a stale mark).

Only after this gate passes should an individual report be marked `REPRODUCED`. A plausible hypothesis is not a bounty submission.
