import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { isAddress } from "viem";

type Req = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
};
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
    res.status(405).json({ ok: false, error: "Use GET for open-order read-back." });
    return;
  }

  const account = one(req.query?.accountAddress).trim();
  const baseSymbol = one(req.query?.baseSymbol).trim().toUpperCase();
  if (!isAddress(account) || !baseSymbol) {
    res.status(400).json({ ok: false, error: "A public account address and market base symbol are required." });
    return;
  }

  const exchange = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    account: account as `0x${string}`,
  } as never);

  try {
    const unified = await exchange.loadMarkets();
    const market = Object.values(unified).find((row: any) =>
      row.type === "swap" &&
      String(row.base ?? row.info?.baseSymbol ?? "").toUpperCase() === baseSymbol &&
      String(row.quote ?? row.info?.quoteSymbol ?? "USDso").toUpperCase() === "USDSO"
    ) as any;

    if (!market?.symbol) {
      res.status(404).json({
        ok: false,
        error: `No active USDso perps market found for ${baseSymbol}.`,
        network: { chainId: 50383 },
      });
      return;
    }

    const rows = await exchange.fetchOpenOrders(market.symbol);
    const orders = rows.map((row: any) => ({
      id: String(row.id),
      symbol: String(row.symbol ?? market.symbol),
      side: String(row.side ?? ""),
      type: String(row.type ?? ""),
      price: row.price == null ? null : String(row.price),
      amount: row.amount == null ? null : String(row.amount),
      remaining: row.remaining == null ? null : String(row.remaining),
      status: String(row.status ?? "open"),
      timestamp: row.timestamp == null ? null : Number(row.timestamp),
    }));

    res.status(200).json({
      ok: true,
      network: { name: "Somnia Hideki / Tokyo testnet", chainId: 50383 },
      account,
      baseSymbol,
      sdkSymbol: market.symbol,
      count: orders.length,
      orders,
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
