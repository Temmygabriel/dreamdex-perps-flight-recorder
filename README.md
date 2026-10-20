# Perps Flight Recorder

Perps Flight Recorder is a testnet-first trader tool for dreamDEX perpetual futures on Somnia Hideki/Tokyo testnet (chain ID 50383).

It is designed to do four things clearly:

1. Read current perps markets and their trading rules from the official SDK.
2. Check an order's market, price tick, quantity step, minimum size, live priceability, and account size limits before any transaction is sent.
3. Require a separate, explicit action before submitting an order.
4. Save a truthful execution receipt containing the request, result, transaction hash (when returned), and a read-back verification status.

## Network and money

- **MVP target:** Somnia Hideki/Tokyo **testnet**, chain ID `50383`.
- **No mainnet trading is required to submit the MVP on November 1, 2026.**
- Testnet orders use fake/paper USDso collateral. The current Perps Arena gives a test wallet 1,000 paper USDso each week and 20 STT for gas. The developer docs report approximately 0.0003–0.003 STT for a transaction to a perp pool. The app and testnet rules can change; see the official links below.
- The separate $200 post-award payment condition says an MVP winner must place orders on mainnet within 30 days after perps mainnet launches. Mainnet perps are not currently available, so this is a future condition, not a current build requirement.
- The separate Perps Arena competition's reward eligibility rules may ask for SOMI on mainnet. Those are **not the same as the DoraHacks Builder Bounty rules**.

## Important safety rules

- Never put a main wallet's private key in this repository, Vercel, or GitHub Actions.
- Use a new, dedicated **testnet-only bot key**. Do not use the private key for your everyday wallet.
- GitHub Actions tests should be read-only by default. No test should broadcast an order unless a separate manual workflow is explicitly enabled.
- Never print private keys or full environment values in logs.
- A paper USDso voucher is not withdrawable real money.
- Do not claim an API/SDK issue in the bounty submission unless its behavior has been reproduced and the evidence is saved.

## Current status

This repository was empty at project start. The first implementation phase is SDK/network diagnostics and deterministic unit tests. Live-order capability is gated until SDK compatibility, account setup, and transaction verification have passed.

## Official resources

- [Perps developer guide](https://app.testnet.dreamdex.io/docs/developers/perps-testnet)
- [Perps trading guide](https://app.testnet.dreamdex.io/docs/trading/perps-testnet)
- [Order types](https://app.testnet.dreamdex.io/docs/trading/perps-testnet/orders)
- [Link a Bot](https://app.testnet.dreamdex.io/docs/trading/common/link-a-bot)
- [Perps Arena](https://app.testnet.dreamdex.io/competition)
- [Bounty page](https://dorahacks.io/hackathon/dreamdex-perps-bounty/detail)

## Development

Node.js 20 or later.

```bash
npm ci
npm test
npm run typecheck
npm run preflight
```

The preflight is read-only and does not need a private key. Network diagnostics may need public RPC/WebSocket access.

## Bounty tracks

- **Feedback:** one Markdown file under `feedback/` per independently reproduced issue, with severity, steps, expected/actual results, evidence, and environment. Do not put security vulnerabilities in the public repository; report those privately to security@dreamdex.io.
- **MVP:** a usable perps product that places real transactions on the **testnet**, with transaction hashes and a reproducible demo. The README must later include links to 2–3 X posts mentioning `@DreamDEXSomnia`.
