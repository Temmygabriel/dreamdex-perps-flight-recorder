# Perps Practice Desk build plan

The bounty submission closes on 1 November 2026 at 23:59 UTC. The goal is one understandable product workflow with real, reproducible testnet evidence—not a broad trading terminal.

## Product contract

Perps Practice Desk guides a user through: plan a test → choose an order-value budget → inspect live market/account constraints → place a post-only testnet order with explicit wallet approval → cancel it → verify read-back → keep a session journal.

## Implemented in this pivot branch

- [x] Reframed the app from a developer debugging workbench into a guided practice session.
- [x] Added required trade-thesis input.
- [x] Added selectable order-value caps: 5, 10, or 25 paper USDso.
- [x] Enforced the selected cap when presenting preflight results and again immediately before a wallet transaction.
- [x] Added a browser-local journal with pending / verified / incomplete states and JSON export.
- [x] Added session thesis and budget to the order evidence receipt.
- [x] Kept the existing read-only market reads, account-aware SDK preflight, post-only order, explicit cancellation, and read-back verification.
- [x] Kept the existing warning not to bypass wallet phishing/security alerts.

## Not yet proven

- [ ] GitHub Actions typecheck, deterministic tests, and production build pass for this branch.
- [ ] Confirm the local journal behaves correctly in a real browser, including browser storage being unavailable.
- [ ] Confirm the session budget blocks an oversized order in a browser test.
- [ ] Complete a real order/cancel/read-back test on Hideki testnet with the user's explicit wallet approval.
- [ ] Verify the deployed Vercel URL serves the new branch after merge/deployment.
- [ ] Capture a judge-ready 60-second demo with actual, redacted evidence.
- [ ] Publish 2–3 real X posts tagging `@DreamDEXSomnia` and add their links.
- [ ] Confirm DoraHacks whitelist status before attempting submission.

## Safety and truthfulness gates

- Chain: Somnia Hideki / Tokyo testnet, chain ID `50383`.
- The app does not need a private key or mainnet funds.
- The chosen budget caps estimated order notional only. It does not guarantee maximum loss, prevent all fills, or replace Perps margin/liquidation rules.
- A transaction receipt alone is not enough. Only report a verified lifecycle when the order was observed after placement, cancellation succeeded, and read-back confirmed it absent.
- If a wallet displays a phishing/drainer warning, stop and seek an official wallet security review. Never bypass the warning to demo the app.
- No real trade or bounty acceptance should be claimed until evidence exists.

## Final submission

- [ ] CI green.
- [ ] README describes the user, core loop, architecture, setup, limits, and proof accurately.
- [ ] Live app and mobile layout checked.
- [ ] Evidence receipt and journal export reviewed for sensitive data.
- [ ] 2–3 X post links added to README.
- [ ] DoraHacks submission checked against the current bounty rules.
