import { mkdirSync, writeFileSync } from "node:fs";
import {
  ORDER_TYPE,
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
  decodePlaceOrder,
  contractErrorsAbi,
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
const MAX_NOTIONAL_USDSO = 15;
const PLACE_SELECTOR = "0x80054449" as const;
const CANCEL_SELECTOR = "0xe37b444b" as const;
const GAS_LIMIT = 10_000_000n;

const poolAbi = [
  ...parseAbi([
    "function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)",
    "function cancelOrder(uint128 orderId)",
  ]),
  ...contractErrorsAbi,
] as const;

function asBigInt(value: unknown, label: string): bigint {
  try {
    return typeof value === "bigint" ? value : BigInt(String(value));
  } catch {
    throw new Error(`Market returned an invalid ${label}.`);
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

function extractRevertSelector(error: unknown): string | null {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let depth = 0; queue.length && depth < 80; depth += 1) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    if (typeof current === "string") {
      const matches = current.match(/0x[0-9a-fA-F]{8,}/g);
      if (matches?.length) {
        const known = matches.find((value) => value.slice(0, 10).toLowerCase() === "0x3e31dcc2");
        return (known ?? matches[0]).slice(0, 10).toLowerCase();
      }
      continue;
    }
    if (typeof current !== "object") continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    for (const key of ["data", "cause", "error", "details", "shortMessage", "message", "raw", "metaMessages"]) {
      if (key in record) queue.push(record[key]);
    }
  }
  return null;
}

async function preflightVoucherClaim(
  publicClient: ReturnType<typeof createPublicClient>,
  distributor: `0x${string}`,
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<void> {
  try {
    await publicClient.simulateContract({
      address: distributor,
      abi: parseAbi(["function claim()"]),
      functionName: "claim",
      account,
      gas: 1_000_000n,
    });
  } catch (error) {
    const selector = extractRevertSelector(error);
    if (selector === "0x3e31dcc2") {
      throw new Error(
        "Known Hideki VoucherDistributor blocker: read-only eth_call of claim() reverted with 0x3e31dcc2, despite SDK eligibility=true. " +
        "No transaction was broadcast. This is a contract-side/SDK-preflight mismatch; an operator must fix the distributor configuration or issue the paper-USDso credit before order E2E can continue.",
      );
    }
    throw new Error(
      `VoucherDistributor read-only claim preflight reverted${selector ? ` with ${selector}` : " with an undecoded error"}. ` +
      "No transaction was broadcast; investigate this result before trying the SDK claim.",
    );
  }
}

async function main(): Promise<void> {
  if (process.env.CONFIRM_LIVE_TEST_ORDER !== "YES") {
    throw new Error("Safety stop: set the manual workflow confirmation to YES before any transaction can be sent.");
  }
  const rawKey = process.env.WALLET_KEY?.trim();
  if (!rawKey) throw new Error("Missing Actions secret wallet_key.");
  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("wallet_key must be a 32-byte EVM private key. The value was not printed.");
  }

  const account = privateKeyToAccount(privateKey);
  const side = process.env.SMOKE_SIDE === "short" ? "short" : "long";
  const isBid = side === "long";
  const exchange = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    privateKey,
  } as never);
  const publicClient = createPublicClient({ chain: hidekiTestnet, transport: http(RPC_URL, { timeout: 20_000 }) });
  const walletClient = createWalletClient({ account, chain: hidekiTestnet, transport: http(RPC_URL, { timeout: 20_000 }) });

  let claimTxHash: string | null = null;
  let placementTxHash: string | null = null;
  let cancellationTxHash: string | null = null;
  let orderIdText: string | null = null;
  let orderVisibleAfterPlacement = false;
  let orderAbsentAfterCancellation = false;
  let filledCount = 0;
  let marketSymbol = "BTC-PERP";
  let orderPrice = "";
  let orderQuantity = "";
  let actualNotional = 0;
  let failure: string | null = null;
  let poolAddress: `0x${string}` | null = null;

  const receiptPath = "artifacts/perps-stress-lab-order-smoke.json";
  mkdirSync("artifacts", { recursive: true });

  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== 50383) throw new Error(`Safety stop: expected Hideki chain 50383, received ${chainId}.`);

    const rows = await exchange.client.listPerpMarkets() as any[];
    const market = rows.find((row) => String(row.baseSymbol).toUpperCase() === "BTC");
    if (!market) throw new Error("BTC Perps market was not returned. No transaction was sent.");
    poolAddress = market.poolAddress as `0x${string}`;
    const baseDecimals = Number(market.baseDecimals);
    const quoteDecimals = Number(market.quoteDecimals);
    const tickSize = asBigInt(market.tickSize, "tick size");
    const lotSize = asBigInt(market.lotSize, "lot size");
    const minQuantity = asBigInt(market.minQuantity, "minimum quantity");
    marketSymbol = "BTC-PERP";

    const eligibility = await exchange.client.getPerpVoucherEligibility(market.marginBank, account.address);
    if (eligibility.eligible) {
      const campaign = await exchange.client.getPerpVoucherCampaign(market.marginBank);
      if (!campaign) throw new Error("Voucher eligibility was true but no live campaign was resolved; stopping before any transaction.");
      const voucherState = await exchange.client.getPerpVoucher(market.marginBank, account.address);
      if (voucherState?.claimed) throw new Error("The current account is already marked as having claimed this voucher; stopping before any transaction.");
      console.log("Perps voucher is eligible according to the SDK. Preflighting the distributor's claim() with read-only eth_call before allowing any write.");
      console.log("Using the exact distributor resolved from the live campaign; the account remains on Hideki testnet.");
      await preflightVoucherClaim(publicClient, campaign.distributor as `0x${string}`, account);
      console.log("Voucher claim preflight passed. Only now may the explicitly confirmed SDK claim be attempted.");
      let claimResult;
      try {
        claimResult = await exchange.trader.claimPerpVoucher({ distributor: campaign.distributor });
      } catch (claimError) {
        const safeDetails: Record<string, unknown> = {};
        let current: any = claimError;
        for (let depth = 0; depth < 4 && current; depth += 1) {
          for (const key of ["name", "message", "shortMessage", "code", "data", "transactionHash", "hash"]) {
            const value = current[key];
            if ((typeof value === "string" || typeof value === "number") && value !== "") {
              safeDetails[`cause${depth}_${key}`] = value;
            }
          }
          current = current.cause;
        }
        console.error("Voucher claim structured error (no key material):", stringify(safeDetails));
        throw claimError;
      }
      const possibleHash = typeof claimResult === "string"
        ? claimResult
        : (claimResult as { transactionHash?: string; hash?: string } | null)?.transactionHash
          ?? (claimResult as { hash?: string } | null)?.hash;
      if (possibleHash) claimTxHash = possibleHash;
      await wait(2_500);
    } else {
      console.log("Voucher is not eligible; continuing only if the SDK confirms sufficient existing Perps collateral.");
    }

    const unifiedMarkets = await exchange.loadMarkets();
    const sdkMarket = Object.values(unifiedMarkets).find((row: any) =>
      row.type === "swap" &&
      String(row.base ?? row.info?.baseSymbol ?? "").toUpperCase() === "BTC" &&
      String(row.quote ?? row.info?.quoteSymbol ?? "").toUpperCase() === String(market.quoteSymbol).toUpperCase()
    ) as any;
    if (!sdkMarket?.symbol) throw new Error("The SDK did not resolve BTC Perps to a readable order book.");
    // Use the SDK-resolved symbol for order read-back. The raw market row may
    // not share the exchange adapter unified symbol format.
    marketSymbol = String(sdkMarket.symbol);

    const book = await exchange.fetchOrderBook(sdkMarket.symbol, 1);
    const top = Number(isBid ? book.bids?.[0]?.[0] : book.asks?.[0]?.[0]);
    if (!Number.isFinite(top) || top <= 0) throw new Error("The BTC order book has no valid top quote. No order was sent.");

    const rawTop = parseUnits(String(top), quoteDecimals);
    const targetPrice = isBid ? (rawTop * 9_990n) / 10_000n : (rawTop * 10_010n) / 10_000n;
    const price = isBid ? alignDown(targetPrice, tickSize) : alignUp(targetPrice, tickSize);
    if (price <= 0n) throw new Error("Computed post-only limit price is invalid.");

    const targetNotional = parseUnits(String(TARGET_NOTIONAL_USDSO), quoteDecimals);
    const wantedQuantity = (targetNotional * (10n ** BigInt(baseDecimals))) / price;
    let quantity = alignDown(wantedQuantity, lotSize);
    if (quantity < minQuantity) quantity = minQuantity;

    const max = await exchange.client.getMaxPerpOrderSize({
      pool: market.poolAddress,
      marginBank: market.marginBank,
      account: account.address,
      isBid,
      price,
    });
    if (!max.priceable) throw new Error("The market mark is stale/unpriceable. No order was sent.");
    if (!max.placeable) throw new Error(`The protocol still blocks placement: ${String(max.limitedBy)}. No order was sent.`);
    const maxQuantity = asBigInt(max.maxQuantity, "maximum order size");
    if (quantity > maxQuantity) quantity = alignDown(maxQuantity, lotSize);
    if (quantity < minQuantity) throw new Error("The account's allowed size is below the market minimum. No order was sent.");

    const notionalRaw = (quantity * price) / (10n ** BigInt(baseDecimals));
    actualNotional = Number(formatUnits(notionalRaw, quoteDecimals));
    if (!Number.isFinite(actualNotional) || actualNotional < 10 || actualNotional > MAX_NOTIONAL_USDSO) {
      throw new Error(`Safety stop: computed notional ${actualNotional.toFixed(4)} USDso is outside the fixed 10–${MAX_NOTIONAL_USDSO} USDso range. No order was sent.`);
    }
    orderPrice = formatUnits(price, quoteDecimals);
    orderQuantity = formatUnits(quantity, baseDecimals);

    console.log("LIVE TESTNET ORDER LIFECYCLE");
    console.log("Network: Somnia Hideki testnet (chain ID 50383)");
    console.log(`Account: ${account.address}`);
    console.log(`Market / side: ${marketSymbol} / ${side}`);
    console.log("Order type: POST_ONLY limit; price is set 0.1% away from the current top of book.");
    console.log(`Limit price: ${orderPrice} USDso`);
    console.log(`Quantity: ${orderQuantity} BTC`);
    console.log(`Hard-capped notional: ${actualNotional.toFixed(4)} paper USDso (maximum ${MAX_NOTIONAL_USDSO}).`);

    const expiryNs = BigInt(Math.floor(Date.now() / 1000) + 50 * 365 * 24 * 60 * 60) * 1_000_000_000n;
    const { request } = await publicClient.simulateContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "placeOrder",
      args: [isBid, 0n, price, quantity, expiryNs, ORDER_TYPE.POST_ONLY, 0, zeroAddress, 0n],
      account,
      gas: GAS_LIMIT,
    });
    const orderHash = await walletClient.writeContract(request as never);
    placementTxHash = orderHash;
    const orderReceipt = await publicClient.waitForTransactionReceipt({ hash: orderHash });
    if (orderReceipt.status !== "success") throw new Error(`Order transaction reverted: ${orderHash}`);

    const decoded = decodePlaceOrder(orderReceipt, poolAddress);
    orderIdText = decoded.orderId === undefined ? null : String(decoded.orderId);
    filledCount = (decoded.fills ?? []).length;
    if (!orderIdText) throw new Error(`Order transaction succeeded but no order ID could be decoded. Inspect transaction ${orderHash} before retrying.`);
    if (filledCount > 0) throw new Error(`Safety alert: POST_ONLY reported ${filledCount} fill(s). Inspect the position before doing anything else.`);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const open = await exchange.fetchOpenOrders(marketSymbol);
      orderVisibleAfterPlacement = open.some((order: any) => String(order.id) === orderIdText);
      if (orderVisibleAfterPlacement) break;
      await wait(1_500);
    }

    const { request: cancelRequest } = await publicClient.simulateContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "cancelOrder",
      args: [BigInt(orderIdText)],
      account,
      gas: GAS_LIMIT,
    });
    const cancelHash = await walletClient.writeContract(cancelRequest as never);
    cancellationTxHash = cancelHash;
    const cancelReceipt = await publicClient.waitForTransactionReceipt({ hash: cancelHash });
    if (cancelReceipt.status !== "success") throw new Error(`Cancellation reverted; inspect the account's open orders now. Transaction: ${cancelHash}`);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const open = await exchange.fetchOpenOrders(marketSymbol);
      orderAbsentAfterCancellation = !open.some((order: any) => String(order.id) === orderIdText);
      if (orderAbsentAfterCancellation) break;
      await wait(1_500);
    }
    if (!orderVisibleAfterPlacement || !orderAbsentAfterCancellation) {
      throw new Error("Transactions succeeded but indexer read-back did not prove both order visibility and cancellation.");
    }
    console.log(`Placement transaction: ${placementTxHash}`);
    console.log(`Cancellation transaction: ${cancellationTxHash}`);
    console.log("Order visible after placement: true");
    console.log("Order absent after cancellation: true");
    console.log("LIVE ORDER SMOKE TEST PASSED.");
  } catch (error) {
    failure = error instanceof Error ? error.message : "Unknown failure";
    if (placementTxHash && orderIdText && !cancellationTxHash && poolAddress) {
      try {
        const { request } = await publicClient.simulateContract({
          address: poolAddress,
          abi: poolAbi,
          functionName: "cancelOrder",
          args: [BigInt(orderIdText)],
          account,
          gas: GAS_LIMIT,
        });
        const hash = await walletClient.writeContract(request as never);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === "success") cancellationTxHash = hash;
      } catch (cleanupError) {
        console.error("EMERGENCY CANCEL FAILED. Inspect the BTC Perps account's open orders immediately:", cleanupError instanceof Error ? cleanupError.message : "unknown cleanup error");
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
      orderType: "POST_ONLY",
      targetNotionalUsdso: TARGET_NOTIONAL_USDSO,
      maxNotionalUsdso: MAX_NOTIONAL_USDSO,
      orderPrice: orderPrice || null,
      orderQuantity: orderQuantity || null,
      actualNotionalUsdso: actualNotional || null,
      voucherClaimTransaction: claimTxHash,
      placementTransaction: placementTxHash,
      cancellationTransaction: cancellationTxHash,
      orderId: orderIdText,
      filledCount,
      verification: {
        orderVisibleAfterPlacement,
        orderAbsentAfterCancellation,
        verified: Boolean(placementTxHash && cancellationTxHash && orderIdText && filledCount === 0 && orderVisibleAfterPlacement && orderAbsentAfterCancellation && !failure),
      },
      error: failure,
      note: "Testnet only. Paper USDso is not real money. No private key is written to this receipt.",
    };
    writeFileSync(receiptPath, stringify(receipt) + "\n", { mode: 0o600 });
    try { await exchange.close?.(); } catch { /* Preserve the receipt. */ }
  }
}

main().catch((error: unknown) => {
  console.error("TESTNET ORDER SMOKE FAILED:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
