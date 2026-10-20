# Build plan

The bounty submission closes on 1 November 2026 at 23:59 UTC. We need one proven path before UI polish.

## Gate 0 — project setup (started)

- [x] Public repository created.
- [x] Official SDK pinned to version 0.32.1, matching the current developer guide.
- [x] TypeScript check and deterministic order-rule tests added.
- [x] GitHub Actions installed without any private keys.
- [x] Read-only testnet diagnostic added.
- [ ] Confirm the first read-only SDK call succeeds against Hideki.
- [ ] Add and commit a lockfile after dependency resolution is stable.

## Gate 1 — account and API forensics

- [ ] Discover live market rows, their current decimal precision, min quantity, lot size and tick size.
- [ ] Test read-only SDK calls and save the SDK version/network in each report.
- [ ] Test public market-data and account-query behaviors where possible.
- [ ] Compare the official SDK example with actual behavior.
- [ ] Record candidate issues privately in notes first; do not publish a report until the issue is reproduced and duplicate risk has been checked.
- [ ] Security vulnerabilities must be sent privately to security@dreamdex.io.

## Gate 2 — safest real testnet order

- [ ] Use a dedicated testnet bot key, never an everyday wallet key.
- [ ] Confirm the correct account, testnet chain ID 50383, gas balance, and paper collateral.
- [ ] Query the market's current rules and live price.
- [ ] Call the SDK order-size preflight and reject stale prices, voucher-blocked markets, insufficient margin, or invalid sizes.
- [ ] Show the full order details before the user explicitly approves.
- [ ] Submit a small testnet order.
- [ ] Save the transaction hash and receipt.
- [ ] Read the order/position/fill state again; a transaction receipt alone is not enough to prove the intended trade happened.
- [ ] Cancel a resting order or close the position and verify the final state.

## Gate 3 — product UI

- [ ] Show market, side, price, quantity, size limits, margin/gas checks and a plain-English result.
- [ ] Separate "preflight passed" from "order submitted" and "result independently verified".
- [ ] Export an evidence receipt as JSON and Markdown.
- [ ] Make failure reasons useful and never display fake green success states.
- [ ] Mobile and desktop layout; premium but product-specific design.

## Gate 4 — final submission

- [ ] Re-run CI.
- [ ] Capture evidence from the canonical live testnet run.
- [ ] Ensure README explains product, user, setup, architecture, known limits and reproduction.
- [ ] Add 2–3 X post links that mention @DreamDEXSomnia, as required by the bounty.
- [ ] Publish the DoraHacks Build only after the email is confirmed whitelisted.
