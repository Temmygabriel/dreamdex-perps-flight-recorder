# Perps Stress Lab

**Stress-test your position before you trade.**

Perps Stress Lab is a read-only risk explorer for dreamDEX Perps on Somnia Hideki/Tokyo testnet. It combines two separate tools: (1) a hypothetical position stress lab that lets users apply market shocks and inspect the maths, and (2) a public-address Account Risk Check that reads live cross-margin collateral, margin requirements, open positions, and SDK liquidation-price estimates. The app never asks for a private key or signs a transaction.

> **Important:** The stress slider is a hypothetical single-position model; it is not a liquidation calculator and its maintenance percentage remains an explicit scenario assumption. Separately, the Account Risk Check reads actual account-level cross-margin information from the SDK when available. That account view can show current equity and account-wide requirements, and estimate a liquidation price for each active market. An SDK liquidation-price estimate holds the other markets' contributions constant and is not a guarantee of liquidation execution. Missing/stale marks or RPC/indexer errors are shown as unavailable, never as zero or as a healthy status. The entry price in the hypothetical lab may be prefilled from a live top-of-book midpoint; that midpoint is not the protocol mark price.

## Current MVP

- Responsive light/dim product interface with an accessible toggle and locally persisted theme preference.
- Long/short hypothetical position inputs.
- Adjustable price shock from −50% to +50%.
- Editable starting margin and maintenance assumptions.
- Optional, explicitly simplified constant-rate funding scenario.
- Deterministic formula trace for stressed price, directional P&L, estimated equity, and estimated maintenance. Monetary figures are quote-unit estimates (USDso-equivalent), not withdrawable cash or guaranteed execution prices.
- Extracted pure calculation model with tests for long/short symmetry, linear quantity scaling, funding signs, zero and total-loss shocks, headroom invariants, invalid inputs, and arithmetic overflow.
- JSON export with inputs, outputs, assumptions, chain context and explicit `onChain: false` / `liveAccountDataUsed: false` verification flags.
- Reads live Hideki market definitions through `/api/markets` and requests a selected market’s top-of-book bid/ask midpoint through `/api/market-price`. The midpoint is explicitly **not** represented as the protocol mark price. If either endpoint is unavailable, manual scenarios remain available.
- Reads per-market initial-margin floor, effective initial margin, maintenance margin, close-out margin, fee parameters, position-size limit, and protocol mark-price availability via `/api/market-risk`.
- Provides a **read-only Account Risk Check** at `/api/account-risk`: enter a public EVM wallet address to read MarginBank equity, unlocked/locked/withdrawable collateral, account-wide initial/maintenance/close-out requirements, and positions with mark/PNL/funding/margin contributions. No private key or wallet connection is required.
- Uses the SDK `getLiquidationPrice()` estimate per active market where the required risk/mark data are available. It labels that estimate as market-at-a-time with other market contributions held constant, never as a liquidation guarantee.
- Handles empty accounts, multiple open positions, stale/unpriceable marks, and endpoint failures explicitly. When account health cannot be computed, the UI suppresses equity/health verdicts and may show collateral basis separately as **not equity**.

## Calculation model

For entry price `E`, quantity `Q`, price shock `s`, starting margin percentage `m`, and maintenance percentage `r`:

- Stressed price: `P = E × (1 + s / 100)`
- Long P&L: `Q × (P − E)`
- Short P&L: `Q × (E − P)`
- Starting margin: `Q × E × m / 100`
- Estimated maintenance: `Q × P × r / 100`
- Estimated headroom: `estimated equity − estimated maintenance`

Optional funding uses the documented sign and settlement cadence: the rate is quoted per 8-hour window and one eighth is applied per hourly settlement. The scenario holds the user-entered rate and entry notional constant. It is still an estimate; it does not model rate changes, exact index price, settlement timing, or all account accounting.

## Network

- Target network: Somnia Hideki/Tokyo testnet
- Chain ID: `50383`
- RPC: `https://api.hideki2.infra.testnet.somnia.network`
- Perps SDK pinned in `package.json`: `@somnia-chain/markets-sdk@0.32.1`
- The browser app does not need a private key or mainnet funds. Optional CI readiness checks use the GitHub Actions `wallet_key` secret only for read-only steps.

## Read-only Account Risk Check

The account feature is separate from the hypothetical stress calculator. It accepts a **public wallet address only** and uses read-only SDK calls on Somnia Hideki:

- `getMarginAccount()` reads the MarginBank cross-margin snapshot: account equity, unlocked and locked collateral, withdrawable funds, and initial/maintenance/close-out requirements.
- `listPerpPositionAnalytics({ marginBank, account })` reads the account's open positions and their mark/P&L/funding/margin contributions at a single pinned block, so the positions table does not combine rows from different chain heights. The UI filters zero-size pools because MarginBank active pools can also contain order-only pools. `getPerpPosition()` is used only to supplement stored position basis/size when a stale-mark analytics row omits those fields.
- `getLiquidationPrice()` provides an SDK-derived price estimate for that market moving against the account while contributions from other markets are held constant.
- `getPerpRiskParams()` and `getPerpHealthSnapshot()` expose market-specific risk parameters and whether the protocol currently considers the market priceable.
- If a stale mark prevents a full margin/health read, the API attempts to read collateral basis separately. Bulk position analytics can still preserve a position's signed size when its mark is stale; if the chain positions read is unavailable, the API falls back to indexer position rows and labels the result as potentially lagging. Collateral basis is not presented as account equity. If both the chain and indexer position sources fail, the UI shows position count as unavailable rather than zero.
- The endpoints are read-only and do not sign or submit transactions. Do not enter a seed phrase or private key.

**Interpretation and limits:** `getLiquidationPrice()` is an SDK estimate, not a prediction that the LiquidationEngine will successfully execute a close. A scenario in another market can change the shared cross-margin account state, so this is not a simultaneous portfolio-wide crash simulation. A missing/stale mark, RPC failure, or unavailable indexer yields an unavailable result, not zero, not a healthy status, and not a liquidation verdict.

**API routes:** `GET /api/market-risk?symbol=BTC-USDso` and `GET /api/account-risk?address=0x…&symbol=BTC-USDso`.


## Verification status

**The current branch is an implementation in progress.** Do not describe it as fully verified against Hideki until the following have been demonstrated:

- [x] GitHub Actions typecheck, unit tests and production build pass on the latest tested revision.
- [x] The production URL `https://perp-stress-lab.vercel.app` returns the live Hideki market list and a fresh BTC top-of-book midpoint. The midpoint is not the protocol mark price; preview verification is still skipped when Vercel preview protection blocks anonymous access.
- [x] Formula tests validate long/short symmetry, funding direction, quantity scaling, total-loss shock, headroom invariants, invalid inputs, and overflow protection.
- [x] CI performs a read-only Perps account readiness check: voucher eligibility and SDK max-order-size gate, without signing or sending a transaction.
- [x] A separate read-only Account Risk Check uses SDK MarginBank cross-margin views, per-position analytics and SDK liquidation-price estimates; it does not sign or submit transactions. See the edge-case test suite and deployment verification below.
- [x] Funded testnet position lifecycle passed using the existing `wallet_key`: transferred 5 USDso from the wallet into Perps margin, opened a BTC long MARKET position of 0.00014 BTC (guarded notional below 15 USDso), closed it, and verified no BTC position remained. Deposit, entry, and exit transaction hashes are recorded in the redacted workflow receipt. The position round-trip reduced the final Perps balance by about 0.000182 USDso from entry/exit price movement; no real funds were involved.
- [ ] Public Vercel deployment is tested on desktop and mobile.
- [x] Playwright browser tests cover live-price prefill and stale-quote rejection, live protocol risk display/stale-mark handling, public-address Account Risk Check, multiple positions, API failure states, long/short P&L direction, honest JSON export flags, mobile layout, and persisted light/dim theme switching.
- [ ] Deployed preview smoke check confirms the Vercel serverless endpoints are live and returning fresh Hideki data. The preview is currently access-protected; the preview check reports a skip unless `VERCEL_AUTOMATION_BYPASS_SECRET` is configured in GitHub Actions. A separate read-only check now also runs against the production URL after pushes to main.

A successful market read does not validate the hypothetical stress formula. Funding in the scenario lab uses one eighth of the quoted 8-hour rate per hourly settlement and holds the rate/notional constant. dreamDEX uses cross margin by default: positions share one USDso balance and maintenance is account-wide. The scenario calculator remains a transparent single-position what-if tool; the separate Account Risk Check uses SDK account views but is not a portfolio-wide simultaneous-crash model. Its liquidation price is the SDK's estimate with other market contributions held constant, not proof of LiquidationEngine execution. Protocol-reference tests check published margin tiers and funding examples; a live read-only script checks chain ID and MarginBank wiring. None of these steps substitutes for source verification or a controlled fork/stateful execution test.

## Manual funded testnet position lifecycle (verified)

The repository includes a [manually triggered GitHub Actions workflow](.github/workflows/testnet-position-roundtrip.yml). It skips the broken voucher self-claim path and uses the existing wallet-held USDso directly. The verified run used the account's existing 1.5 USDso Perps balance, deposited an additional 5 USDso from the wallet, opened and immediately closed one BTC long position, and confirmed the account was flat afterward. The position round-trip workflow itself leaves margin in Perps. A separate, independently verified Spot-withdrawal test has now successfully moved exactly 5 USDso back to the same wallet after confirming there were no open positions or orders. Both live transaction workflows are gated and run on Hideki testnet only.

The voucher defect remains a separate, known protocol issue: the SDK can report `eligible: true` while `VoucherDistributor.claim()` reverts with `0x3e31dcc2`. Independent reports document the same failure: [eligibility reports true while self-claim reverts](https://github.com/MrTimonM/findings/blob/6b42ad2df15b53b513783f554001d9692dc94fc3/feedback/01-voucher-eligibility-says-eligible-but-claim-always-reverts.md) and [the SDK cannot decode the VoucherDistributor selector](https://github.com/MrTimonM/findings/blob/6b42ad2df15b53b513783f554001d9692dc94fc3/feedback/08-sdk-cannot-decode-voucher-distributor-error.md). That issue no longer blocks trading for this wallet because we have verified the direct wallet-to-margin path.

Latest successful test evidence:
- Wallet-held USDso before deposit: **98.5 USDso**; after deposit: **93.5 USDso**.
- Existing Perps MarginBank equity before deposit: **1.5 USDso**.
- Deposit into Perps: **5 USDso**, transaction `0x908817b3dea134563a0109324f305d3676dc52a12ee7dd5f12e65405973e0b0c`.
- Perps equity after deposit: **6.5 USDso**.
- Open BTC long transaction: `0xf535738580db2a8a027cbbbca056ea3df6a07d353e0fa25351d9e4f78eda7662`; filled quantity **0.00014 BTC**, entry **84,293.7 USDso**.
- Close transaction: `0x4b98635d52a4d3010be63ba01b52cf1ad8c3c0fdd732d9b6091b22da705d6c43`.
- Final position read-back: **flat**, no open position; final Perps equity: **6.499818 USDso**.
- Full GitHub Actions run and artifact: https://github.com/Temmygabriel/dreamdex-perps-flight-recorder/actions/runs/39699761793.

To repeat a run after merging, open Actions → **Perps Stress Lab funded testnet position round-trip** → Run workflow and choose `YES`. If unlocked Perps margin is below 5 USDso, the workflow moves exactly 5 USDso from the existing wallet balance; if the account already has at least 5 USDso unlocked, it skips the transfer so repeated tests do not keep sweeping funds from the wallet. It then opens one BTC long MARKET position with a 15 USDso notional cap and immediately closes it. The workflow aborts if an existing position or BTC order is found, writes a redacted evidence receipt, and never prints the private key. This confirms a short open/close lifecycle on Hideki; it does not establish liquidation accuracy or constitute a sustained trading strategy. Never use a private key that controls mainnet funds.

## Manual Perps-to-Spot withdrawal (verified)

A separate [manually gated withdrawal workflow](.github/workflows/testnet-spot-withdrawal.yml) successfully withdrew exactly **5 USDso** from the Perps MarginBank back to the same wallet's Spot balance on Somnia Hideki testnet. The script refuses to broadcast unless chain ID is 50383, the wallet has no open positions or orders, and both unlocked and withdrawable collateral are at least 5 USDso. It then independently reads the wallet token balance and Perps margin to verify the exact deltas.

- Withdrawal transaction: `0x8e2ed2da20c038f1b462a65e48b52290d30ba46e60084b0d01fc119f0965bd57`.
- Spot USDso: **93.5 → 98.5**; independently read increase: **+5 USDso**.
- Perps unlocked/withdrawable collateral: **6.499832 → 1.499832 USDso**; independently read decrease: **−5 USDso**.
- Positions before/after: **0 / 0**.
- All receipt assertions passed: correct chain, exact Spot increase, exact Perps decrease, and no positions remaining.
- GitHub Actions run: https://github.com/Temmygabriel/dreamdex-perps-flight-recorder/actions/runs/39875589587.
- Redacted receipt artifact: https://github.com/Temmygabriel/dreamdex-perps-flight-recorder/actions/runs/39875589587/artifacts/12468646037.

The security and failure-recovery campaign checklist is in [SECURITY_STRESS_WITHDRAWAL_TEST_PLAN.md](SECURITY_STRESS_WITHDRAWAL_TEST_PLAN.md). Deterministic model tests now include a multi-dimensional invariant grid. These tests validate the simplified scenario formulas; they do **not** prove dreamDEX liquidation-engine accuracy or every possible protocol security property.

## Security and dependency audit

CI runs `npm audit --audit-level=high` and verifies the installed dependency tree. The repository currently has no committed `package-lock.json`; the audit job generates a temporary lockfile during CI. This detects known advisories for the resolved dependency tree in that run, but dependency versions are not yet reproducible across separate clean installs. Commit a reviewed lockfile before treating dependency resolution as fully reproducible. API handlers return generic upstream failure messages rather than exposing raw SDK exception strings.

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

The interface uses a clean light palette with an optional subdued slate dim palette, high-contrast scenario values and monospace calculation details. Its purpose is to help a trader or judge understand the workflow in seconds: configure a position → apply stress → inspect the math → export a report.
