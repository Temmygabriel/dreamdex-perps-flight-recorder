# Network and funds — read this before spending money

Written against the dreamDEX bounty brief supplied on 20 October 2026 and the current official documentation. Re-check the links before any live transaction because networks and rules may change.

## The bounty needs testnet orders now

The MVP requirement in the bounty brief is for real orders on **Somnia Tokyo / Hideki testnet**, chain ID `50383`. "Real orders" means real testnet transactions, not real-money mainnet trades. The paper USDso and STT used there have no monetary value.

Official developer docs:
- Network: https://app.testnet.dreamdex.io/docs/developers/perps-testnet
- Perps trading: https://app.testnet.dreamdex.io/docs/trading/perps-testnet
- Perps Arena: https://app.testnet.dreamdex.io/competition

## The free testnet allocation

The bounty description says Perps Arena paper USDso is distributed weekly. The current perps developer guide describes the 1,000 paper USDso voucher and says an address is eligible to claim it once while it has no open perps positions or orders. Follow the amount and status shown in the app for your account; this is fake trading collateral, not real money.

For gas, the current Hideki developer guide tells builders to sign in to dreamDEX, link the bot key, and leave **Send it … for gas** enabled, or use **Bots → Top up** to send STT. The current Hideki perps developer guide does not promise a fixed 20 STT weekly gas grant, so do not budget around that number. It reports roughly 0.0003–0.003 STT used by each transaction to a perp pool, though actual usage can vary. One pending take-profit or stop-loss holds 0.15 STT temporarily; our smoke test avoids placing stop orders.

**Budget for current testnet development: $0 expected.** Try the app's testnet gas route first. Do not buy testnet tokens.

## Do not confuse Perps Arena rewards with the Builder Bounty

The separate Perps Arena trading competition requires participants to hold at least 10 SOMI on Somnia mainnet continuously from registration until that competition's rewards are paid if they want to receive Perps Arena rewards. This is an anti-sybil eligibility rule. It is **not stated as a condition to submit the dreamDEX Perps Builder Bounty MVP**.

As a market snapshot on 20 October 2026, public trackers quoted SOMI at about $0.186 per token and CoinGecko showed about ₦247.40 per SOMI. That makes 10 SOMI approximately $1.86 / ₦2,474 before exchange, spread, withdrawal, or network fees. The amount can change. Do not buy it just to build this bounty MVP.

## The later $200 payment condition

The bounty brief says an MVP winner receives $300 when winners are announced and the remaining $200 after perps mainnet launches, if the MVP places orders on mainnet within 30 days of launch. The live developer docs currently state that perps are testnet-only and mainnet perps are not yet available.

So:
- We do **not** need mainnet money to build or submit now.
- The $200 later payment is conditional; it is not guaranteed by simply winning.
- We cannot calculate a reliable future mainnet budget until dreamDEX publishes mainnet markets, minimum order sizes, collateral rules and gas requirements. We should decide then rather than spend money early.

## Safety rules for this repository

1. Never use a main wallet's private key.
2. Never paste a private key into a chat, issue, commit, README or log.
3. Use a dedicated testnet bot key and the smallest possible test position.
4. Keep live writes behind a manual, explicit action. CI tests are read-only and do not require secrets.
5. The app must show a final order summary and require a deliberate confirmation before any transaction is sent.
