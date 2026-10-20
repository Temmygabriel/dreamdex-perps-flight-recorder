import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { formatUnits, parseUnits } from "viem";

type Req = { method?: string; query?: Record<string, string | string[] | undefined> };
type Res = {
  status: (code: number) => Res;
  setHeader: (name: string, value: string) => void;
  json: (body: unknown) => void;
};

const INDEXER_URL = process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function down(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new Error("The market reported an invalid tick size.");
  return (value / step) * step;
}
function up(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new Error("The market reported an invalid tick size.");
  return ((value + step - 1n) / step) * step;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "Use GET to fetch the current quote." });
    return;
  }

  const symbol = one(req.query?.symbol).trim();
  if (!symbol) {
    res.status(400).json({ ok: false, error: "Select a live market first." });
    return;
  }

  const exchange = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  } as never);

  try {
    const rows = await exchange.client.listPerpMarkets();
    const row = rows.find((item: any) => (item.symbol ?? `${item.baseSymbol}-${item.quoteSymbol}`) === symbol) as any;
    if (!row) {
      res.status(404).json({ ok: false, error: `Market ${symbol} is not in the current live market list.` });
      return;
    }

    const unified = await exchange.loadMarkets();
    const sdkMarket = Object.values(unified).find((item: any) =>
      item.type === "swap" &&
      String(item.base ?? item.info?.baseSymbol ?? "").toUpperCase() === String(row.baseSymbol).toUpperCase() &&
      String(item.quote ?? item.info?.quoteSymbol ?? "USDso").toUpperCase() === String(row.quoteSymbol).toUpperCase()
    ) as any;
    if (!sdkMarket?.symbol) {
      res.status(502).json({ ok: false, error: "The SDK could not find a usable symbol for this perps market." });
      return;
    }

    const book = await exchange.fetchOrderBook(sdkMarket.symbol, 5);
    const bid = book.bids[0]?.[0];
    const ask = book.asks[0]?.[0];
    if (bid === undefined || ask === undefined || !(Number(bid) > 0) || !(Number(ask) > 0)) {
      res.status(502).json({ ok: false, error: "The live order book has no usable bid/ask. Do not place an order from a stale quote." });
      return;
    }

    const baseDecimals = Number(row.baseDecimals);
    const quoteDecimals = Number(row.quoteDecimals);
    const tickSize = BigInt(row.tickSize);
    const minQuantity = BigInt(row.minQuantity);
    const longPrice = down(parseUnits(String(bid), quoteDecimals), tickSize);
    const shortPrice = up(parseUnits(String(ask), quoteDecimals), tickSize);
    const scale = 10n ** BigInt(baseDecimals);
    const longNotional = (longPrice * minQuantity) / scale;
    const shortNotional = (shortPrice * minQuantity) / scale;

    res.status(200).json({
      ok: true,
      network: { name: "Somnia Hideki / Tokyo testnet", chainId: 50383 },
      market: {
        symbol,
        sdkSymbol: sdkMarket.symbol,
        baseSymbol: row.baseSymbol,
        quoteSymbol: row.quoteSymbol,
        baseDecimals,
        quoteDecimals,
        tickSize: formatUnits(tickSize, quoteDecimals),
        lotSize: formatUnits(BigInt(row.lotSize), baseDecimals),
        minQuantity: formatUnits(minQuantity, baseDecimals),
        bestBid: String(bid),
        bestAsk: String(ask),
        longPrice: formatUnits(longPrice, quoteDecimals),
        shortPrice: formatUnits(shortPrice, quoteDecimals),
        longMinimumNotional: formatUnits(longNotional, quoteDecimals),
        shortMinimumNotional: formatUnits(shortNotional, quoteDecimals),
      },
      note: "Quote is a snapshot. The app repeats the order-size preflight and simulates the order before asking the wallet to sign.",
      readonly: true,
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      network: { name: "Somnia Hideki / Tokyo testnet", chainId: 50383 },
    });
  } finally {
    try { await exchange.close?.(); } catch { /* Preserve the read result. */ }
  }
}
