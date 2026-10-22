# Perps Stress Lab

**Stress-test your position before you trade.**

Perps Stress Lab is a scenario explorer for dreamDEX Perps on Somnia Hideki testnet. Configure a hypothetical isolated position, apply an adverse or favourable price move, inspect estimated P&L/equity/maintenance headroom, and export a transparent JSON scenario report.

> **Important:** This is a simplified educational stress model, not a liquidation-price calculator, financial advice, or proof of protocol liquidation behaviour. Position size, margin, maintenance and shock assumptions are user-controlled. The entry price is prefilled from the selected live top-of-book midpoint when available and remains editable. A market-list endpoint may be queried for context, but the calculation does not claim to use a live account's actual margin state.

## Current MVP

- Responsive light/dim product interface with an accessible toggle and locally persisted theme preference.
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
- [x] A bounded live testnet order lifecycle succeeded using the configured `wallet_key`: one BTC POST_ONLY order for 11.775442 paper USDso was mined, visible in open-order read-back, then cancelled and absent from read-back, with zero fills. The order test step passed; the overall temporary workflow run was marked failed only because its optional result-comment step lacked GitHub permission. No voucher claim or additional margin deposit was needed for this account.
- [ ] Public Vercel deployment is tested on desktop and mobile.
- [x] Playwright browser tests cover live-price prefill, long/short P&L direction, honest JSON export flags, 360–390px mobile layout, and persisted light/dim theme switching.
- [ ] Deployed preview smoke check confirms the Vercel serverless endpoints are live and returning fresh Hideki data. The preview is currently access-protected; the preview check reports a skip unless `VERCEL_AUTOMATION_BYPASS_SECRET` is configured in GitHub Actions. A separate read-only check now also runs against the production URL after pushes to main.

A successful market read does not validate the stress model. A successful order does not prove liquidation accuracy. The model must not claim protocol-accurate liquidation prediction without independently validated account-equity rules, fees, funding, cross-margin interactions and liquidation-engine behaviour.

## Manual testnet order lifecycle (verified)

The repository includes a [manually gated GitHub Actions workflow](.github/workflows/testnet-order-smoke.yml). It now uses existing USDso directly and **does not call the broken self-claim voucher path**. The separate voucher defect is still real: `getPerpVoucherEligibility()` can report eligible while `VoucherDistributor.claim()` reverts with `0x3e31dcc2`, documented in independent Hideki reproductions: [eligibility reports true while self-claim reverts](https://github.com/MrTimonM/findings/blob/6b42ad2df15b53b513783f554001d9692dc94fc3/feedback/01-voucher-eligibility-says-eligible-but-claim-always-reverts.md) and [the SDK cannot decode the VoucherDistributor selector](https://github.com/MrTimonM/findings/blob/6b42ad2df15b53b513783f554001d9692dc94fc3/feedback/08-sdk-cannot-decode-voucher-distributor-error.md). We have now proven that this defect is not blocking an order with the configured wallet's existing margin.

The successful bounded run established these facts about the configured test wallet:
- Wallet-held USDso balance before the test: **98.5 USDso**.
- Existing Perps MarginBank equity/withdrawable balance: **1.5 USDso**.
- Test order: BTC long, limit price **84,110.3**, quantity **0.00014 BTC**, notional **11.775442 USDso** (hard cap 15).
- Placement transaction: `0xc8520fbe1289a25986b0845854d5912ae27fab6f37cb614003c3d9e275749913`.
- Cancellation transaction: `0x6b9717c9a5f7186cffa2cf295f5844dcd61ec71eae322407720cf72e92fbc179`.
- Order ID: `15052543164147000979172`; visible after placement, absent after cancellation, and zero fills.
- No voucher claim, additional collateral deposit, or open position was created by this resting-order test.

The updated workflow follows this sequence: check the actual collateral token and the Perps order-size gate; if—and only if—collateral is the blocker, deposit a fixed 1.5 USDso from the existing wallet balance when available; stop on any other gate; place one 10–15 USDso-equivalent POST_ONLY order; cancel it; and verify visibility, removal, and zero fills. The private key is never printed or uploaded. This proves order placement/cancellation only; it does not verify filled-position opening, closing, or liquidation accuracy.

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

The interface uses a clean light palette with an optional subdued slate dim palette, high-contrast scenario values and monospace calculation details. Its purpose is to help a trader or judge understand the workflow in seconds: configure a position → apply stress → inspect the math → export a report.
