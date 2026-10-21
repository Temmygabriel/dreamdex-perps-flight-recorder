import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { formatUnits } from "viem";

type Req = { method?: string };
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
    res.status(405).json({ ok: false, error: "Use GET for the read-only market list." });
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
    const markets = rows.map((row: any) => ({
      symbol: row.symbol ?? `${row.baseSymbol}-${row.quoteSymbol}`,
      baseSymbol: row.baseSymbol,
      quoteSymbol: row.quoteSymbol,
      poolAddress: row.poolAddress,
      marginBank: row.marginBank,
      baseDecimals: Number(row.baseDecimals),
      quoteDecimals: Number(row.quoteDecimals),
      tickSizeRaw: String(row.tickSize),
      lotSizeRaw: String(row.lotSize),
      minQuantityRaw: String(row.minQuantity),
      tickSize: formatUnits(BigInt(row.tickSize), Number(row.quoteDecimals)),
      lotSize: formatUnits(BigInt(row.lotSize), Number(row.baseDecimals)),
      minQuantity: formatUnits(BigInt(row.minQuantity), Number(row.baseDecimals)),
    }));

    res.status(200).json({
      ok: true,
      network: { name: "Somnia Hideki / dreamDEX Tokyo testnet", chainId: 50383 },
      sdkVersion: "0.32.1",
      count: markets.length,
      markets,
      source: "Live listPerpMarkets() read through @somnia-chain/markets-sdk",
      readonly: true,
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "Market data is temporarily unavailable. Please retry shortly.",
      errorType: error instanceof Error ? error.name : "UnknownError",
      network: { name: "Somnia Hideki / dreamDEX Tokyo testnet", chainId: 50383 },
    });
  } finally {
    try { await exchange.close?.(); } catch { /* Keep the read result if socket cleanup fails. */ }
  }
}
