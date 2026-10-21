import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";

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

export default async function handler(req: Req, res: Res): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "Use GET to read a public order-book midpoint." });
    return;
  }

  const symbol = one(req.query?.symbol).trim();
  if (!/^[A-Z0-9]{2,15}-[A-Z0-9]{2,15}$/i.test(symbol)) {
    res.status(400).json({ ok: false, error: "Provide a valid market symbol, such as BTC-USDso." });
    return;
  }

  const exchange = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  } as never);

  try {
    const rows = await exchange.client.listPerpMarkets() as any[];
    const row = rows.find((item) => String(item.symbol ?? `${item.baseSymbol}-${item.quoteSymbol}`).toUpperCase() === symbol.toUpperCase());
    if (!row) {
      res.status(404).json({ ok: false, error: "That market is not listed by the Hideki Perps SDK." });
      return;
    }

    const sdkMarkets = await exchange.loadMarkets();
    const sdkMarket = Object.values(sdkMarkets).find((item: any) =>
      item.type === "swap" &&
      String(item.base ?? item.info?.baseSymbol ?? "").toUpperCase() === String(row.baseSymbol).toUpperCase() &&
      String(item.quote ?? item.info?.quoteSymbol ?? "").toUpperCase() === String(row.quoteSymbol).toUpperCase()
    ) as any;
    if (!sdkMarket?.symbol) {
      res.status(502).json({ ok: false, error: "The SDK did not resolve this market to a readable order book." });
      return;
    }

    const book = await exchange.fetchOrderBook(sdkMarket.symbol, 1);
    const bid = Number(book.bids?.[0]?.[0]);
    const ask = Number(book.asks?.[0]?.[0]);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
      res.status(502).json({ ok: false, error: "The order book did not return a valid two-sided quote." });
      return;
    }
    const midpoint = (bid + ask) / 2;
    res.status(200).json({
      ok: true,
      network: { name: "Somnia Hideki / dreamDEX Tokyo testnet", chainId: 50383 },
      symbol,
      bestBid: bid,
      bestAsk: ask,
      referencePrice: midpoint,
      spreadBps: ((ask - bid) / midpoint) * 10_000,
      priceSource: "Top-of-book bid/ask midpoint; not the protocol mark price.",
      timestamp: new Date().toISOString(),
      readonly: true,
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "Order-book data is temporarily unavailable. Please retry shortly.",
      errorType: error instanceof Error ? error.name : "UnknownError",
      network: { name: "Somnia Hideki / dreamDEX Tokyo testnet", chainId: 50383 },
    });
  } finally {
    try { await exchange.close?.(); } catch { /* Preserve the diagnostic result. */ }
  }
}
