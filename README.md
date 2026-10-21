# Perps Stress Lab

**Stress-test your position before you trade.**

Perps Stress Lab is a scenario explorer for dreamDEX Perps on Somnia Hideki testnet. Configure a hypothetical isolated position, apply an adverse or favourable price move, inspect estimated P&L/equity/maintenance headroom, and export a transparent JSON scenario report.

> **Important:** This is a simplified educational stress model, not a liquidation-price calculator, financial advice, or proof of protocol liquidation behaviour. Position size, margin, maintenance and shock assumptions are user-controlled. The entry price is prefilled from the selected live top-of-book midpoint when available and remains editable. A market-list endpoint may be queried for context, but the calculation does not claim to use a live account's actual margin state.

## Current MVP

- Responsive dark product interface and branded identity.
- Long/short hypothetical position inputs.
- Adjustable price shock from −50% to +50%.
- Editable starting margin and maintenance assumptions.
- Optional, explicitly simplified constant-rate funding scenario.
- Deterministic formula trace for stressed price, directional P&L, estimated equity, and estimated maintenance. Monetary figures are quote-unit estimates (USDso-equivalent), not withdrawable cash or guaranteed execution prices.
- Extracted pure calculation model with tests for long/short symmetry, linear quantity scaling, funding signs, zero and total-loss shocks, headroom invariants, invalid inputs, and arithmetic overflow.
- JSON export with inputs, outputs, assumptions, chain context and explicit `onChain: false` / `liveAccountDataUsed: false` verification flags.
- Reads live Hideki market definitions through `/api/markets` and requests the selected market’s top-of-book bid/ask midpoint through `/api/market-price`. The midpoint is explicitly **not** represented as the protocol mark price. If either endpoint is unavailable, manual scenarios remain available.

## Calculation model

For entry price `E`, quantity `Q`, price shock `s`, starting margin percentage `m`, and maintenance percentage `r`:

- Stressed price: `P = E × (1 + s / 100)`
- Long P&L: `Q × (P − E)`
- Short P&L: `Q × (E − P)`
- Starting margin: `Q × E × m / 100`
- Estimated maintenance: `Q × P × r / 100`
- Estimated headroom: `estimated equity − estimated maintenance`

Optional funding is a deliberately simplified scenario: positive 8-hour rate means longs pay shorts; it applies the user-entered constant rate to entry notional for whole 8-hour periods. This does not reproduce all dreamDEX settlement/accounting behaviour.

## Network

- Target network: Somnia Hideki/Tokyo testnet
- Chain ID: `50383`
- RPC: `https://api.hideki2.infra.testnet.somnia.network`
- Perps SDK pinned in `package.json`: `@somnia-chain/markets-sdk@0.32.1`
- The browser app does not need a private key or mainnet funds. Optional CI readiness checks use the GitHub Actions `wallet_key` secret only for read-only steps.

## Verification status

**The current branch is an implementation in progress.** Do not describe it as fully verified against Hideki until the following have been demonstrated:

- [x] GitHub Actions typecheck, unit tests and production build pass on the latest tested revision.
- [x] The production URL `https://orderproof-perp.vercel.app` returns the live Hideki market list and a fresh BTC top-of-book midpoint. The midpoint is not the protocol mark price; preview verification is still skipped when Vercel preview protection blocks anonymous access.
- [x] Formula tests validate long/short symmetry, funding direction, quantity scaling, total-loss shock, headroom invariants, invalid inputs, and overflow protection.
- [x] CI performs a read-only Perps account readiness check: voucher eligibility and SDK max-order-size gate, without signing or sending a transaction.
- [ ] Any account-aware stress mode is implemented only after the SDK exposes the required Perps account data and it is validated against the protocol.
- [ ] The bounded testnet order workflow was executed twice against the configured test wallet, but both attempts stopped at the voucher `eth_call` simulation with unknown custom error selector `0x3e31dcc2`; no order-placement or cancellation transaction was submitted. Order lifecycle remains unverified and the voucher claim must be diagnosed with dreamDEX before retrying.
- [ ] Public Vercel deployment is tested on desktop and mobile.
- [ ] Playwright browser tests cover live-price prefill, long/short P&L direction, honest JSON export flags, and 360–390px mobile layout. The new mobile styling tests are being used to close the final horizontal-overflow regression before this item is marked complete.
- [ ] Deployed preview smoke check confirms the Vercel serverless endpoints are live and returning fresh Hideki data. The preview is currently access-protected; the preview check reports a skip unless `VERCEL_AUTOMATION_BYPASS_SECRET` is configured in GitHub Actions. A separate read-only check now also runs against the production URL after pushes to main.

A successful market read does not validate the stress model. A successful order does not prove liquidation accuracy. The model must not claim protocol-accurate liquidation prediction without independently validated account-equity rules, fees, funding, cross-margin interactions and liquidation-engine behaviour.

## Manual testnet order lifecycle (blocked at voucher claim)

The repository includes [a manually gated GitHub Actions workflow](.github/workflows/testnet-order-smoke.yml) that preflights the paper-USDso voucher, then places one capped POST_ONLY BTC order and cancels it. I also attempted a one-time authorized run using the configured GitHub secret. The SDK reports `claim reverted: for an unknown reason` with raw revert data `0x3e31dcc2` during `eth_call`; the published SDK preflight still reports eligible, the campaign has ample budget, the voucher is unclaimed, and the wallet has no BTC open orders. The script now resolves the live campaign distributor explicitly and logs safe structured error details. Do not retry until the contract-side revert is decoded.

Before running it:
1. Confirm `wallet_key` contains a wallet funded for Hideki testnet only. The secret is injected only into the transaction step; it is never printed or uploaded.
2. Ensure the new wallet has Hideki testnet STT for gas.
3. After this branch is merged, open Actions → **Perps Stress Lab testnet order smoke** → Run workflow. Select `YES` only when authorizing the voucher claim (if eligible), one 10–15 USDso-equivalent POST_ONLY order, and cancellation.
4. Inspect the uploaded receipt. A transaction hash alone is not enough: the test passes only if the order appears in open-order read-back, is cancelled, disappears from read-back, and reports zero fills.

The attempted runs did not broadcast a claim or order transaction because the claim simulation reverted first. The receipt contains no transaction hashes. Never use a private key that controls mainnet funds.

## Security and dependency audit\n\nCI now runs `npm audit --audit-level=high` and verifies the installed dependency tree. The repository currently has no committed `package-lock.json`; the audit job generates a temporary lockfile during CI. This detects known advisories for the resolved dependency tree in that run, but dependency versions are not yet reproducible across separate clean installs. Commit a reviewed lockfile before treating dependency resolution as fully reproducible. API handlers return generic upstream failure messages rather than exposing raw SDK exception strings.\n\n## Run checks

Requires Node.js 20.19+.

```bash
npm install
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Run heavyweight checks in GitHub Actions if your local machine is resource-constrained.

## Official references

- [dreamDEX Perps developer guide](https://app.testnet.dreamdex.io/docs/developers/perps-testnet)
- [dreamDEX Perps trading guide](https://app.testnet.dreamdex.io/docs/trading/perps-testnet)
- [Margin and liquidation mechanics](https://app.dreamdex.io/docs/trading/perps-testnet/margin-and-liquidations)
- [Funding mechanics](https://app.dreamdex.io/docs/trading/perps-testnet/funding)
- [dreamDEX Perps Builder Bounty](https://dorahacks.io/hackathon/dreamdex-perps-bounty/detail)

## Brand

**Perps Stress Lab**  
*Stress-test before you trade.*

The interface uses deep navy, restrained violet highlights, high-contrast scenario values and monospace calculation details. Its purpose is to help a trader or judge understand the workflow in seconds: configure a position → apply stress → inspect the math → export a report.
