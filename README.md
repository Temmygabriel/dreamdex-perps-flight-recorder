# Perps Stress Lab

**Stress-test your position before you trade.**

Perps Stress Lab is a scenario explorer for dreamDEX Perps on Somnia Hideki testnet. Configure a hypothetical isolated position, apply an adverse or favourable price move, inspect estimated P&L/equity/maintenance headroom, and export a transparent JSON scenario report.

> **Important:** This is a simplified educational stress model, not a liquidation-price calculator, financial advice, or proof of protocol liquidation behaviour. The current scenario uses manual position inputs. A market-list endpoint may be queried for context, but the calculation does not claim to use a live account's actual margin state.

## Current MVP

- Responsive dark product interface and branded identity.
- Long/short hypothetical position inputs.
- Adjustable price shock from −50% to +50%.
- Editable starting margin and maintenance assumptions.
- Optional, explicitly simplified constant-rate funding scenario.
- Deterministic formula trace for stressed price, directional P&L, estimated equity, and estimated maintenance. Monetary figures are quote-unit estimates (USDso-equivalent), not withdrawable cash or guaranteed execution prices.
- Extracted pure calculation model with automated tests for long/short P&L, funding signs, zero-shock behavior, and invalid inputs.
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
- No private key or mainnet funds are needed for the current scenario MVP.

## Verification status

**The current branch is an implementation in progress.** Do not describe it as fully verified against Hideki until the following have been demonstrated:

- [ ] GitHub Actions typecheck, unit tests and production build pass (latest code must be green).
- [ ] Live market-list and order-book midpoint endpoints are verified in the deployed Vercel preview; the midpoint is not the protocol mark price.
- [ ] Formula tests independently validate long and short cases, shock direction, funding signs and threshold edge cases.
- [x] CI performs a read-only Perps account readiness check: voucher eligibility and SDK max-order-size gate, without signing or sending a transaction.
- [ ] Any account-aware stress mode is implemented only after the SDK exposes the required Perps account data and it is validated against the protocol.
- [ ] If a separate testnet order flow is ever added, the user explicitly approves the transaction and the app verifies transaction receipt, read-back and cleanup.
- [ ] Public Vercel deployment is tested on desktop and mobile.
- [x] Playwright browser smoke tests cover live-price prefill, long/short P&L direction, honest JSON export flags, and mobile overflow against mocked API responses.
- [ ] Deployed preview smoke check confirms the Vercel serverless endpoints are live and returning fresh Hideki data. The preview is currently access-protected; the check reports a skip unless `VERCEL_AUTOMATION_BYPASS_SECRET` is configured in GitHub Actions.

A successful market read does not validate the stress model. A successful order does not prove liquidation accuracy. The model must not claim protocol-accurate liquidation prediction without independently validated account-equity rules, fees, funding, cross-margin interactions and liquidation-engine behaviour.

## Run checks

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
