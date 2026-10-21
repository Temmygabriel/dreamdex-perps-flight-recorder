# Perps Practice Desk — Product Pivot

## Decision

Pivot the existing OrderProof workbench into **Perps Practice Desk**, a guided, testnet-only trading practice product for dreamDEX Perps. Keep the working SDK integration and explicit wallet-approved transaction flow; replace the developer-debugger framing with a user workflow.

## Product promise

Turn a trading idea into a bounded testnet session: write a thesis, set a maximum order notional, inspect live market constraints, run account-aware preflight, place a post-only order only after wallet approval, cancel it, verify the read-back state, and retain a session record.

## Why this is the chosen wedge

- Uses the sponsor-native Perps SDK and live Hideki market/account rules as the core mechanic.
- Produces a visible and verifiable state change rather than a static dashboard.
- Gives a repeat-use loop: plan → check → execute → verify → journal → repeat.
- Reuses the existing implementation instead of restarting and risking the deadline.
- Stays on Somnia Hideki testnet (chain ID `50383`); no mainnet funds or private-key storage are required.

## MVP scope

1. Guided session plan with one-sentence thesis.
2. Selectable order-notional caps of 5, 10, or 25 paper USDso; the chosen cap must be enforced in the UI before a write. It is an order-value cap, not a maximum-loss guarantee.
3. Live market rules and SDK order-size preflight.
4. Explicit wallet approval for post-only testnet order placement.
5. Explicit cancellation and open-order read-back verification.
6. Local session journal with pending / verified / incomplete status and JSON export.
7. Evidence receipt with transaction hashes and clear limitations.

## Non-goals

- No autonomous trading or AI-generated trade signals.
- No claims of profitability or guaranteed risk limits.
- No mainnet trading, private-key collection, or bypassing wallet security alerts.
- No claim that an order lifecycle is verified until real testnet evidence proves it.
- No public-feedback report unless the issue is reproduced and checked for duplicates.

## Acceptance gates

- CI typecheck, tests, and production build pass.
- Budget cap is enforced both before preflight is presented as passed and again immediately before a transaction.
- Session journal distinguishes pending from independently read-back-verified outcomes.
- A real testnet order is placed only by the user approving it in their wallet; cancellation is explicit.
- README, demo, and submission claims match actual evidence.
