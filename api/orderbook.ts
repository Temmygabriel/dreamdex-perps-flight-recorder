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

export default async function handler(req: Req, res: Res): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "Use GET to read the live order book." });
    return;
  }
  const baseSymbol = String(req.query?.baseSymbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,15}$/.test(baseSymbol)) {
    res.status(400).json({ ok: false, error: "Provide a valid market base symbol, such as BTC." });
    return;
  }

  const exchange = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  } as never);

  try {
    const perps = await exchange.client.listPerpMarkets() as any[];
    const row = perps.find((item) => String(item.baseSymbol).toUpperCase() === baseSymbol);
    if (!row) {
      res.status(404).json({ ok: false, error: `No live perps market found for ${baseSymbol}.` });
      return;
    }
    const unified = await exchange.loadMarkets();
    const market = Object.values(unified).find((item: any) =>
      item.type === "swap" &&
      String(item.base ?? item.info?.baseSymbol ?? "").toUpperCase() === baseSymbol &&
      String(item.quote ?? item.info?.quoteSymbol ?? "").toUpperCase() === String(row.quoteSymbol).toUpperCase()
    ) as any;
    if (!market?.symbol) {
      res.status(502).json({ ok: false, error: `SDK did not expose an active swap symbol for ${baseSymbol}.` });
      return;
    }
    const book = await exchange.fetchOrderBook(market.symbol, 5);
    const bids = (book.bids ?? []).slice(0, 5).map((row: any) => ({ price: String(row[0]), quantity: String(row[1]) }));
    const asks = (book.asks ?? []).slice(0, 5).map((row: any) => ({ price: String(row[0]), quantity: String(row[1]) }));
    res.status(200).json({
      ok: true,
      network: { name: "Somnia Hideki / Tokyo testnet", chainId: 50383 },
      baseSymbol,
      symbol: market.symbol,
      bestBid: bids[0]?.price ?? null,
      bestAsk: asks[0]?.price ?? null,
      bids,
      asks,
      checkedAt: new Date().toISOString(),
      readonly: true,
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      network: { name: "Somnia Hideki / Tokyo testnet", chainId: 50383 },
    });
  } finally {
    try { await exchange.close?.(); } catch { /* Preserve order book result. */ }
  }
}
