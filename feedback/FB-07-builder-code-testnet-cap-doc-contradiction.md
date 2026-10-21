# Perps contract docs contradict themselves about the testnet builder-code cap

Severity: normal
Area: docs

## Steps to reproduce

1. Open the official [Perps testnet contract functions documentation](https://app.testnet.dreamdex.io/docs/developers/contracts/functions).
2. Find the **Builder Codes** section.
3. Read the paragraph beginning **Availability**.
4. Read the description immediately below the `getMaxBuilderFeeBpsTimes1k` function.

## Expected

The official documentation should state one consistent testnet value for `getMaxBuilderFeeBpsTimes1k()`, and clearly distinguish the current testnet value from mainnet values.

## Actual

The same page gives two conflicting current-state descriptions:

- The **Availability** paragraph says the cap is currently `100000` (100 BPS / 1%) on every pool on both mainnet and testnet.
- The `getMaxBuilderFeeBpsTimes1k` description later says the current value is `100000` on mainnet and `0` on testnet.

Those statements cannot both describe the current testnet configuration. The page itself says a cap of `0` disables builder codes and causes a non-zero builder to revert with `BuilderCodesNotSupported`, so the contradiction can lead an integrator to implement or test the wrong flow.

This report is limited to the documentation contradiction. It does **not** claim that the live contract has either value; the live testnet value should be checked independently before relying on either statement.

## Evidence

- Official page: https://app.testnet.dreamdex.io/docs/developers/contracts/functions
- Relevant section: **Builder Codes**, including **Availability** and **getMaxBuilderFeeBpsTimes1k**
- Reproduction: both contradictory statements are present on the same documentation page.
- No transaction was sent and no state-changing call was made.

## Environment

- SDK version: `@somnia-chain/markets-sdk@0.32.1` (project-pinned; documentation inconsistency is visible without running the SDK)
- Network: Somnia Tokyo / Hideki testnet, chain ID `50383`
- Wallet address: not applicable; no wallet was used
- Runtime: browser, official docs page

## Scope and limitation

This is a normal-severity documentation issue, not a confirmed contract or SDK bug. It should be accepted only if the bounty team confirms it is not already reported and agrees that the contradictory current-state instructions are useful to fix.
