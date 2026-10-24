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
function isValidSymbol(value: string): boolean {
  return /^[A-Z0-9][A-Z0-9:_/-]{1,39}$/i.test(value);
}
function isNonZeroPosition(row: AnyRow): boolean {
  if (row.size == null) return true; // Keep an explicitly unknown row visible instead of inventing flatness.
  return toBigInt(row.size, "position size") !== 0n;
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
    try {
      accountState = await exchange.client.getMarginAccount(marginBank, account) as AnyRow;
    } catch {
      // Account equity/health may fail when an oracle mark is stale. Collateral basis
      // is a different read and is never presented as equity.
      accountHealthStatus = "unavailable-stale-mark-or-rpc";
      collateralBasis = human(
        await exchange.client.getPerpCollateralBasis(marginBank, account),
        quoteDecimals,
        "collateral basis",
      );
    }

    // This SDK bulk read returns all active positions at one pinned block. It also
    // preserves a position's signed size/pool when a mark is stale and excludes closed
    // positions from the live bank state. Use it before falling back to indexed rows.
    let positionRows: AnyRow[] = [];
    let positionsSource = "MarginBank analytics snapshot (single-block read)";
    let positionsFallbackUnavailable = false;
    try {
      positionRows = await exchange.client.listPerpPositionAnalytics({ marginBank, account }) as AnyRow[];
      positionRows = positionRows.filter(isNonZeroPosition);
    } catch {
      positionsSource = "indexer fallback (may lag the chain)";
      try {
        const indexed = await exchange.client.listPerpPositions(account) as AnyRow[];
        positionRows = indexed
          .filter(isNonZeroPosition)
          .filter((row) => {
            const market = markets.find((item) =>
              String(item.poolAddress ?? "").toLowerCase() === String(row.pool ?? row.poolAddress ?? "").toLowerCase()
            );
            // The requested market selects a MarginBank scope; don't mix indexed
            // positions from a different bank into this cross-margin account.
            return market != null && String(market.marginBank ?? "").toLowerCase() === marginBank.toLowerCase();
          })
          .map((row) => ({ ...row, poolAddress: String(row.pool ?? row.poolAddress ?? ""), indexerOnly: true }));
      } catch {
        positionsFallbackUnavailable = true;
        positionRows = [];
      }
    }

    const mapped = await Promise.all(positionRows.map(async (row) => {
      const poolAddress = String(row.poolAddress ?? row.pool ?? "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(poolAddress)) return null;
      const market = markets.find((item) => String(item.poolAddress ?? "").toLowerCase() === poolAddress.toLowerCase());
      const symbol = market ? marketSymbol(market) : "Unknown market";
      const baseDecimals = Number(market?.baseDecimals ?? selected.baseDecimals ?? 18);
      const positionQuoteDecimals = Number(market?.quoteDecimals ?? quoteDecimals);
      if (!Number.isInteger(baseDecimals) || baseDecimals < 0 || baseDecimals > 36 ||
          !Number.isInteger(positionQuoteDecimals) || positionQuoteDecimals < 0 || positionQuoteDecimals > 36) {
        return null;
      }
      const positionBank = String(market?.marginBank ?? marginBank);
      const ref = { marginBank: positionBank, account, pool: poolAddress };
      let position: AnyRow | null = row.indexerOnly ? row : row;
      let analytics: AnyRow | null = row.indexerOnly ? null : row;
      let positionReadStatus = row.indexerOnly ? "indexer-only; may lag chain" : "available";

      // The bulk analytics union carries size/pool on stale rows but may omit entry
      // details. A direct position read can still provide the stored size/basis.
      if (position.avgEntryPrice == null || position.size == null) {
        try {
          position = await exchange.client.getPerpPosition(ref) as AnyRow;
          positionReadStatus = row.indexerOnly ? "indexer plus chain position read" : "chain position read supplemented missing analytics fields";
        } catch {
          if (!row.indexerOnly) positionReadStatus = "position-read-unavailable";
        }
      }

      const sizeRaw = row.size ?? position?.size;
      let quantityBase: string | null = null;
      let side = "unknown";
      if (sizeRaw != null) {
        const size = toBigInt(sizeRaw, "position size");
        // Active pools can include pools with orders but no position. Filter them out
        // even if an RPC fallback returned a zero-size row.
        if (size === 0n) return null;
        side = size > 0n ? "long" : "short";
        quantityBase = formatUnits(size < 0n ? -size : size, baseDecimals);
      }

      const priceable = analytics != null && analytics.priceable !== false && analytics.markPrice != null;
      const field = (key: string): string | null => {
        if (!priceable || analytics?.[key] == null) return null;
        return human(analytics[key], positionQuoteDecimals, key);
      };

      let liquidationPrice: string | null = null;
      let liquidationPriceStatus = "unavailable-stale-mark-or-rpc";
      if (analytics?.priceable === false) {
        liquidationPriceStatus = "unavailable-stale-mark";
      } else {
        try {
          const price = await exchange.client.getLiquidationPrice(ref);
          liquidationPrice = price == null ? null : human(price, positionQuoteDecimals, "liquidation price");
          liquidationPriceStatus = price == null ? "not-applicable-flat-position" : "sdk-estimate";
        } catch {
          liquidationPriceStatus = "unavailable-stale-mark-or-rpc";
        }
      }

      return {
        symbol,
        poolAddress,
        side,
        quantityBase,
        entryPrice: position?.avgEntryPrice == null ? null : human(position.avgEntryPrice, positionQuoteDecimals, "entry price"),
        markPrice: priceable && analytics?.markPrice != null ? human(analytics.markPrice, positionQuoteDecimals, "mark price") : null,
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
    }));
    const positions = mapped.filter((row): row is NonNullable<typeof row> => row !== null);

    const accountSummary = accountState ? {
      unlockedCollateralUsdso: human(accountState.unlockedCollateralBalance, quoteDecimals, "unlocked collateral"),
      lockedCollateralUsdso: human(accountState.lockedCollateral, quoteDecimals, "locked collateral"),
      equityUsdso: human(accountState.equity, quoteDecimals, "account equity"),
      withdrawableUsdso: human(accountState.withdrawable, quoteDecimals, "withdrawable collateral"),
      initialMarginRequirementUsdso: human(accountState.imReq, quoteDecimals, "initial margin requirement"),
      maintenanceMarginRequirementUsdso: human(accountState.mmReq, quoteDecimals, "maintenance margin requirement"),
      closeOutMarginRequirementUsdso: human(accountState.cmReq, quoteDecimals, "close-out margin requirement"),
      marginStatus: String(accountState.marginStatus ?? "unknown"),
      activePositionCount: positionsFallbackUnavailable ? null : positions.length,
    } : {
      unlockedCollateralUsdso: null,
      lockedCollateralUsdso: null,
      equityUsdso: null,
      withdrawableUsdso: null,
      initialMarginRequirementUsdso: null,
      maintenanceMarginRequirementUsdso: null,
      closeOutMarginRequirementUsdso: null,
      marginStatus: accountHealthStatus,
      activePositionCount: positionsFallbackUnavailable ? null : positions.length,
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
      positionsStatus: positionsFallbackUnavailable ? "unavailable" : positionsSource.startsWith("indexer") ? "indexed-fallback" : "available",
      summary: accountSummary,
      positionCount: positionsFallbackUnavailable ? null : positions.length,
      positions,
      notes: [
        "Cross-margin account-level USDso is shared by positions within this MarginBank.",
        "Liquidation price is the SDK estimate for that market moving alone while the account's other market contributions are held constant.",
        "A stale mark or RPC error makes the estimate unavailable; an unavailable value is never represented as zero.",
        "Index-only fallback rows may lag the current chain and are labeled as such.",
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
