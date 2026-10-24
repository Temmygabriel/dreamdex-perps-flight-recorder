import { mkdirSync, writeFileSync } from "node:fs";
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, formatEther, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = "https://api.hideki2.infra.testnet.somnia.network";
const INDEXER_URL = process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";

function clean(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "unknown read failure";
}

async function main(): Promise<void> {
  if (process.env.CONFIRM_READ_ONLY_LIQUIDATION_AUDIT !== "YES") {
    throw new Error("Safety stop: set CONFIRM_READ_ONLY_LIQUIDATION_AUDIT=YES to run read-only checks.");
  }
  const rawKey = process.env.WALLET_KEY?.trim();
  if (!rawKey) throw new Error("Missing Actions secret wallet_key; key material will not be printed.");
  const privateKey = (rawKey.startsWith("0x") ? rawKey : "0x" + rawKey) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("wallet_key must be a 32-byte EVM private key; key material will not be printed.");

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: hidekiTestnet, transport: http(RPC_URL, { timeout: 20_000 }) });
  // Private key only supplies the wallet identity for SDK account reads. This script has no write calls.
  const exchange: any = new SomniaMarkets({
    chain: hidekiTestnet, indexerUrl: INDEXER_URL, wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, privateKey,
  } as never);
  const report: Record<string, any> = {
    test: "read-only live liquidation observability audit",
    recordedAt: new Date().toISOString(),
    network: { name: "Somnia Hideki testnet", expectedChainId: 50383 },
    transactionSubmitted: false,
    accountStateChanged: false,
    privateKeyPrintedOrStored: false,
    sourceVerificationClaimed: false,
    limitations: [
      "This is a read-only snapshot; it does not execute liquidation or prove the engine's internal execution semantics.",
      "SDK getLiquidationPrice is an estimate for a pool's move under cross-margin health assumptions, not a guarantee of the order-book liquidation outcome.",
      "Indexer liquidation history can lag the chain and is not a same-block proof of current account state.",
    ],
  };
  mkdirSync("artifacts", { recursive: true });
  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== 50383) throw new Error("Wrong RPC chain ID: expected 50383, got " + chainId);
    const nativeBalance = await publicClient.getBalance({ address: account.address });
    const markets = await exchange.client.listPerpMarkets() as Array<Record<string, any>>;
    if (!markets.length) throw new Error("Live SDK returned no Perps markets.");
    const btc = markets.find((m) => String(m.baseSymbol ?? "").toUpperCase() === "BTC");
    if (!btc) throw new Error("BTC Perps market missing from live SDK response.");
    const marginBank = String(btc.marginBank).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(marginBank)) throw new Error("BTC market has no valid MarginBank address.");
    const systemConfig = await exchange.client.getPerpSystemConfig(marginBank as `0x${string}`);
    const [margin, health, positions, accountLiquidations, venueLiquidations, engineConfig, insuranceState] = await Promise.all([
      exchange.client.getMarginAccount(marginBank as `0x${string}`, account.address),
      exchange.client.getAccountHealth(marginBank as `0x${string}`, account.address),
      exchange.client.listPerpPositionAnalytics({ marginBank: marginBank as `0x${string}`, account: account.address }),
      exchange.client.listLiquidations({ account: account.address, limit: 100 }),
      exchange.client.listLiquidations({ limit: 100 }),
      exchange.client.getLiquidationEngineConfig(systemConfig.liquidationEngine),
      exchange.client.getInsuranceFundState(systemConfig.insuranceFund),
    ]);

    const positionLiquidationPrices: Array<Record<string, unknown>> = [];
    for (const position of positions as Array<Record<string, any>>) {
      const pool = String(position.pool ?? position.poolAddress ?? position.perpPool ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(pool)) {
        positionLiquidationPrices.push({ position: clean(position), estimate: null, readError: "Position row omitted a recognizable pool address." });
        continue;
      }
      try {
        const estimate = await exchange.client.getLiquidationPrice({
          pool: pool as `0x${string}`,
          marginBank: marginBank as `0x${string}`,
          account: account.address,
        });
        positionLiquidationPrices.push({ pool, estimateRawQuotePerBase: estimate === null ? null : String(estimate), readError: null });
      } catch (error) {
        positionLiquidationPrices.push({ pool, estimate: null, readError: safeError(error) });
      }
    }

    report.chainId = chainId;
    report.account = account.address;
    report.nativeBalanceSTT = formatEther(nativeBalance);
    report.marketCount = markets.length;
    report.btcMarket = {
      symbol: btc.symbol ?? null,
      poolAddress: btc.poolAddress ?? null,
      marginBank,
      quoteToken: btc.quoteToken ?? null,
      baseDecimals: btc.baseDecimals ?? null,
      quoteDecimals: btc.quoteDecimals ?? null,
    };
    report.systemConfig = clean(systemConfig);
    report.accountSnapshot = {
      margin: clean(margin),
      health: clean(health),
      activePositionCount: Array.isArray(positions) ? positions.length : null,
      positions: clean(positions),
      positionLiquidationPrices,
    };
    report.liquidationEngine = {
      proxyAddress: systemConfig.liquidationEngine,
      config: clean(engineConfig),
      accountLiquidationEventCount: Array.isArray(accountLiquidations) ? accountLiquidations.length : null,
      accountLiquidationEvents: clean(accountLiquidations),
      latestVenueEventCount: Array.isArray(venueLiquidations) ? venueLiquidations.length : null,
      latestVenueLiquidationEvents: clean(venueLiquidations),
    };
    report.insuranceFund = { address: systemConfig.insuranceFund, state: clean(insuranceState) };
    report.verdict = {
      chainCorrect: chainId === 50383,
      accountHealthReadSucceeded: Boolean(health),
      marginReadSucceeded: Boolean(margin),
      engineConfigReadSucceeded: Boolean(engineConfig),
      insuranceStateReadSucceeded: Boolean(insuranceState),
      activePositionCount: Array.isArray(positions) ? positions.length : null,
      accountHasIndexedLiquidationHistory: Array.isArray(accountLiquidations) && accountLiquidations.length > 0,
      venueHasRecentIndexedLiquidationHistory: Array.isArray(venueLiquidations) && venueLiquidations.length > 0,
      liveLiquidationAttempted: false,
      liveLiquidationAuthorized: false,
    };
    const output = JSON.stringify(report, null, 2) + "\n";
    writeFileSync("artifacts/liquidation-observability-audit.json", output, { mode: 0o600 });
    console.log(output);
  } finally {
    try { await exchange.close?.(); } catch { /* preserve report */ }
  }
}

main().catch((error: unknown) => {
  console.error("READ-ONLY LIQUIDATION OBSERVABILITY AUDIT FAILED:", safeError(error));
  process.exitCode = 1;
});
