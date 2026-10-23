import { mkdirSync, writeFileSync } from "node:fs";
import { ORDER_TYPE, SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, formatUnits, http, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isConfirmedFlat, shouldAttemptEmergencyCleanup } from "../src/recovery-policy.js";

const RPC_URL = "https://api.hideki2.infra.testnet.somnia.network";
const INDEXER_URL = process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";
const DEPOSIT_USDSO = "5";
const TARGET_NOTIONAL_USDSO = 12;
const MIN_NOTIONAL_USDSO = 10;
const MAX_NOTIONAL_USDSO = 15;
const ENTRY_SLIPPAGE_BPS = 150;
const EXIT_SLIPPAGE_BPS = 300;
const GAS_LIMIT = 10_000_000n;
const ERC20_ABI = [{
  type: "function", name: "balanceOf", stateMutability: "view",
  inputs: [{ name: "owner", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

type PositionView = {
  symbol?: string; base?: string; side?: string; contracts?: number | string;
  entryPrice?: number | string; markPrice?: number | string; unrealizedPnl?: number | string;
  info?: Record<string, unknown>; [key: string]: unknown;
};

function asBigInt(value: unknown, label: string): bigint {
  try { return typeof value === "bigint" ? value : BigInt(String(value)); }
  catch { throw new Error("Could not read a valid " + label + " from Hideki."); }
}
function alignDown(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new Error("Market lot/tick step is not positive.");
  return value / step * step;
}
function alignUp(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new Error("Market lot/tick step is not positive.");
  return (value + step - 1n) / step * step;
}
function txHash(value: unknown): string | null {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) return value;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const receipt = row.receipt as Record<string, unknown> | undefined;
    for (const candidate of [row.hash, row.transactionHash, receipt?.transactionHash, receipt?.hash]) {
      if (typeof candidate === "string" && /^0x[0-9a-fA-F]{64}$/.test(candidate)) return candidate;
    }
  }
  return null;
}
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}
function positionSummary(p: PositionView | undefined): Record<string, unknown> | null {
  if (!p) return null;
  return {
    symbol: p.symbol ?? null, side: p.side ?? null, contracts: p.contracts ?? null,
    entryPrice: p.entryPrice ?? null, markPrice: p.markPrice ?? null,
    unrealizedPnl: p.unrealizedPnl ?? null,
  };
}
function looksLikeBtc(p: PositionView, symbol: string): boolean {
  return p.symbol === symbol ||
    String(p.base ?? p.info?.baseSymbol ?? "").toUpperCase() === "BTC" ||
    String(p.symbol ?? "").toUpperCase().startsWith("BTC/");
}

async function main(): Promise<void> {
  if (process.env.CONFIRM_FUNDED_POSITION_E2E !== "YES") {
    throw new Error("Safety stop: explicitly enable the one-shot Hideki position lifecycle.");
  }
  const rawKey = process.env.WALLET_KEY?.trim();
  if (!rawKey) throw new Error("Missing GitHub Actions secret wallet_key.");
  const privateKey = (rawKey.startsWith("0x") ? rawKey : "0x" + rawKey) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("wallet_key must be a 32-byte EVM private key; its value was not printed.");
  }
  const account = privateKeyToAccount(privateKey);
  const accountAddress = account.address;
  const exchange: any = new SomniaMarkets({
    chain: hidekiTestnet, indexerUrl: INDEXER_URL, wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, privateKey,
  } as never);
  const publicClient = createPublicClient({
    chain: hidekiTestnet, transport: http(RPC_URL, { timeout: 20_000 }),
  });

  const receiptPath = "artifacts/perps-stress-lab-position-roundtrip.json";
  mkdirSync("artifacts", { recursive: true });
  let marketSymbol = "BTC-PERP";
  let poolAddress: string | null = null;
  let marginBank: string | null = null;
  let collateralToken: string | null = null;
  let baseDecimals = 8;
  let quoteDecimals = 18;
  let lotSize = 1n;
  let minQuantity = 1n;
  let tickSize = 1n;
  let selectedMarket: any = null;
  let walletUsdsoBefore: string | null = null;
  let walletUsdsoAfterDeposit: string | null = null;
  let walletUsdsoFinal: string | null = null;
  let marginBefore: Record<string, unknown> | null = null;
  let marginAfterDeposit: Record<string, unknown> | null = null;
  let marginFinal: Record<string, unknown> | null = null;
  let depositHash: string | null = null;
  let depositUsdsoApplied = "0";
  let entryHash: string | null = null;
  const exitHashes: string[] = [];
  let requestedQuantity: string | null = null;
  let submittedEntryLimit: string | null = null;
  let submittedNotional: number | null = null;
  let positionsBefore: Record<string, unknown>[] = [];
  let positionAfterOpen: Record<string, unknown> | null = null;
  let positionAfterClose: Record<string, unknown> | null = null;
  let openTxFillCount: number | null = null;
  const closeFillCounts: number[] = [];
  let depositVerified = false;
  let positionOpened = false;
  let positionClosed = false;
  let entryAttempted = false;
  let cleanupAttempted = false;
  let cleanupVerified = false;
  let failure: string | null = null;

  async function readWalletUsdso(token: string): Promise<bigint> {
    return BigInt(await publicClient.readContract({
      address: token as any, abi: ERC20_ABI, functionName: "balanceOf",
      args: [accountAddress],
    }));
  }
  async function currentPositions(): Promise<PositionView[]> {
    return await exchange.fetchPositions() as PositionView[];
  }
  async function currentBtcPosition(): Promise<PositionView | undefined> {
    const list = await currentPositions();
    return list.find((p) => looksLikeBtc(p, marketSymbol));
  }
  async function currentMargin(): Promise<Record<string, unknown>> {
    if (!marginBank) throw new Error("MarginBank was not resolved.");
    return await exchange.client.getMarginAccount(marginBank, accountAddress) as Record<string, unknown>;
  }
  function marginSummary(value: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!value) return null;
    const keys = [
      "unlockedCollateralBalance", "lockedCollateral", "equity", "withdrawable",
      "imReq", "mmReq", "cmReq", "marginStatus", "activePerpPools",
    ];
    const result: Record<string, unknown> = {};
    for (const key of keys) if (key in value) result[key] = value[key];
    return result;
  }

  async function openMarketPosition(): Promise<void> {
    if (!poolAddress || !marginBank) throw new Error("BTC market configuration is missing.");
    const book = await exchange.fetchOrderBook(marketSymbol, 5);
    const bestAsk = Number(book.asks?.[0]?.[0]);
    if (!Number.isFinite(bestAsk) || bestAsk <= 0) throw new Error("BTC order book has no valid best ask.");
    const rawAsk = parseUnits(bestAsk.toFixed(8), quoteDecimals);
    const crossedLimit = alignUp(rawAsk * BigInt(10_000 + ENTRY_SLIPPAGE_BPS) / 10_000n, tickSize);
    const wanted = parseUnits(String(TARGET_NOTIONAL_USDSO), quoteDecimals) *
      (10n ** BigInt(baseDecimals)) / crossedLimit;
    let quantity = alignDown(wanted, lotSize);
    if (quantity < minQuantity) quantity = minQuantity;
    let notional = Number(formatUnits(quantity * crossedLimit / (10n ** BigInt(baseDecimals)), quoteDecimals));
    if (notional < MIN_NOTIONAL_USDSO || notional > MAX_NOTIONAL_USDSO) {
      throw new Error("Minimum/lot-aligned BTC order notional " + notional.toFixed(6) +
        " USDso is outside the strict " + MIN_NOTIONAL_USDSO + "–" + MAX_NOTIONAL_USDSO + " limit.");
    }
    const sizeGate = await exchange.client.getMaxPerpOrderSize({
      pool: poolAddress, marginBank, account: accountAddress, isBid: true, price: crossedLimit,
    });
    if (!sizeGate.priceable) throw new Error("BTC mark price is stale/unpriceable; refusing to open a position.");
    if (!sizeGate.placeable) {
      throw new Error("The funded account still cannot open BTC: limitedBy=" +
        String(sizeGate.limitedBy) + ", maxQuantity=" + String(sizeGate.maxQuantity) + ".");
    }
    const maxQuantity = asBigInt(sizeGate.maxQuantity, "maximum order quantity");
    if (quantity > maxQuantity) quantity = alignDown(maxQuantity, lotSize);
    if (quantity < minQuantity) throw new Error("Protocol size limit is below the BTC minimum order size.");
    notional = Number(formatUnits(quantity * crossedLimit / (10n ** BigInt(baseDecimals)), quoteDecimals));
    if (notional < MIN_NOTIONAL_USDSO || notional > MAX_NOTIONAL_USDSO) {
      throw new Error("Capped order size is " + notional.toFixed(6) + " USDso; outside the safe test band.");
    }
    requestedQuantity = formatUnits(quantity, baseDecimals);
    submittedEntryLimit = formatUnits(crossedLimit, quoteDecimals);
    submittedNotional = notional;
    console.log("Opening one Hideki BTC long MARKET order with a " + ENTRY_SLIPPAGE_BPS +
      " bps price guard; notional capped at 15 paper USDso.");
    entryAttempted = true;
    const result = await exchange.trader.placePerpOrder({
      pool: poolAddress, isBid: true, price: crossedLimit, quantity,
      orderType: ORDER_TYPE.MARKET, gas: GAS_LIMIT,
    });
    entryHash = txHash(result);
    openTxFillCount = Array.isArray(result?.fills) ? result.fills.length : 0;
    console.log("Position entry transaction: " + (entryHash ?? "SDK did not return a recognized hash"));
    console.log("SDK entry fill records: " + openTxFillCount);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const pos = await currentBtcPosition();
      if (pos && Number(pos.contracts ?? 0) > 0) {
        positionAfterOpen = positionSummary(pos);
        positionOpened = String(pos.side).toLowerCase() === "long";
        if (!positionOpened) throw new Error("Unexpected BTC position side: " + String(pos.side));
        console.log("BTC position read back: " + json(positionAfterOpen));
        return;
      }
      await wait(1_000);
    }
    throw new Error("The order call returned, but a BTC position was not visible within 12 seconds.");
  }

  async function closeCurrentBtcPosition(): Promise<boolean> {
    if (!poolAddress || !marginBank) throw new Error("BTC market configuration is missing for close.");
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const pos = await currentBtcPosition();
      if (!pos || !(Number(pos.contracts ?? 0) > 0)) {
        const margin = await currentMargin();
        const orders = await exchange.fetchOpenOrders(marketSymbol);
        return isConfirmedFlat({
          positions: { status: "readable", contracts: 0 },
          lockedCollateral: asBigInt(margin.lockedCollateral, "locked collateral during flat-state verification"),
          hasOpenOrders: Array.isArray(orders) ? orders.length > 0 : null,
        });
      }
      const side = String(pos.side).toLowerCase();
      if (side !== "long" && side !== "short") throw new Error("Cannot determine the side of the open BTC position safely.");
      const isBid = side === "short";
      const positionQuantity = parseUnits(Math.abs(Number(pos.contracts)).toFixed(baseDecimals), baseDecimals);
      const preview = await exchange.client.previewPerpClosePnl({
        pool: poolAddress, marginBank, account: accountAddress,
      });
      const previewQuantity = preview?.closedQuantity !== undefined
        ? asBigInt(preview.closedQuantity, "close preview quantity") : 0n;
      let quantity = previewQuantity > 0n && previewQuantity < positionQuantity ? previewQuantity : positionQuantity;
      quantity = alignDown(quantity, lotSize);
      if (quantity <= 0n) throw new Error("BTC position is below supported lot size; refusing an unsafe guessed close.");
      const book = await exchange.fetchOrderBook(marketSymbol, 5);
      const touch = Number(isBid ? book.asks?.[0]?.[0] : book.bids?.[0]?.[0]);
      if (!Number.isFinite(touch) || touch <= 0) throw new Error("No counterparty price available to close BTC.");
      const rawTouch = parseUnits(touch.toFixed(8), quoteDecimals);
      const guarded = isBid
        ? alignUp(rawTouch * BigInt(10_000 + EXIT_SLIPPAGE_BPS) / 10_000n, tickSize)
        : alignDown(rawTouch * BigInt(10_000 - EXIT_SLIPPAGE_BPS) / 10_000n, tickSize);
      if (guarded <= 0n) throw new Error("Computed BTC close limit is invalid.");
      console.log("Closing BTC " + side + " position of " + formatUnits(quantity, baseDecimals) +
        " with opposite-side MARKET order (attempt " + (cycle + 1) + ").");
      const result = await exchange.trader.placePerpOrder({
        pool: poolAddress, isBid, price: guarded, quantity,
        orderType: ORDER_TYPE.MARKET, gas: GAS_LIMIT,
      });
      const hash = txHash(result);
      if (hash) exitHashes.push(hash);
      closeFillCounts.push(Array.isArray(result?.fills) ? result.fills.length : 0);
      console.log("Position close transaction: " + (hash ?? "SDK did not return a recognized hash"));
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const after = await currentBtcPosition();
        if (!after || !(Number(after.contracts ?? 0) > 0)) {
          positionAfterClose = null;
          positionClosed = true;
          return true;
        }
        positionAfterClose = positionSummary(after);
        await wait(1_000);
      }
      await wait(1_000);
    }
    const remains = await currentBtcPosition();
    positionAfterClose = positionSummary(remains);
    positionClosed = !remains || !(Number(remains.contracts ?? 0) > 0);
    return positionClosed;
  }

  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== 50383) throw new Error("Safety stop: expected Hideki chain 50383, got " + chainId + ".");
    if (typeof exchange.trader.depositMargin !== "function" ||
        typeof exchange.trader.placePerpOrder !== "function" ||
        typeof exchange.fetchPositions !== "function") {
      throw new Error("The installed SDK lacks a required deposit, position or order API. No transaction was sent.");
    }
    const perps = await exchange.client.listPerpMarkets() as any[];
    selectedMarket = perps.find((row) => String(row.baseSymbol).toUpperCase() === "BTC");
    if (!selectedMarket) throw new Error("BTC Perps market is missing from the live Hideki list.");
    poolAddress = String(selectedMarket.poolAddress);
    marginBank = String(selectedMarket.marginBank);
    baseDecimals = Number(selectedMarket.baseDecimals);
    quoteDecimals = Number(selectedMarket.quoteDecimals);
    lotSize = asBigInt(selectedMarket.lotSize, "lot size");
    minQuantity = asBigInt(selectedMarket.minQuantity, "minimum quantity");
    tickSize = asBigInt(selectedMarket.tickSize, "tick size");
    const sdkMarkets = await exchange.loadMarkets();
    const sdkMarket = Object.values(sdkMarkets).find((row: any) =>
      row.type === "swap" &&
      String(row.base ?? row.info?.baseSymbol ?? "").toUpperCase() === "BTC" &&
      String(row.quote ?? row.info?.quoteSymbol ?? "").toUpperCase() === String(selectedMarket.quoteSymbol).toUpperCase()
    ) as any;
    if (!sdkMarket?.symbol) throw new Error("SDK could not resolve BTC Perps order book.");
    marketSymbol = String(sdkMarket.symbol);

    const config = await exchange.client.getPerpSystemConfig(marginBank);
    collateralToken = String(config?.collateral ?? selectedMarket.quoteToken ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(collateralToken)) {
      throw new Error("Could not resolve USDso collateral address from live MarginBank configuration.");
    }
    const tokenBefore = await readWalletUsdso(collateralToken);
    walletUsdsoBefore = formatUnits(tokenBefore, quoteDecimals);
    const startingMargin = await currentMargin();
    marginBefore = marginSummary(startingMargin);
    const existingPositions = await currentPositions();
    positionsBefore = existingPositions.map((p) => positionSummary(p) ?? {});
    if (existingPositions.length > 0) {
      throw new Error("Safety stop: this wallet already has a Perps position (" +
        existingPositions.map((p) => String(p.symbol) + " " + String(p.side)).join(", ") +
        "). No deposit or new position was attempted.");
    }
    const existingOrders = await exchange.fetchOpenOrders(marketSymbol);
    if (Array.isArray(existingOrders) && existingOrders.length > 0) {
      throw new Error("Safety stop: BTC has " + existingOrders.length + " open orders. No deposit or position was attempted.");
    }
    const requiredPerpsBuffer = parseUnits(DEPOSIT_USDSO, quoteDecimals);
    const currentUnlocked = asBigInt(
      startingMargin.unlockedCollateralBalance ?? startingMargin.equity ?? 0n,
      "current unlocked Perps collateral",
    );
    const depositAmount = currentUnlocked < requiredPerpsBuffer ? requiredPerpsBuffer : 0n;
    if (depositAmount > 0n && tokenBefore < depositAmount) {
      throw new Error("Wallet USDso is " + walletUsdsoBefore + ", below the fixed " + DEPOSIT_USDSO +
        " USDso top-up needed because Perps margin is below 5 USDso. No transaction was sent.");
    }

    console.log("Hideki wallet: " + accountAddress + " | BTC market: " + marketSymbol);
    console.log("Wallet USDso before: " + walletUsdsoBefore);
    console.log("Perps margin before: " + json(marginBefore));
    if (depositAmount > 0n) {
      console.log("Perps unlocked margin is below 5 USDso. Depositing exactly " + DEPOSIT_USDSO +
        " from the existing wallet balance. Voucher claim is skipped.");
      const depositResult = await exchange.trader.depositMargin({
        marginBank, collateral: collateralToken, amount: depositAmount,
        autoApprove: true, gas: GAS_LIMIT,
      });
      depositHash = txHash(depositResult);
      depositUsdsoApplied = DEPOSIT_USDSO;
      console.log("Perps deposit transaction: " + (depositHash ?? "SDK did not return a recognized deposit hash"));
    } else {
      console.log("Perps already has at least 5 USDso of unlocked margin. Skipping another transfer; no voucher claim.");
    }

    const minimumEquity = asBigInt(startingMargin.equity ?? 0n, "starting margin equity") +
      depositAmount * 9_950n / 10_000n;
    const expectedWalletDelta = depositAmount * 9_950n / 10_000n;
    let marginAfter: Record<string, unknown> | null = null;
    let tokenAfter = 0n;
    for (let attempt = 0; attempt < (depositAmount > 0n ? 12 : 1); attempt += 1) {
      if (depositAmount > 0n) await wait(1_000);
      marginAfter = await currentMargin();
      tokenAfter = await readWalletUsdso(collateralToken);
      const equity = asBigInt(marginAfter.equity ?? 0n, "post-funding margin equity");
      if (equity >= minimumEquity && tokenBefore - tokenAfter >= expectedWalletDelta) break;
    }
    if (!marginAfter) throw new Error("MarginBank read-back failed after funding check.");
    walletUsdsoAfterDeposit = formatUnits(tokenAfter, quoteDecimals);
    marginAfterDeposit = marginSummary(marginAfter);
    const actualEquity = asBigInt(marginAfter.equity ?? 0n, "post-funding margin equity");
    if (actualEquity < minimumEquity) {
      throw new Error("MarginBank equity did not confirm the required margin after funding. Refusing to open a position.");
    }
    if (tokenBefore - tokenAfter < expectedWalletDelta) {
      throw new Error("Wallet USDso balance did not confirm the expected transfer/read-back. Refusing to open a position.");
    }
    depositVerified = true;
    console.log("Any transferred USDso will remain in Perps after the position closes; this run does not withdraw it back to Spot.");
    console.log("Perps margin after funding check: " + json(marginAfterDeposit));
    console.log("Wallet USDso after funding check: " + walletUsdsoAfterDeposit);

    const initialBook = await exchange.fetchOrderBook(marketSymbol, 1);
    const initialAsk = Number(initialBook.asks?.[0]?.[0]);
    if (!Number.isFinite(initialAsk) || initialAsk <= 0) throw new Error("BTC order book has no ask after deposit.");
    const gatePrice = parseUnits(initialAsk.toFixed(8), quoteDecimals);
    const gate = await exchange.client.getMaxPerpOrderSize({
      pool: poolAddress, marginBank, account: accountAddress, isBid: true, price: gatePrice,
    });
    if (!gate.priceable) throw new Error("BTC mark is unpriceable after deposit; no position opened.");
    if (!gate.placeable) {
      throw new Error("BTC order-size gate still refuses the position after deposit: limitedBy=" +
        String(gate.limitedBy) + ", maxQuantity=" + String(gate.maxQuantity) + ".");
    }

    await openMarketPosition();
    if (!await closeCurrentBtcPosition()) {
      throw new Error("Could not prove the BTC position flat after four close attempts.");
    }
    positionAfterClose = null;
    positionClosed = true;
    marginFinal = marginSummary(await currentMargin());
    walletUsdsoFinal = formatUnits(await readWalletUsdso(collateralToken), quoteDecimals);
    console.log("Position opened and closed. Final Perps margin: " + json(marginFinal));
    console.log("Final wallet USDso: " + walletUsdsoFinal);
  } catch (error) {
    failure = error instanceof Error ? error.message : "Unknown failure";
    console.error("FUNDED POSITION ROUNDTRIP FAILED:", failure);
    if (entryAttempted) {
      try {
        const remaining = await currentBtcPosition();
        if (shouldAttemptEmergencyCleanup({
          entryWasAttempted: entryAttempted,
          positionRead: remaining && Number.isFinite(Number(remaining.contracts))
            ? { status: "readable", contracts: Math.abs(Number(remaining.contracts)), side: String(remaining.side).toLowerCase() === "short" ? "short" : "long" }
            : { status: "readable", contracts: 0 },
        })) {
          cleanupAttempted = true;
          console.error("Emergency cleanup: trying to close the BTC position opened in this run.");
          cleanupVerified = await closeCurrentBtcPosition();
        } else {
          cleanupVerified = true;
        }
      } catch (cleanupError) {
        cleanupAttempted = true;
        cleanupVerified = false;
        console.error("URGENT: could not verify or close a remaining BTC position. Inspect the testnet account immediately:",
          cleanupError instanceof Error ? cleanupError.message : "unknown cleanup error");
      }
    }
  } finally {
    try {
      if (collateralToken && marginBank) {
        walletUsdsoFinal = formatUnits(await readWalletUsdso(collateralToken), quoteDecimals);
        marginFinal = marginSummary(await currentMargin());
        const remaining = await currentBtcPosition();
        positionAfterClose = positionSummary(remaining);
        if (entryAttempted) {
          const finalOrders = await exchange.fetchOpenOrders(marketSymbol);
          positionClosed = isConfirmedFlat({
            positions: { status: "readable", contracts: remaining ? Math.abs(Number(remaining.contracts ?? 0)) : 0 },
            lockedCollateral: asBigInt(marginFinal?.lockedCollateral ?? 0n, "final locked collateral"),
            hasOpenOrders: Array.isArray(finalOrders) ? finalOrders.length > 0 : null,
          });
        }
        if (entryAttempted && !positionClosed && !cleanupAttempted) {
          cleanupAttempted = true;
          cleanupVerified = await closeCurrentBtcPosition();
          const afterCleanup = await currentBtcPosition();
          positionAfterClose = positionSummary(afterCleanup);
          const finalOrders = await exchange.fetchOpenOrders(marketSymbol);
          positionClosed = isConfirmedFlat({
            positions: { status: "readable", contracts: afterCleanup ? Math.abs(Number(afterCleanup.contracts ?? 0)) : 0 },
            lockedCollateral: asBigInt(marginFinal?.lockedCollateral ?? 0n, "locked collateral after cleanup"),
            hasOpenOrders: Array.isArray(finalOrders) ? finalOrders.length > 0 : null,
          });
        }
      }
    } catch (finalReadError) {
      if (!failure) failure = "Final state read failed: " +
        (finalReadError instanceof Error ? finalReadError.message : "unknown read error");
    }

    const receipt = {
      product: "Perps Stress Lab",
      test: "funded Hideki Perps position open/close round-trip",
      recordedAt: new Date().toISOString(),
      network: { name: "Somnia Hideki testnet", chainId: 50383 },
      account: accountAddress,
      market: marketSymbol,
      collateral: {
        token: collateralToken,
        walletUsdsoBefore,
        walletUsdsoAfterDeposit,
        walletUsdsoFinal,
        depositUsdso: depositUsdsoApplied,
        depositTransaction: depositHash,
        marginBefore,
        marginAfterDeposit,
        marginFinal,
        depositVerified,
      },
      order: {
        side: "long", type: "MARKET",
        targetNotionalUsdso: TARGET_NOTIONAL_USDSO,
        minNotionalUsdso: MIN_NOTIONAL_USDSO, maxNotionalUsdso: MAX_NOTIONAL_USDSO,
        quantity: requestedQuantity, guardedLimitPrice: submittedEntryLimit,
        guardedNotionalUsdso: submittedNotional, slippageGuardBps: ENTRY_SLIPPAGE_BPS,
        placementTransaction: entryHash, sdkFillRecords: openTxFillCount,
      },
      position: {
        before: positionsBefore, afterOpen: positionAfterOpen, afterClose: positionAfterClose,
        closed: positionClosed, closeTransactions: exitHashes, closeFillRecordCounts: closeFillCounts,
        cleanupAttempted, cleanupVerified,
      },
      verification: {
        chainIdCorrect: true, existingPositionsLeftUntouched: positionsBefore.length === 0,
        depositVerified, positionOpened, positionClosed,
        verified: Boolean(depositVerified && positionOpened && positionClosed && !failure),
      },
      error: failure,
      note: "Hideki testnet only. Paper USDso is not real money. GitHub Actions wallet_key was used without printing or recording key material.",
    };
    writeFileSync(receiptPath, json(receipt) + "\n", { mode: 0o600 });
    try { await exchange.close?.(); } catch { /* preserve evidence */ }
    console.log("Redacted position lifecycle receipt written to " + receiptPath);
  }

  if (failure) throw new Error(failure);
  if (!depositVerified || !positionOpened || !positionClosed) {
    throw new Error("Position lifecycle ended without complete deposit/open/close verification.");
  }
}

main().catch((error: unknown) => {
  console.error("FUNDED POSITION ROUNDTRIP TERMINATED:", error instanceof Error ? error.message : "Unknown failure");
  process.exitCode = 1;
});
