import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, http } from "viem";

const RPC_URL = "https://api.hideki2.infra.testnet.somnia.network";
const INDEXER_URL = process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";
const EXPECTED = {
  collateral: "0xed7993a74dae1e6656b704a424dcd8711aaf4f72",
  factory: "0xe631faee547baee07353e290f0562ea67d856560",
  liquidationEngine: "0xa66d3c24ad4a389d863846905d8173e1017e9f4d",
  insuranceFund: "0x50826894d47c6d4f3bea38bfdc7dc5c5be171b80",
};
const norm = (value: unknown) => typeof value === "string" ? value.toLowerCase() : "";
function address(value: unknown, label: string): string {
  const result = norm(value);
  if (!/^0x[0-9a-f]{40}$/.test(result)) throw new Error("Protocol config did not expose a valid " + label + " address.");
  return result;
}
async function main() {
  const publicClient = createPublicClient({ chain: hidekiTestnet, transport: http(RPC_URL, { timeout: 20_000 }) });
  const chainId = await publicClient.getChainId();
  if (chainId !== 50383) throw new Error("Expected Hideki chain 50383, got " + chainId);
  const exchange = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: INDEXER_URL, wsRpcUrl: WS_RPC_URL, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES } as never);
  try {
    const rows = await exchange.client.listPerpMarkets() as Array<Record<string, unknown>>;
    if (!rows.length) throw new Error("No Perps markets were returned.");
    const marginBanks = [...new Set(rows.map((row) => address(row.marginBank, "market MarginBank")))];
    const checks: Array<Record<string, unknown>> = [];
    for (const marginBank of marginBanks) {
      const config = await exchange.client.getPerpSystemConfig(marginBank as `0x${string}`) as unknown as Record<string, unknown>;
      if (config.fullyWired !== true) throw new Error("Live MarginBank reports fullyWired !== true.");
      if (!Number.isFinite(Number(config.maxLeverageLimit)) || Number(config.maxLeverageLimit) <= 0) throw new Error("Live MarginBank exposes no valid maximum leverage limit.");
      console.log("MarginBank config fields for " + marginBank + ": " + Object.keys(config ?? {}).join(", "));
      console.log("Live public config addresses: " + JSON.stringify({ collateralToken: config.collateralToken, perpPoolFactory: config.perpPoolFactory, liquidationEngine: config.liquidationEngine, insuranceFund: config.insuranceFund, fullyWired: config.fullyWired }));
      const marketForBank = rows.find((row) => norm(row.marginBank) === marginBank);
      const actual = {
        collateral: address(config.collateral ?? config.collateralToken ?? config.collateralAddress ?? marketForBank?.quoteToken, "collateral"),
        factory: address(config.factory ?? config.perpPoolFactory, "PerpPoolFactory"),
        liquidationEngine: address(config.liquidationEngine, "LiquidationEngine"),
        insuranceFund: address(config.insuranceFund, "InsuranceFund"),
      };
      const mismatches = Object.keys(EXPECTED).filter((key) => actual[key as keyof typeof actual] !== EXPECTED[key as keyof typeof EXPECTED]);
      checks.push({ marginBank, actual, expected: EXPECTED, passed: mismatches.length === 0, mismatches });
      if (mismatches.length) throw new Error("Live MarginBank system configuration differs from published Hideki addresses: " + mismatches.join(", "));
    }
    const btc = rows.find((row) => String(row.baseSymbol ?? "").toUpperCase() === "BTC");
    if (!btc) throw new Error("BTC Perps market is absent from the live market list.");
    console.log(JSON.stringify({
      test: "read-only protocol deployment/reference check",
      status: "PASS",
      network: "Somnia Hideki testnet",
      chainId,
      marketsRead: rows.length,
      btcMarket: {
        symbol: btc.symbol ?? null,
        marginBank: btc.marginBank,
        poolAddress: btc.poolAddress ?? null,
        quoteToken: btc.quoteToken ?? null,
        exposedRiskFields: Object.fromEntries(Object.entries(btc).filter(([key]) => /margin|leverage|liquid|funding|risk/i.test(key))),
      },
      systemConfigChecks: checks,
      limitation: "Confirms chain and deployed system wiring against published addresses; does not prove internal LiquidationEngine execution semantics or account-specific liquidation outcomes.",
    }, null, 2));
  } finally {
    try { await exchange.close?.(); } catch { /* preserve read-only evidence */ }
  }
}
main().catch((error: unknown) => {
  console.error("PROTOCOL REFERENCE CHECK FAILED:", error instanceof Error ? error.message : "Unknown failure");
  process.exitCode = 1;
});
