# Hideki testnet readiness record

Last read-only check: 21 October 2026 (UTC). This is a timestamped diagnostic snapshot, not a guarantee that current prices or account state are unchanged.

## Network and wallet

- RPC chain ID matched Somnia Hideki testnet: `50383`.
- Wallet address was derived from the GitHub Actions secret without printing or saving the private key.
- Native gas balance observed: `50 STT`.
- No transaction was submitted by the readiness workflow.

## Perps account gate

- Market: BTC Perps.
- Live book was available and the SDK reported the market as priceable.
- Voucher eligibility: `eligible: true`.
- SDK order-size result before claiming collateral: `placeable: false`, `maxQuantity: 0`, `limitedBy: collateral`.

Interpretation: native STT gas was present, but the Perps account did not yet have usable USDso collateral. The SDK's official developer guide describes a one-time 1,000 paper-USDso Perps voucher claim for an eligible address with no open Perps positions or orders. Claiming it is an on-chain transaction; the current readiness check intentionally does not claim it.

The repository now contains a manually triggered, hard-capped POST_ONLY order/cancel workflow. It blocks the previously tested wallet address and is intentionally not push-triggered. It has been typechecked but not executed.

## Still required before calling the bounty flow end-to-end verified

1. Use a dedicated testnet-only key; do not reuse a wallet key that controls mainnet funds.
2. Explicitly authorize the one-time voucher claim and a capped `POST_ONLY` test order.
3. Verify the order receipt, zero fills, order visibility, cancellation receipt and absence from open orders.
4. Save a redacted evidence receipt containing public addresses and transaction hashes only—never a private key.
5. Do not describe the stress estimate as protocol-accurate liquidation prediction without a separate model-validation effort.
