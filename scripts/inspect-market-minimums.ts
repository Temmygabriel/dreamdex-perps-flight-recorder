import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { formatUnits } from "viem";

const INDEXER_URL = process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";

async function main(): Promise<void> {
  const exchange = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  } as never);

  try {
    const perpRows = await exchange.client.listPerpMarkets() as any[];
    const unifiedMarkets = await exchange.loadMarkets();
    const results: Record<string, unknown>[] = [];

    for (const row of perpRows) {
      const base = String(row.baseSymbol ?? "").toUpperCase();
      const quote = String(row.quoteSymbol ?? "").toUpperCase();
      const sdkMarket = Object.values(unifiedMarkets).find((item: any) =>
        item.type === "swap" &&
        String(item.base ?? item.info?.baseSymbol ?? "").toUpperCase() === base &&
        (!quote || String(item.quote ?? item.info?.quoteSymbol ?? "").toUpperCase() === quote)
      ) as any;

      const baseDecimals = Number(row.baseDecimals);
      const quoteDecimals = Number(row.quoteDecimals);
      const minimumRaw = BigInt(row.minQuantity);
      const minimumSize = Number(formatUnits(minimumRaw, baseDecimals));
      const result: Record<string, unknown> = {
        baseSymbol: base,
        quoteSymbol: quote,
        sdkSymbol: sdkMarket?.symbol ?? null,
        baseDecimals,
        quoteDecimals,
        tickSize: formatUnits(BigInt(row.tickSize), quoteDecimals),
        lotSize: formatUnits(BigInt(row.lotSize), baseDecimals),
        minQuantity: formatUnits(minimumRaw, baseDecimals),
        bookAvailable: false,
        minimumNotionalEstimate: null,
        suitableForTwentyPaperUsdso: false,
      };

      if (sdkMarket?.symbol) {
        try {
          const book = await exchange.fetchOrderBook(sdkMarket.symbol, 1);
          const bid = book.bids[0]?.[0];
          const ask = book.asks[0]?.[0];
          if (bid !== undefined && ask !== undefined && Number(bid) > 0 && Number(ask) > 0) {
            const mid = (Number(bid) + Number(ask)) / 2;
            const minimumNotionalEstimate = minimumSize * mid;
            result.bookAvailable = true;
            result.bestBid = bid;
            result.bestAsk = ask;
            result.midEstimate = mid;
            result.minimumNotionalEstimate = minimumNotionalEstimate;
            result.suitableForTwentyPaperUsdso = minimumNotionalEstimate <= 20;
          }
        } catch (error) {
          result.bookError = error instanceof Error ? error.message : String(error);
        }
      }
      results.push(result);
    }

    results.sort((a, b) => {
      const an = typeof a.minimumNotionalEstimate === "number" ? a.minimumNotionalEstimate : Number.POSITIVE_INFINITY;
      const bn = typeof b.minimumNotionalEstimate === "number" ? b.minimumNotionalEstimate : Number.POSITIVE_INFINITY;
      return an - bn;
    });

    console.log("READ-ONLY MARKET MINIMUM AUDIT — no key loaded, no transaction submitted");
    console.log("Network: Somnia Hideki / Tokyo testnet, chain 50383");
    console.log(JSON.stringify(results, null, 2));
  } finally {
    try { await exchange.close?.(); } catch { /* Preserve diagnostic result. */ }
  }
}

main().catch((error: unknown) => {
  console.error("Market minimum inspection failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
