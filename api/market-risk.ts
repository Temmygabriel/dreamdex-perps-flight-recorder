import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { formatUnits } from "viem";

type Req = { method?: string; query?: Record<string, string | string[] | undefined> };
type Res = {
  status: (code: number) => Res;
  setHeader: (name: string, value: string) => void;
  json: (body: unknown) => void;
};
type AnyRow = Record<string, any>;

const INDEXER_URL = process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}
function asBigInt(value: unknown, label: string): bigint {
  try { return typeof value === "bigint" ? value : BigInt(String(value)); }
  catch { throw new Error("Protocol returned invalid " + label + "."); }
}
function symbolFor(row: AnyRow): string {
  return String(row.symbol ?? (String(row.baseSymbol ?? "") + "-" + String(row.quoteSymbol ?? "")));
}
function bpsPercent(value: unknown): number {
  return Number(asBigInt(value, "basis-point risk parameter")) / 100;
}
function unitString(value: unknown, decimals: number, label: string): string {
  return formatUnits(asBigInt(value, label), decimals);
}

export default async function handler(req: Req, res: Res): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "Use GET for read-only market risk parameters." });
    return;
  }

  const requestedSymbol = one(req.query?.symbol).trim();
  if (!/^[A-Z0-9][A-Z0-9:_/-]{1,39}$/i.test(requestedSymbol)) {
    res.status(400).json({ ok: false, error: "Provide a market symbol from the live Perps market list." });
    return;
  }

  let exchange: any;
  try {
    exchange = new SomniaMarkets({
      chain: hidekiTestnet,
      indexerUrl: INDEXER_URL,
      wsRpcUrl: WS_RPC_URL,
      addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    } as never);

    const rows = await exchange.client.listPerpMarkets() as AnyRow[];
    const normalized = requestedSymbol.toUpperCase();
    const market = rows.find((row) =>
      symbolFor(row).toUpperCase() === normalized ||
      (String(row.baseSymbol ?? "") + "-" + String(row.quoteSymbol ?? "")).toUpperCase() === normalized
    );
    if (!market) {
      res.status(404).json({ ok: false, error: "That market was not found in the current Hideki Perps market list." });
      return;
    }
    const pool = String(market.poolAddress ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(pool)) {
      res.status(502).json({ ok: false, error: "The selected market is missing a usable pool address." });
      return;
    }

    const risk = await exchange.client.getPerpRiskParams(pool) as AnyRow;
    const health = await exchange.client.getPerpHealthSnapshot(pool) as AnyRow;
    const baseDecimals = Number(market.baseDecimals ?? 18);
    const quoteDecimals = Number(market.quoteDecimals ?? 18);
    if (!Number.isInteger(baseDecimals) || baseDecimals < 0 || baseDecimals > 36 ||
        !Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 36) {
      throw new Error("Protocol returned invalid market decimal metadata.");
    }

    const priceable = health?.priceable === true;
    const initialMarginBps = asBigInt(risk.initialMarginBps, "initial margin");
    const maintenanceMarginBps = asBigInt(risk.maintenanceMarginBps, "maintenance margin");
    const closeOutMarginBps = asBigInt(risk.closeOutMarginBps, "close-out margin");
    const healthImf = priceable && health.effectiveImfBps != null
      ? asBigInt(health.effectiveImfBps, "effective initial margin")
      : null;
    const healthMark = priceable && health.markPrice != null
      ? unitString(health.markPrice, quoteDecimals, "mark price")
      : null;
    const makerFeeBps = risk.makerFeeBpsTimes1k == null ? null : Number(asBigInt(risk.makerFeeBpsTimes1k, "maker fee")) / 1000;
    const takerFeeBps = risk.takerFeeBpsTimes1k == null ? null : Number(asBigInt(risk.takerFeeBpsTimes1k, "taker fee")) / 1000;

    res.status(200).json({
      ok: true,
      network: { name: "Somnia Hideki / dreamDEX Tokyo testnet", chainId: 50383 },
      symbol: symbolFor(market),
      baseSymbol: market.baseSymbol ?? null,
      quoteSymbol: market.quoteSymbol ?? null,
      poolAddress: pool,
      marginBank: market.marginBank ?? null,
      readAt: new Date().toISOString(),
      source: "Read-only @somnia-chain/markets-sdk protocol reads",
      readonly: true,
      riskParameters: {
        initialMarginFloorBps: initialMarginBps.toString(),
        initialMarginFloorPercent: bpsPercent(initialMarginBps),
        effectiveInitialMarginBps: healthImf == null ? null : healthImf.toString(),
        effectiveInitialMarginPercent: healthImf == null ? null : bpsPercent(healthImf),
        maintenanceMarginBps: maintenanceMarginBps.toString(),
        maintenanceMarginPercent: bpsPercent(maintenanceMarginBps),
        closeOutMarginBps: closeOutMarginBps.toString(),
        closeOutMarginPercent: bpsPercent(closeOutMarginBps),
        maxOpenInterestBase: unitString(risk.maxOpenInterest, baseDecimals, "maximum open interest"),
        maxPositionSizeBase: unitString(risk.maxPositionSize, baseDecimals, "maximum position size"),
        makerFeeBps,
        makerFeePercent: makerFeeBps == null ? null : makerFeeBps / 100,
        takerFeeBps,
        takerFeePercent: takerFeeBps == null ? null : takerFeeBps / 100,
      },
      marketHealth: {
        priceable,
        status: priceable ? "mark-available" : "stale-or-unpriceable",
        markPrice: healthMark,
        note: priceable
          ? "Protocol mark is available in the sampled health snapshot."
          : "Static risk parameters remain available, but the protocol did not mark this market priceable. Do not infer a safe price or liquidation level.",
      },
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "Live market risk data is temporarily unavailable. Retry after the Hideki RPC/indexer recovers.",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    try { await exchange?.close?.(); } catch { /* Keep the API result if socket cleanup fails. */ }
  }
}
