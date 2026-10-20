import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { parseUnits } from "viem";

const INDEXER_URL = process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";
const READ_ONLY_ACCOUNT = "0x0000000000000000000000000000000000000001" as const;

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

async function main(): Promise<void> {
  const exchange = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  } as never);

  try {
    const markets = await exchange.client.listPerpMarkets();
    const market = markets.find((row: any) => String(row.baseSymbol).toUpperCase() === "BTC") as any;
    if (!market) throw new Error("BTC market not found; cannot safely inspect result shape.");

    // This is a read-only call using a dummy account address. No wallet/key is
    // loaded, and the code does not submit or simulate an order transaction.
    const result = await exchange.client.getMaxPerpOrderSize({
      pool: market.poolAddress,
      marginBank: market.marginBank,
      account: READ_ONLY_ACCOUNT,
      isBid: true,
      price: parseUnits("100000", Number(market.quoteDecimals)),
      autoPull: false,
    });

    const keys = Object.keys(result as object).sort();
    console.log("SDK version: 0.32.1");
    console.log("Network chain ID: 50383");
    console.log("Method: client.getMaxPerpOrderSize");
    console.log("Account: deliberately unused dummy address");
    console.log("Result own keys:");
    console.log(json(keys));
    console.log("Complete result:");
    console.log(json(result));
    console.log("Field presence:", json({
      priceable: "priceable" in (result as object),
      placeable: "placeable" in (result as object),
      maxQuantity: "maxQuantity" in (result as object),
      limitedBy: "limitedBy" in (result as object),
    }));
  } finally {
    try { await exchange.close?.(); } catch { /* Read only; preserve result. */ }
  }
}

main().catch((error: unknown) => {
  console.error("READ-ONLY SDK RESULT INSPECTION FAILED:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
