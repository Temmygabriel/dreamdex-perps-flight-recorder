import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { formatUnits, isAddress } from "viem";

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
function toBigInt(value: unknown, label: string): bigint {
  try { return typeof value === "bigint" ? value : BigInt(String(value)); }
  catch { throw new Error("Protocol returned invalid " + label + "."); }
}
function human(value: unknown, decimals: number, label: string): string {
  return formatUnits(toBigInt(value, label), decimals);
}
function marketSymbol(row: AnyRow): string {
  return String(row.symbol ?? (String(row.baseSymbol ?? "") + "-" + String(row.quoteSymbol ?? "")));
}
function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}
function marketMatches(row: AnyRow, symbol: string): boolean {
  const wanted = normalizeSymbol(symbol);
  return normalizeSymbol(marketSymbol(row)) === wanted ||
    normalizeSymbol(String(row.baseSymbol ?? "") + "-" + String(row.quoteSymbol ?? "")) === wanted;
}
function unitCount(value: unknown): number | null {
  try { return Number(toBigInt(value, "position size")); } catch { return null; }
}
function isValidSymbol(value: string): boolean {
  return /^[A-Z0-9][A-Z0-9:_/-]{1,39}$/i.test(value);
}

export default async function handler(req: Req, res: Res): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "Use GET for a read-only public-address account risk check." });
    return;
  }

  const account = one(req.query?.address).trim();
  const requestedSymbol = one(req.query?.symbol).trim();
  if (!isAddress(account)) {
    res.status(400).json({ ok: false, error: "Enter a valid public EVM wallet address. Never enter a private key." });
    return;
  }
  if (requestedSymbol && !isValidSymbol(requestedSymbol)) {
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

    const markets = await exchange.client.listPerpMarkets() as AnyRow[];
    if (!markets.length) {
      res.status(502).json({ ok: false, error: "Hideki returned no Perps markets; account risk was not calculated." });
      return;
    }
    const wanted = requestedSymbol || "BTC-USDso";
    const selected = markets.find((row) => marketMatches(row, wanted)) ??
      (!requestedSymbol ? markets.find((row) => String(row.baseSymbol ?? "").toUpperCase() === "BTC") : undefined) ??
      (!requestedSymbol ? markets[0] : undefined);
    if (!selected) {
      res.status(404).json({ ok: false, error: "That market was not found in the current Hideki Perps market list." });
      return;
    }
    const marginBank = String(selected.marginBank ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(marginBank)) {
      throw new Error("Market did not provide a valid MarginBank address.");
    }
    const quoteDecimals = Number(selected.quoteDecimals ?? 18);
    if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 36) {
      throw new Error("Protocol returned invalid quote-token decimals.");
    }

    let accountState: AnyRow | null = null;
    let collateralBasis: string | null = null;
    let accountHealthStatus = "available";
    let positionsSource = "MarginBank active pools";
    let activePools: string[] = [];
    let positionsFallbackUnavailable = false;

    try {
      accountState = await exchange.client.getMarginAccount(marginBank, account) as AnyRow;
      activePools = Array.isArray(accountState.activePerpPools)
        ? accountState.activePerpPools.map((pool: unknown) => String(pool))
        : [];
    } catch {
      // Equity and health may fail when an oracle mark is stale. Collateral basis is a
      // separate safe on-chain read and may still be available; never call that equity.
      accountHealthStatus = "unavailable-stale-mark-or-rpc";
      positionsSource = "indexer fallback (may lag the chain)";
      collateralBasis = human(await exchange.client.getPerpCollateralBasis(marginBank, account), quoteDecimals, "collateral basis");
      try {
        const indexed = await exchange.client.listPerpPositions(account) as AnyRow[];
        activePools = indexed
          .filter((row) => {
            const size = unitCount(row.size);
            return size !== null && size !== 0;
          })
          .map((row) => String(row.pool ?? ""))
          .filter((pool) => /^0x[0-9a-fA-F]{40}$/.test(pool));
      } catch {
        positionsFallbackUnavailable = true;
      }
    }

    const positions = await Promise.all(activePools.map(async (poolAddress) => {
      const market = markets.find((row) => String(row.poolAddress ?? "").toLowerCase() === poolAddress.toLowerCase());
      const baseDecimals = Number(market?.baseDecimals ?? 18);
      const symbol = market ? marketSymbol(market) : "Unknown market";
      const ref = { marginBank, account, pool: poolAddress };
      let position: AnyRow | null = null;
      let analytics: AnyRow | null = null;
      let positionReadStatus = "available";
      let liquidationPrice: string | null = null;
      let liquidationPriceStatus = "available";

      try { position = await exchange.client.getPerpPosition(ref) as AnyRow; }
      catch { positionReadStatus = "position-read-unavailable"; }
      try { analytics = await exchange.client.getPerpPositionAnalytics(ref) as AnyRow; }
      catch { positionReadStatus = "position-analytics-unavailable"; }

      const sizeRaw = position?.size ?? analytics?.size;
      // MarginBank.activePerpPools can include pools where the account only has orders.
      // A zero position must not appear as an open risk row or trigger a liquidation-price read.
      if (sizeRaw != null && toBigInt(sizeRaw, "position size") === 0n) return null;

      try {
        const price = await exchange.client.getLiquidationPrice(ref);
        liquidationPrice = price == null ? null : human(price, quoteDecimals, "liquidation price");
        liquidationPriceStatus = price == null ? "not-applicable-flat-position" : "sdk-estimate";
      } catch {
        liquidationPriceStatus = "unavailable-stale-mark-or-rpc";
      }

      let quantity: string | null = null;
      let side: string = "unknown";
      if (sizeRaw != null) {
        const size = toBigInt(sizeRaw, "position size");
        side = size > 0n ? "long" : size < 0n ? "short" : "flat";
        const absoluteSize = size < 0n ? -size : size;
        quantity = formatUnits(absoluteSize, baseDecimals);
      }
      const priceable = analytics != null && analytics.priceable !== false &&
        analytics.markPrice != null;
      const field = (key: string): string | null => {
        if (!priceable || analytics?.[key] == null) return null;
        return human(analytics[key], quoteDecimals, key);
      };

      return {
        symbol,
        poolAddress,
        side,
        quantityBase: quantity,
        entryPrice: position?.avgEntryPrice == null ? null : human(position.avgEntryPrice, quoteDecimals, "entry price"),
        markPrice: priceable && analytics?.markPrice != null ? human(analytics.markPrice, quoteDecimals, "mark price") : null,
        notionalUsdso: field("notional"),
        unrealizedPnlUsdso: field("unrealizedPnl"),
        accruedFundingOwedUsdso: field("accruedFunding"),
        equityContributionUsdso: field("equityContribution"),
        initialMarginRequirementUsdso: field("initialMarginRequirement"),
        maintenanceMarginRequirementUsdso: field("maintenanceMarginRequirement"),
        closeOutMarginRequirementUsdso: field("closeOutMarginRequirement"),
        priceable,
        priceStatus: priceable ? "mark-available" : "stale-or-unavailable",
        positionReadStatus,
        estimatedLiquidationPrice: liquidationPrice,
        liquidationPriceStatus,
      };
    })).then((rows: Array<Record<string, unknown> | null>) => rows.filter((row): row is Record<string, unknown> => row !== null));

    const accountSummary = accountState ? {
      unlockedCollateralUsdso: human(accountState.unlockedCollateralBalance, quoteDecimals, "unlocked collateral"),
      lockedCollateralUsdso: human(accountState.lockedCollateral, quoteDecimals, "locked collateral"),
      equityUsdso: human(accountState.equity, quoteDecimals, "account equity"),
      withdrawableUsdso: human(accountState.withdrawable, quoteDecimals, "withdrawable collateral"),
      initialMarginRequirementUsdso: human(accountState.imReq, quoteDecimals, "initial margin requirement"),
      maintenanceMarginRequirementUsdso: human(accountState.mmReq, quoteDecimals, "maintenance margin requirement"),
      closeOutMarginRequirementUsdso: human(accountState.cmReq, quoteDecimals, "close-out margin requirement"),
      marginStatus: String(accountState.marginStatus ?? "unknown"),
      activePositionCount: positions.length,
    } : {
      unlockedCollateralUsdso: null,
      lockedCollateralUsdso: null,
      equityUsdso: null,
      withdrawableUsdso: null,
      initialMarginRequirementUsdso: null,
      maintenanceMarginRequirementUsdso: null,
      closeOutMarginRequirementUsdso: null,
      marginStatus: accountHealthStatus,
      activePositionCount: positions.length,
      collateralBasisUsdso: collateralBasis,
    };

    res.status(200).json({
      ok: true,
      network: { name: "Somnia Hideki / dreamDEX Tokyo testnet", chainId: 50383 },
      account,
      marketScope: { symbol: marketSymbol(selected), marginBank },
      readAt: new Date().toISOString(),
      readOnly: true,
      signerRequired: false,
      accountHealthAvailable: accountState !== null,
      accountHealthStatus,
      positionsSource,
      positionsStatus: positionsFallbackUnavailable ? "unavailable" : "available",
      summary: accountSummary,
      positionCount: positions.length,
      positions,
      notes: [
        "Cross-margin account-level USDso is shared by positions in this MarginBank.",
        "Liquidation price is the SDK estimate for that market moving alone while the account's other market contributions are held constant.",
        "A stale mark or RPC error makes the estimate unavailable; an unavailable value is never represented as zero.",
        "This endpoint performs read-only queries. It never signs or submits a transaction.",
      ],
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "Account risk data is temporarily unavailable from the Hideki RPC/indexer. No risk verdict was produced; retry when data is healthy.",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    try { await exchange?.close?.(); } catch { /* Keep the API result if socket cleanup fails. */ }
  }
}
