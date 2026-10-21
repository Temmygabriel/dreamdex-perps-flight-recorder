# Spot DEX builder-code documentation gives conflicting testnet cap values

Severity: normal (provisional; bounty relevance unconfirmed)
Area: docs

## Scope warning — do not submit as a Perps-specific finding yet

This contradiction is on the official **SpotPool / OrderBook** contract documentation. It is not established as a Perps contract issue. The page does not prove that its stated testnet value applies to Somnia Tokyo / Hideki Perps testnet (chain ID `50383`). Keep this as a platform-documentation candidate only until the bounty organizer confirms that Spot DEX documentation is in scope for the Perps Builder Bounty.

## Steps to reproduce

1. Open the official [contract functions documentation](https://app.testnet.dreamdex.io/docs/developers/contracts/functions).
2. Confirm the page's scope is **SpotPool / OrderBook**.
3. Find the **Builder Codes** section.
4. Read the paragraph beginning **Availability**.
5. Read the description immediately below `getMaxBuilderFeeBpsTimes1k`.

## Expected

The documentation should state one consistent current cap for the environment and contract being documented, and distinguish Spot DEX values from Perps values where their deployments differ.

## Actual

The same page gives two conflicting descriptions:

- The **Availability** paragraph says the cap is currently `100000` (100 BPS / 1%) on every pool on both mainnet and testnet.
- The `getMaxBuilderFeeBpsTimes1k` description later says the current value is `100000` on mainnet and `0` on testnet.

The page says a cap of `0` disables builder codes and a non-zero builder reverts with `BuilderCodesNotSupported`. An integrator following one statement may therefore build or test a different flow from an integrator following the other.

The official [contract-errors documentation](https://app.testnet.dreamdex.io/docs/developers/contracts/errors) repeats the claim that the cap is `100000` on both mainnet and testnet. The official [builder-fees API documentation](https://app.testnet.dreamdex.io/docs/developers/http-api/builder-fees) explains that a cap of `0` disables builder codes. These pages support the existence of the documentation inconsistency, but do not establish the live value on any specific Perps pool.

## Evidence

- Contract functions: https://app.testnet.dreamdex.io/docs/developers/contracts/functions
- Contract errors: https://app.testnet.dreamdex.io/docs/developers/contracts/errors
- Builder-fees API: https://app.testnet.dreamdex.io/docs/developers/http-api/builder-fees
- Reproduction: the conflicting statements are visible on the contract-functions page.
- No transaction was sent and no state-changing call was made.
- A direct read-only RPC check of the Perps contract value has **not** been completed.

## Environment

- Product scope observed: Spot DEX `SpotPool / OrderBook` documentation
- Perps network: not tested for this finding; do not infer a Perps cap from the Spot DEX page
- Wallet address: not applicable; no wallet was used
- Runtime: browser, official documentation pages

## Acceptance caveat

This is a provisional normal-severity documentation candidate, not a confirmed contract or SDK bug. Before submitting it to the Perps Builder Bounty, confirm that Spot DEX documentation is in scope and search for duplicates. Do not describe it as a Perps-specific defect unless the team confirms that connection.
