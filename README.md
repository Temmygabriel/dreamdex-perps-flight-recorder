# Perps Flight Recorder

**A testnet-first order checker and evidence recorder for dreamDEX perpetual futures.**

Perps Flight Recorder helps a trader or builder see whether a proposed order follows the live market's rules, then preserves proof of what happened during a real testnet order attempt.

It is built for the dreamDEX Perps Builder Bounty on Somnia Tokyo/Hideki testnet (chain ID `50383`).

## What it does

1. **Reads live markets.** Shows markets and the correct price tick, size step, minimum size and decimal precision returned by dreamDEX's SDK.
2. **Checks an intended order.** Checks the price and quantity against market rules, then calls the SDK's live order-size preflight for the chosen account.
3. **Explains a block.** Makes an invalid price/size, stale mark or account-size limit visible before the user attempts a trade.
4. **Records evidence.** The web app connects to a browser wallet, asks for a separate confirmation before sending a post-only testnet order, reads back the order state, lets the user cancel it, and downloads the transaction hashes and read-back result as a JSON receipt.

A preflight pass does **not** guarantee a transaction will later succeed. Market prices, order-book depth and account state can change.

## Current status

- [x] Public repository and first UI/API implementation committed.
- [x] TypeScript check and deterministic tick/lot/minimum-size tests pass in GitHub Actions.
- [x] Read-only SDK connection reached Hideki testnet and returned 21 live perps markets (20 October 2026).
- [x] Read-only order-size response checked on-chain using a dummy account; no private key was used.
- [x] Wallet-connected trading flow added: browser wallet signing only, latest preflight before sending, post-only order, cancellation and read-back receipt.
- [x] Production Vite build passes in GitHub Actions.
- [x] Read-only market-minimum audit confirms BTC, ETH, XRP and SOL minimum orders fit within a 20 paper-USDso test budget at the time of the check.
- [ ] Complete a real testnet order/cancel/read-back run using the user's connected wallet.
- [ ] Deploy and check the public Vercel app.
- [ ] Publish 2–3 X posts tagging `@DreamDEXSomnia`, then add their links here before bounty submission.

No live order has yet been verified by this repository's evidence receipt. Do not describe that step as finished until its GitHub Actions run produces a verified receipt.

## Network and cost

- **Required for the MVP submission now:** Somnia Tokyo/Hideki testnet, chain ID `50383`.
- **Not required now:** mainnet funds. Mainnet perps are not currently available in the developer docs, and the MVP bounty asks for orders on testnet.
- **Free testnet allocation:** the official Perps Arena page currently describes 1,000 paper USDso and 20 STT per week for an eligible test wallet.
- **Testnet gas:** the developer docs report observed perps-pool transaction fees of roughly 0.0003–0.003 STT each. Actual fees may vary.
- **Later $200 payment condition:** if this MVP wins, the remaining $200 depends on placing orders on mainnet within 30 days after dreamDEX launches perps there. The mainnet conditions and required budget cannot be calculated reliably until that launch happens.

The separate Perps Arena trading competition has a 10-SOMI mainnet holding rule for its own reward eligibility. That is not stated as a requirement for submitting this Builder Bounty MVP. Do not purchase SOMI just to start the testnet build.

More details: [docs/NETWORK_AND_FUNDS.md](docs/NETWORK_AND_FUNDS.md).

## Run the checks

Requires Node.js 22 or later (or Node.js 20.19+).

```bash
npm install
npm run typecheck
npm test
npm run build
npm run preflight
```

`npm run preflight` is read-only. It connects to testnet market data without a private key and sends no transaction.

## GitHub Actions

The `CI` workflow runs TypeScript checks and the deterministic tests on pushes and pull requests. Its read-only testnet job does not need wallet secrets.

The `Live testnet smoke` workflow is an optional developer fallback. The main MVP flow uses the browser wallet directly and does not need a private-key secret. If using the fallback, it asks you to select `YES` before it can send anything.

Only for the optional GitHub Actions fallback, the repository needs these **Actions secrets** (not Variables):

- `TESTNET_BOT_PRIVATE_KEY`: private key of a *new, dedicated testnet bot wallet* that has been linked for Perps on the dreamDEX testnet app.
- `TESTNET_OWNER_ADDRESS`: public address of the DreamDEX testnet account the bot is authorised to trade for.

The bot private key must not be the key for your regular wallet. Never store it in the repository, Vercel environment variables, source code, an issue, or a chat. The bot key should be linked using the app's **Link a bot** flow; it can place/cancel/reduce orders for the owner but cannot withdraw from the owner's account.

### Run the manual smoke test

1. Open the Actions tab of this repository and select **Live testnet smoke**.
2. Choose the market and side, keep the notional at `20` paper USDso or less, and leave confirmation as `NO` until the owner/key setup has been verified.
3. Only after checking the correct testnet bot key and account, select `YES` and run the workflow.
4. Open the run's **Artifacts** section and download `perps-flight-recorder-live-testnet-receipt`.
5. The result is only verified if its receipt says the resting order was visible after placement and absent after cancellation. If a cancellation fails, inspect the testnet account's open orders before trying again.

## Deploy the web app on Vercel

No private key is needed in Vercel. The browser uses your connected wallet to sign transactions, and the serverless endpoints only read markets, preflight rules and open orders.

1. Open [Vercel's New Project page](https://vercel.com/new/import) and import `Temmygabriel/dreamdex-perps-flight-recorder`.
2. Select **Vite** as the framework preset and use the repository root as the project root.
3. Keep the repository's `vercel.json`. It runs `npm run build`, publishes `dist`, and leaves the `api/` functions available.
4. Deploy, then open the site and test `/api/markets`. It should report chain `50383` and the live market count. Test `/api/preflight` with a public wallet address. The order page will ask your browser wallet to switch to chain `50383`.
5. Connect Rabby or another EVM wallet on the site, run preflight, and only then press **Place post-only testnet order**. Review the price and size, approve in the wallet pop-up, then cancel the resting order and download the JSON evidence receipt.
6. Each commit to `main` should trigger a new deployment after GitHub integration is connected.

**Do not add wallet private keys to Vercel or paste them into chat.** The browser does not need a private-key secret.

## Bounty feedback track

Each accepted feedback issue must be reproducible, relevant and not already reported by another builder. Put each issue in its own Markdown file under `feedback/`, using the template described in [feedback/README.md](feedback/README.md). Do not publish security vulnerabilities here; report those privately to `security@dreamdex.io`.

The initial SDK/type-checking failure encountered while developing this repository was caused by our code not narrowing the SDK's documented discriminated result correctly. A read-only runtime check confirmed the SDK returned `priceable`, `placeable`, `maxQuantity`, and `limitedBy` as expected. **We are not treating that as a dreamDEX bug.**

## Official links

- [Perps developer guide](https://app.testnet.dreamdex.io/docs/developers/perps-testnet)
- [Perps trading guide](https://app.testnet.dreamdex.io/docs/trading/perps-testnet)
- [Link a Bot](https://app.testnet.dreamdex.io/docs/trading/common/link-a-bot)
- [Perps Arena](https://app.testnet.dreamdex.io/competition)
- [dreamDEX bot kit](https://github.com/somnia-chain/dreamdex-bot-kit)
- [Builder Bounty page](https://dorahacks.io/hackathon/dreamdex-perps-bounty/detail)

## X posts for the bounty submission

Add 2–3 real post links that describe the product, show the build or evidence, and tag `@DreamDEXSomnia`. Do not submit until the links are added here.

- Post 1: pending
- Post 2: pending
- Post 3: pending
