import { mkdirSync, writeFileSync } from "node:fs";
import {
  ORDER_TYPE,
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
  decodePlaceOrder,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = "https://api.hideki2.infra.testnet.somnia.network";
const INDEXER_URL = process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";
const TARGET_NOTIONAL_USDSO = 12;
const MIN_NOTIONAL_USDSO = 10;
const MAX_NOTIONAL_USDSO = 15;
const TOPUP_USDSO = "1.5";
const GAS_LIMIT = 10_000_000n;

const poolAbi = parseAbi([
  "function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)",
  "function cancelOrder(uint128 orderId)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
]);

function asBigInt(value: unknown, label: string): bigint {
  try {
    return typeof value === "bigint" ? value : BigInt(String(value));
  } catch {
    throw new Error("Market returned an invalid " + label + ".");
  }
}
function alignDown(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new Error("Market tick/lot size must be positive.");
  return (value / step) * step;
}
function alignUp(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new Error("Market tick/lot size must be positive.");
  return ((value + step - 1n) / step) * step;
}
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}
function txHash(result: unknown): string | null {
  if (typeof result === "string" && /^0x[0-9a-fA-F]{64}$/.test(result)) return result;
  if (result && typeof result === "object") {
    const row = result as Record<string, unknown>;
    for (const value of [row.hash, row.transactionHash, (row.receipt as Record<string, unknown> | undefined)?.transactionHash]) {
      if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) return value;
    }
  }
  return null;
}
function summaryMargin(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const preferred = [
    "balance", "freeBalance", "lockedBalance", "equity", "withdrawable", "activePools",
    "freeCollateral", "lockedCollateral", "imReq", "mmReq", "cmReq", "marginStatus",
  ];
  const summary: Record<string, unknown> = {};
  for (const key of preferred) {
    if (key in row) summary[key] = row[key];
  }
  return Object.keys(summary).length ? summary : row;
}

async function main(): Promise<void> {
  if (process.env.CONFIRM_FUNDED_PERPS_E2E !== "YES") {
    throw new Error("Safety stop: this workflow must explicitly set CONFIRM_FUNDED_PERPS_E2E=YES.");
  }
  const rawKey = process.env.WALLET_KEY?.trim();
  if (!rawKey) throw new Error("Missing GitHub Actions secret wallet_key.");
  const privateKey = (rawKey.startsWith("0x") ? rawKey : "0x" + rawKey) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("wallet_key must be a 32-byte EVM private key. The value was not printed.");
  }

  const account = privateKeyToAccount(privateKey);
  const exchange: any = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    privateKey,
  } as never);
  const publicClient = createPublicClient({
    chain: hidekiTestnet,
    transport: http(RPC_URL, { timeout: 20_000 }),
  });
  const walletClient = createWalletClient({
    account,
    chain: hidekiTestnet,
    transport: http(RPC_URL, { timeout: 20_000 }),
  });

  let side = process.env.PERPS_E2E_SIDE === "short" ? "short" : "long";
  const isBid = side === "long";
  let marketSymbol = "BTC-PERP";
  let marginBank: `0x${string}` | null = null;
  let collateralToken: `0x${string}` | null = null;
  let walletCollateralBefore: string | null = null;
  let walletCollateralAfter: string | null = null;
  let marginBefore: unknown = null;
  let marginAfter: unknown = null;
  let depositTransaction: string | null = null;
  let placementTransaction: string | null = null;
  let cancellationTransaction: string | null = null;
  let orderIdText: string | null = null;
  let orderPrice = "";
  let orderQuantity = "";
  let actualNotional = 0;
  let filledCount = 0;
  let orderVisibleAfterPlacement = false;
  let orderAbsentAfterCancellation = false;
  let failure: string | null = null;
  let poolAddress: `0x${string}` | null = null;

  const receiptPath = "artifacts/perps-stress-lab-funded-order-e2e.json";
  mkdirSync("artifacts", { recursive: true });

  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== 50383) throw new Error("Safety stop: expected Hideki chain 50383, got " + chainId + ".");
    if (typeof exchange.trader.depositMargin !== "function") {
      throw new Error("Installed SDK does not expose trader.depositMargin; stopping before transactions.");
    }

    const perps = await exchange.client.listPerpMarkets() as any[];
    const market = perps.find((row) => String(row.baseSymbol).toUpperCase() === "BTC");
    if (!market) throw new Error("BTC Perps market not returned by the chain SDK.");
    poolAddress = market.poolAddress as `0x${string}`;
    marginBank = market.marginBank as `0x${string}`;
    const baseDecimals = Number(market.baseDecimals);
    const quoteDecimals = Number(market.quoteDecimals);
    const tickSize = asBigInt(market.tickSize, "tick size");
    const lotSize = asBigInt(market.lotSize, "lot size");
    const minQuantity = asBigInt(market.minQuantity, "minimum quantity");
    marketSymbol = "BTC-PERP";

    const systemConfig = await exchange.client.getPerpSystemConfig(marginBank);
    collateralToken = String(systemConfig?.collateral ?? market.quoteToken ?? "") as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{40}$/.test(collateralToken)) {
      throw new Error("Could not resolve collateral token from the live Perps system config. No transaction was sent.");
    }

    const tokenBalance = await publicClient.readContract({
      address: collateralToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    walletCollateralBefore = formatUnits(tokenBalance, quoteDecimals);
    marginBefore = typeof exchange.client.getMarginAccount === "function"
      ? await exchange.client.getMarginAccount(marginBank, account.address)
      : { note: "Installed SDK does not expose getMarginAccount; order-size preflight remains authoritative." };

    const sdkMarkets = await exchange.loadMarkets();
    const sdkMarket = Object.values(sdkMarkets).find((row: any) =>
      row.type === "swap" &&
      String(row.base ?? row.info?.baseSymbol ?? "").toUpperCase() === "BTC" &&
      String(row.quote ?? row.info?.quoteSymbol ?? "").toUpperCase() === String(market.quoteSymbol).toUpperCase()
    ) as any;
    if (!sdkMarket?.symbol) throw new Error("SDK did not resolve a BTC Perps order book.");
    marketSymbol = String(sdkMarket.symbol);

    const openBefore = await exchange.fetchOpenOrders(marketSymbol);
    if (Array.isArray(openBefore) && openBefore.length > 0) {
      throw new Error("Safety stop: this wallet already has open orders on " + marketSymbol + ". No duplicate order or deposit was attempted.");
    }

    const book = await exchange.fetchOrderBook(marketSymbol, 1);
    const topValue = Number(isBid ? book.bids?.[0]?.[0] : book.asks?.[0]?.[0]);
    if (!Number.isFinite(topValue) || topValue <= 0) throw new Error("BTC book lacks a valid top quote.");
    const rawTop = parseUnits(topValue.toFixed(Math.min(quoteDecimals, 8)), quoteDecimals);
    const targetPrice = isBid ? (rawTop * 9_990n) / 10_000n : (rawTop * 10_010n) / 10_000n;
    const price = isBid ? alignDown(targetPrice, tickSize) : alignUp(targetPrice, tickSize);
    if (price <= 0n) throw new Error("Computed POST_ONLY order price is invalid.");

    const checkSize = async () => await exchange.client.getMaxPerpOrderSize({
      pool: poolAddress,
      marginBank,
      account: account.address,
      isBid,
      price,
    });
    let max = await checkSize();
    if (!max.priceable) {
      throw new Error("The protocol mark is stale/unpriceable. Refusing to deposit or submit an order.");
    }

    const wantedQuantity = (parseUnits(String(TARGET_NOTIONAL_USDSO), quoteDecimals) * (10n ** BigInt(baseDecimals))) / price;
    let quantity = alignDown(wantedQuantity, lotSize);
    if (quantity < minQuantity) quantity = minQuantity;
    const calcNotional = (q: bigint) => Number(formatUnits((q * price) / (10n ** BigInt(baseDecimals)), quoteDecimals));
    actualNotional = calcNotional(quantity);
    if (!Number.isFinite(actualNotional) || actualNotional < MIN_NOTIONAL_USDSO || actualNotional > MAX_NOTIONAL_USDSO) {
      throw new Error("Safety stop: minimum- and lot-aligned order notional " + actualNotional.toFixed(4) +
        " USDso is outside the fixed " + MIN_NOTIONAL_USDSO + "–" + MAX_NOTIONAL_USDSO + " cap.");
    }

    if ((!max.placeable || quantity > asBigInt(max.maxQuantity, "maximum order size")) && String(max.limitedBy) === "collateral") {
      const topUp = parseUnits(TOPUP_USDSO, quoteDecimals);
      const available = await publicClient.readContract({
        address: collateralToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      });
      if (available < topUp) {
        throw new Error("Perps margin is insufficient and the wallet's existing USDso collateral balance (" +
          walletCollateralBefore + ") is below the small " + TOPUP_USDSO +
          " USDso top-up needed for this minimum-size test order. No transaction was sent.");
      }
      console.log("The order-size gate says collateral, so using existing wallet USDso to fund Perps margin.");
      console.log("Wallet USDso before: " + walletCollateralBefore);
      console.log("Depositing only " + TOPUP_USDSO + " USDso into the Perps MarginBank; the voucher claim is skipped.");
      const deposited = await exchange.trader.depositMargin({
        marginBank,
        collateral: collateralToken,
        amount: topUp,
        autoApprove: true,
        gas: GAS_LIMIT,
      });
      depositTransaction = txHash(deposited);
      await wait(1_500);
      marginAfter = typeof exchange.client.getMarginAccount === "function"
        ? await exchange.client.getMarginAccount(marginBank, account.address)
        : { note: "SDK getMarginAccount not available; using order-size preflight." };
      const afterWallet = await publicClient.readContract({
        address: collateralToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      });
      walletCollateralAfter = formatUnits(afterWallet, quoteDecimals);
      max = await checkSize();
      console.log("Deposit transaction: " + (depositTransaction ?? "SDK result did not expose a transaction hash"));
      console.log("Wallet USDso after: " + walletCollateralAfter);
      console.log("Margin account after deposit: " + stringify(summaryMargin(marginAfter)));
      console.log("Order-size gate after deposit: " + stringify({
        priceable: max.priceable,
        placeable: max.placeable,
        maxQuantity: max.maxQuantity,
        limitedBy: max.limitedBy,
      }));
    } else {
      walletCollateralAfter = walletCollateralBefore;
      marginAfter = marginBefore;
    }

    if (!max.priceable) throw new Error("Mark-price preflight failed after funding.");
    if (!max.placeable || quantity > asBigInt(max.maxQuantity, "maximum order size")) {
      throw new Error("Protocol still refuses the bounded order after funding: limitedBy=" +
        String(max.limitedBy) + ", maxQuantity=" + String(max.maxQuantity) + ".");
    }

    const openExpiryNs = BigInt(Math.floor(Date.now() / 1000) + 60 * 60) * 1_000_000_000n;
    orderPrice = formatUnits(price, quoteDecimals);
    orderQuantity = formatUnits(quantity, baseDecimals);
    console.log("FUNDED PERPS TESTNET ORDER LIFECYCLE");
    console.log("Network: Somnia Hideki testnet (chain 50383)");
    console.log("Account: " + account.address);
    console.log("Market / side: " + marketSymbol + " / " + side);
    console.log("Spot USDso balance before funding Perps: " + walletCollateralBefore);
    console.log("Limit price: " + orderPrice);
    console.log("Quantity: " + orderQuantity);
    console.log("Hard-capped notional: " + actualNotional.toFixed(4) + " paper USDso (max 15).");

    const { request } = await publicClient.simulateContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "placeOrder",
      args: [isBid, 0n, price, quantity, openExpiryNs, ORDER_TYPE.POST_ONLY, 0, zeroAddress, 0n],
      account,
      gas: GAS_LIMIT,
    });
    const orderHash = await walletClient.writeContract(request as never);
    placementTransaction = orderHash;
    const orderReceipt = await publicClient.waitForTransactionReceipt({ hash: orderHash });
    if (orderReceipt.status !== "success") throw new Error("Order transaction reverted: " + orderHash);
    const decoded = decodePlaceOrder(orderReceipt, poolAddress);
    orderIdText = decoded.orderId === undefined ? null : String(decoded.orderId);
    filledCount = (decoded.fills ?? []).length;
    if (!orderIdText) throw new Error("Order succeeded but the order ID did not decode; inspect " + orderHash + ".");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const open = await exchange.fetchOpenOrders(marketSymbol);
      orderVisibleAfterPlacement = open.some((row: any) => String(row.id) === orderIdText);
      if (orderVisibleAfterPlacement) break;
      await wait(1_200);
    }

    if (filledCount === 0) {
      const { request: cancelRequest } = await publicClient.simulateContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "cancelOrder",
        args: [BigInt(orderIdText)],
        account,
        gas: GAS_LIMIT,
      });
      const cancelHash = await walletClient.writeContract(cancelRequest as never);
      cancellationTransaction = cancelHash;
      const cancelReceipt = await publicClient.waitForTransactionReceipt({ hash: cancelHash });
      if (cancelReceipt.status !== "success") throw new Error("Cancellation transaction reverted: " + cancelHash);
    } else {
      throw new Error("Safety alert: the POST_ONLY receipt contains " + filledCount + " fill(s). Position/order state needs review.");
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const open = await exchange.fetchOpenOrders(marketSymbol);
      orderAbsentAfterCancellation = !open.some((row: any) => String(row.id) === orderIdText);
      if (orderAbsentAfterCancellation) break;
      await wait(1_200);
    }
    if (!orderVisibleAfterPlacement || !orderAbsentAfterCancellation) {
      throw new Error("Transactions landed but the indexer did not prove order visibility and cancellation.");
    }
    console.log("Placement transaction: " + placementTransaction);
    console.log("Cancellation transaction: " + cancellationTransaction);
    console.log("Order ID: " + orderIdText);
    console.log("Visible after placement: true; absent after cancellation: true; fills: 0.");
    console.log("FUNDED PERPS ORDER E2E PASSED.");
  } catch (error) {
    failure = error instanceof Error ? error.message : "Unknown failure";
    console.error("FUNDED PERPS E2E FAILED:", failure);
    if (placementTransaction && orderIdText && !cancellationTransaction && poolAddress) {
      try {
        const { request: cancelRequest } = await publicClient.simulateContract({
          address: poolAddress,
          abi: poolAbi,
          functionName: "cancelOrder",
          args: [BigInt(orderIdText)],
          account,
          gas: GAS_LIMIT,
        });
        const cleanupHash = await walletClient.writeContract(cancelRequest as never);
        const cleanupReceipt = await publicClient.waitForTransactionReceipt({ hash: cleanupHash });
        if (cleanupReceipt.status === "success") {
          cancellationTransaction = cleanupHash;
          console.error("Safety cleanup submitted successfully; cancellation tx:", cleanupHash);
        } else {
          console.error("URGENT: safety-cleanup cancellation receipt reverted:", cleanupHash);
        }
      } catch (cleanupError) {
        console.error("URGENT: could not auto-cancel the test order. Inspect the wallet's BTC Perps open orders. Reason:",
          cleanupError instanceof Error ? cleanupError.message : "unknown cleanup error");
      }
    }
    throw error;
  } finally {
    const receipt = {
      product: "Perps Stress Lab",
      recordedAt: new Date().toISOString(),
      network: { name: "Somnia Hideki testnet", chainId: 50383 },
      account: account.address,
      market: marketSymbol,
      side,
      collateral: {
        token: collateralToken,
        walletBalanceBefore: walletCollateralBefore,
        walletBalanceAfter: walletCollateralAfter,
        marginBefore: summaryMargin(marginBefore),
        marginAfter: summaryMargin(marginAfter),
        intendedTopUpUsdso: TOPUP_USDSO,
        depositTransaction,
      },
      targetNotionalUsdso: TARGET_NOTIONAL_USDSO,
      minNotionalUsdso: MIN_NOTIONAL_USDSO,
      maxNotionalUsdso: MAX_NOTIONAL_USDSO,
      orderPrice: orderPrice || null,
      orderQuantity: orderQuantity || null,
      actualNotionalUsdso: actualNotional || null,
      placementTransaction,
      cancellationTransaction,
      orderId: orderIdText,
      filledCount,
      verification: {
        orderVisibleAfterPlacement,
        orderAbsentAfterCancellation,
        verified: Boolean(placementTransaction && cancellationTransaction && orderIdText && filledCount === 0 && orderVisibleAfterPlacement && orderAbsentAfterCancellation && !failure),
      },
      error: failure,
      note: "Hideki testnet only. Paper USDso is not real money. Only the private key configured as GitHub Actions wallet_key was used; the key is never printed or stored in the receipt.",
    };
    writeFileSync(receiptPath, stringify(receipt) + "\n", { mode: 0o600 });
    try { await exchange.close?.(); } catch { /* Preserve receipt. */ }
  }
}

main().catch((error: unknown) => {
  console.error("FUNDED PERPS E2E TERMINATED:", error instanceof Error ? error.message : "Unknown failure");
  process.exitCode = 1;
});
