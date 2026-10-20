import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { formatUnits, isAddress, parseUnits } from "viem";
import { validateOrderGeometry } from "../src/order-rules.js";

type Req = { method?: string; body?: unknown };
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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, error: "Use POST to check a proposed order." });
    return;
  }

  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const account = String(body.accountAddress ?? "").trim();
  const symbol = String(body.symbol ?? "").trim();
  const side = String(body.side ?? "").trim().toLowerCase();
  const priceText = String(body.price ?? "").trim();
  const quantityText = String(body.quantity ?? "").trim();

  if (!isAddress(account)) {
    res.status(400).json({ ok: false, stage: "input", error: "Enter a valid public wallet/account address." });
    return;
  }
  if (!symbol || (side !== "long" && side !== "short") || !priceText || !quantityText) {
    res.status(400).json({ ok: false, stage: "input", error: "Select a market and side, then enter a limit price and quantity." });
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
    const rows = await exchange.client.listPerpMarkets();
    const market = rows.find((row: any) => (row.symbol ?? `${row.baseSymbol}-${row.quoteSymbol}`) === symbol) as any;
    if (!market) {
      res.status(404).json({ ok: false, stage: "market", error: `Market ${symbol} is not in the current live market list.` });
      return;
    }

    const baseDecimals = Number(market.baseDecimals);
    const quoteDecimals = Number(market.quoteDecimals);
    let price: bigint;
    let quantity: bigint;
    try {
      price = parseUnits(priceText, quoteDecimals);
      quantity = parseUnits(quantityText, baseDecimals);
    } catch {
      res.status(400).json({
        ok: false,
        stage: "input",
        error: `Price allows up to ${quoteDecimals} decimals and quantity allows up to ${baseDecimals} decimals for this market.`,
      });
      return;
    }

    const geometry = validateOrderGeometry({
      price,
      tickSize: BigInt(market.tickSize),
      quantity,
      lotSize: BigInt(market.lotSize),
      minQuantity: BigInt(market.minQuantity),
    });

    if (geometry.length > 0) {
      res.status(200).json({
        ok: true,
        pass: false,
        stage: "local-rules",
        result: "BLOCKED",
        explanation: "The proposed price or quantity does not follow this market's rules. Nothing was sent.",
        failures: geometry,
        market: {
          symbol,
          baseDecimals,
          quoteDecimals,
          tickSize: formatUnits(BigInt(market.tickSize), quoteDecimals),
          lotSize: formatUnits(BigInt(market.lotSize), baseDecimals),
          minQuantity: formatUnits(BigInt(market.minQuantity), baseDecimals),
        },
        transactionSent: false,
      });
      return;
    }

    const max = await exchange.client.getMaxPerpOrderSize({
      pool: market.poolAddress,
      marginBank: market.marginBank,
      account: account as `0x${string}`,
      isBid: side === "long",
      price,
      autoPull: true,
    });

    // PerpMaxOrderSize is a discriminated union. When priceable is false the
    // SDK deliberately omits placeable/maxQuantity/limitedBy, so return before
    // trying to read those fields.
    if (!max.priceable) {
      res.status(200).json({
        ok: true,
        pass: false,
        stage: "live-sdk-preflight",
        result: "BLOCKED",
        explanation: "The live mark is stale or unavailable, so the SDK cannot safely size this order.",
        failures: [{ code: "STALE_OR_MISSING_MARK", message: "No live price is available for sizing." }],
        market: {
          symbol,
          poolAddress: market.poolAddress,
          baseDecimals,
          quoteDecimals,
          tickSize: formatUnits(BigInt(market.tickSize), quoteDecimals),
          lotSize: formatUnits(BigInt(market.lotSize), baseDecimals),
          minQuantity: formatUnits(BigInt(market.minQuantity), baseDecimals),
        },
        transactionSent: false,
      });
      return;
    }

    const placeable = max.placeable && quantity <= max.maxQuantity;
    const failure = !max.placeable
      ? `The protocol says this account cannot open/increase this position right now: ${String(max.limitedBy)}.`
      : quantity > max.maxQuantity
        ? "The requested quantity is larger than the protocol's current maximum for this account."
        : undefined;

    res.status(200).json({
      ok: true,
      pass: placeable,
      stage: "live-sdk-preflight",
      result: placeable ? "PREFLIGHT PASSED" : "BLOCKED",
      explanation: placeable
        ? "Local market rules and the SDK's live size check passed. This is not a promise that a later transaction will succeed; the book and account can change."
        : failure,
      failures: failure ? [{ code: "SDK_PREFLIGHT_BLOCKED", message: failure }] : [],
      market: {
        symbol,
        poolAddress: market.poolAddress,
        baseDecimals,
        quoteDecimals,
        tickSize: formatUnits(BigInt(market.tickSize), quoteDecimals),
        lotSize: formatUnits(BigInt(market.lotSize), baseDecimals),
        minQuantity: formatUnits(BigInt(market.minQuantity), baseDecimals),
      },
      account: account,
      order: {
        side,
        price: formatUnits(price, quoteDecimals),
        quantity: formatUnits(quantity, baseDecimals),
      },
      sdk: {
        priceable: Boolean(max.priceable),
        placeable: Boolean(max.placeable),
        limitedBy: String(max.limitedBy ?? "none"),
        maxQuantity: formatUnits(BigInt(max.maxQuantity), baseDecimals),
        requestedQuantityWithinLimit: quantity <= BigInt(max.maxQuantity),
      },
      transactionSent: false,
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      stage: "live-sdk-preflight",
      error: error instanceof Error ? error.message : String(error),
      transactionSent: false,
    });
  } finally {
    try { await exchange.close?.(); } catch { /* Keep the preflight result. */ }
  }
}
