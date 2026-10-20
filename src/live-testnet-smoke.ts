import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = "https://api.hideki2.infra.testnet.somnia.network";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";
const INDEXER_URL = process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const PLACE_SELECTOR = "0x80054449" as const;
const CANCEL_SELECTOR = "0xe37b444b" as const;
const MAX_NOTIONAL_USDSO = 25;
const GAS_LIMIT = 10_000_000n;

const poolAbi = [
  ...parseAbi([
    "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
    "function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)",
    "function cancelOrderFor(address owner, uint128 orderId)",
  ]),
  ...contractErrorsAbi,
] as const;

type Side = "long" | "short";
type Receipt = {
  status: string;
  hash: string;
  blockNumber: string;
};

function asBigInt(value: unknown, label: string): bigint {
  try {
    return BigInt(value as string | number | bigint);
  } catch {
    throw new Error(`The SDK returned an unreadable ${label}; refusing to submit an order.`);
  }
}

function alignDown(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new Error("Market lot/tick size was zero or invalid.");
  return (value / step) * step;
}

function alignUp(value: bigint, step: bigint): bigint {
  if (step <= 0n) throw new Error("Market lot/tick size was zero or invalid.");
  return ((value + step - 1n) / step) * step;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function main(): Promise<void> {
  const receiptPath = resolve("artifacts/live-testnet-smoke.json");
  mkdirSync("artifacts", { recursive: true });

  const confirmed = process.env.CONFIRM_LIVE_TEST_ORDER === "YES";
  if (!confirmed) {
    throw new Error("Safety stop: set CONFIRM_LIVE_TEST_ORDER=YES through the manual GitHub Actions workflow.");
  }

  const privateKey = (process.env.TESTNET_BOT_PRIVATE_KEY ?? "").trim();
  const ownerRaw = (process.env.TESTNET_OWNER_ADDRESS ?? "").trim();
  const baseSymbol = (process.env.SMOKE_SYMBOL ?? "BTC").trim().toUpperCase();
  const side = ((process.env.SMOKE_SIDE ?? "long").trim().toLowerCase() === "short" ? "short" : "long") as Side;
  const notional = Number(process.env.SMOKE_NOTIONAL_USDSO ?? "20");

  if (!privateKey) throw new Error("Missing GitHub secret TESTNET_BOT_PRIVATE_KEY.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(ownerRaw)) {
    throw new Error("Missing or invalid TESTNET_OWNER_ADDRESS. Use the public address of the testnet DreamDEX account.");
  }
  if (!Number.isFinite(notional) || notional < 10 || notional > MAX_NOTIONAL_USDSO) {
    throw new Error(`Safety stop: notional must be between 10 and ${MAX_NOTIONAL_USDSO} paper USDso.`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("TESTNET_BOT_PRIVATE_KEY is not a 32-byte EVM private key. The value was not printed.");
  }

  const owner = ownerRaw as `0x${string}`;
  const botAccount = privateKeyToAccount(privateKey as `0x${string}`);
  if (botAccount.address.toLowerCase() === owner.toLowerCase()) {
    throw new Error("Safety stop: the bot key and owner address must be different. Never use the account's main private key as the bot key.");
  }

  // The bot key signs only testnet operator calls. It must first be linked to
  // this owner in the DreamDEX app. The key cannot withdraw the owner's funds.
  const exchange = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: INDEXER_URL,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    account: owner,
  } as never);

  const publicClient = createPublicClient({ chain: hidekiTestnet, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account: botAccount, chain: hidekiTestnet, transport: http(RPC_URL) });

  let placementReceipt: Receipt | undefined;
  let cancellationReceipt: Receipt | undefined;
  let orderIdText: string | undefined;
  let visibleAfterPlacement = false;
  let absentAfterCancellation = false;
  let errorText: string | undefined;

  try {
    const markets = await exchange.client.listPerpMarkets();
    const market = markets.find((row: any) => String(row.baseSymbol).toUpperCase() === baseSymbol) as any;
    if (!market) {
      throw new Error(`Market ${baseSymbol} is not in the live testnet list. No transaction was sent.`);
    }

    const pool = market.poolAddress as `0x${string}`;
    const baseDecimals = Number(market.baseDecimals);
    const quoteDecimals = Number(market.quoteDecimals);
    const tickSize = asBigInt(market.tickSize, "tick size");
    const lotSize = asBigInt(market.lotSize, "lot size");
    const minQuantity = asBigInt(market.minQuantity, "minimum quantity");

    const [mayPlace, mayCancel] = await Promise.all([
      publicClient.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "isOperatorAuthorized",
        args: [owner, botAccount.address, PLACE_SELECTOR],
      }),
      publicClient.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "isOperatorAuthorized",
        args: [owner, botAccount.address, CANCEL_SELECTOR],
      }),
    ]);
    if (!mayPlace || !mayCancel) {
      throw new Error(
        "This bot key is not linked for placing and cancelling orders on this market. " +
        "Open the testnet app, select the correct wallet, choose Link a bot, enable Perps, and add this bot address: " +
        botAccount.address,
      );
    }

    // Use the SDK/CCXT market symbol, not the UI alias BTC-PERP. The official
    // unified symbol is typically BTC/USDso:USDso; using the UI alias here can
    // make the book request fail before a safe test is possible.
    const unifiedMarkets = await exchange.loadMarkets();
    const unifiedMarket = Object.values(unifiedMarkets).find((row: any) =>
      row.type === "swap" &&
      String(row.base ?? row.info?.baseSymbol ?? "").toUpperCase() === baseSymbol
    ) as any;
    if (!unifiedMarket?.symbol) {
      throw new Error(`No active SDK swap symbol was found for ${baseSymbol}. No transaction was sent.`);
    }

    // Use a limit price away from the opposing side, and POST_ONLY so this
    // smoke test should rest rather than opening a position. If the book moves
    // and the order would cross, the protocol must reject it instead of filling.
    const book = await exchange.fetchOrderBook(unifiedMarket.symbol, 5);
    const top = side === "long" ? book.bids[0]?.[0] : book.asks[0]?.[0];
    if (top === undefined || !(Number(top) > 0)) {
      throw new Error(`The ${baseSymbol} book has no suitable top-of-book quote. No transaction was sent.`);
    }

    const rawTop = parseUnits(String(top), quoteDecimals);
    const target = side === "long" ? (rawTop * 9_990n) / 10_000n : (rawTop * 10_010n) / 10_000n;
    const price = side === "long" ? alignDown(target, tickSize) : alignUp(target, tickSize);
    if (price <= 0n) throw new Error("Computed limit price is invalid; no transaction was sent.");

    const targetNotional = parseUnits(String(notional), quoteDecimals);
    const quantityWanted = (targetNotional * (10n ** BigInt(baseDecimals))) / price;
    const quantityByLot = alignDown(quantityWanted, lotSize);
    if (quantityByLot < minQuantity) {
      const minQtyHuman = Number(formatUnits(minQuantity, baseDecimals));
      const priceHuman = Number(formatUnits(price, quoteDecimals));
      const minNotional = minQtyHuman * priceHuman;
      throw new Error(
        `Safety stop: ${baseSymbol} minimum size is about ${minNotional.toFixed(2)} USDso, above the ${notional.toFixed(2)} USDso cap. ` +
        "No order was sent. Do not raise the cap without reviewing the new size first.",
      );
    }

    const max = await exchange.client.getMaxPerpOrderSize({
      pool,
      marginBank: market.marginBank,
      account: owner,
      isBid: side === "long",
      price,
      autoPull: false,
    });
    if (!max.priceable) throw new Error("The market mark is stale/unpriceable. No order was sent.");
    if (!max.placeable) {
      throw new Error(`The protocol says this order cannot be placed: ${String(max.limitedBy)}. No order was sent.`);
    }

    const quantity = alignDown(
      quantityByLot < asBigInt(max.maxQuantity, "maximum order size") ? quantityByLot : asBigInt(max.maxQuantity, "maximum order size"),
      lotSize,
    );
    if (quantity < minQuantity) {
      throw new Error("The account's live size limit is below the minimum market size. No order was sent.");
    }

    const actualNotionalRaw = (quantity * price) / (10n ** BigInt(baseDecimals));
    const actualNotional = Number(formatUnits(actualNotionalRaw, quoteDecimals));
    if (actualNotional > MAX_NOTIONAL_USDSO + 0.001) {
      throw new Error("Safety stop: calculated order exceeds the hard notional cap. No order was sent.");
    }

    console.log(`Network: Hideki testnet, chain 50383`);
    console.log(`SDK version: 0.32.1`);
    console.log(`Owner account: ${owner}`);
    console.log(`Bot public address: ${botAccount.address}`);
    console.log(`Market: ${baseSymbol}-PERP | side: ${side}`);
    console.log(`Order type: POST_ONLY limit | limit price: ${formatUnits(price, quoteDecimals)}`);
    console.log(`Quantity: ${formatUnits(quantity, baseDecimals)} ${baseSymbol}`);
    console.log(`Maximum planned notional: ${actualNotional.toFixed(4)} paper USDso`);
    console.log("Live transaction approval: explicitly enabled by the manual GitHub Actions input.");

    const expiryNs = BigInt(Math.floor(Date.now() / 1000) + 50 * 365 * 24 * 60 * 60) * 1_000_000_000n;
    const { request } = await publicClient.simulateContract({
      address: pool,
      abi: poolAbi,
      functionName: "placeOrderFor",
      args: [
        owner,
        side === "long",
        0n,
        price,
        quantity,
        expiryNs,
        ORDER_TYPE.POST_ONLY,
        0,
        zeroAddress,
        0n,
      ],
      account: botAccount,
      gas: GAS_LIMIT,
    });
    const orderHash = await walletClient.writeContract(request as never);
    const orderReceipt = await publicClient.waitForTransactionReceipt({ hash: orderHash });
    if (orderReceipt.status !== "success") {
      throw new Error(`Order transaction reverted: ${orderHash}`);
    }
    placementReceipt = {
      status: String(orderReceipt.status),
      hash: orderHash,
      blockNumber: String(orderReceipt.blockNumber),
    };

    const decoded = decodePlaceOrder(orderReceipt, pool);
    orderIdText = decoded.orderId === undefined ? undefined : String(decoded.orderId);
    if (!orderIdText) {
      throw new Error(`Order transaction succeeded but the SDK could not decode an order ID. Transaction: ${orderHash}`);
    }
    const fills = (decoded.fills ?? []).length;
    if (fills > 0) {
      throw new Error(
        `Safety alert: a POST_ONLY smoke order unexpectedly reported ${fills} fill(s). Do not repeat the test; inspect position state. Transaction: ${orderHash}`,
      );
    }

    // Wait for the indexer to show the new resting order before cancelling it.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const open = await exchange.fetchOpenOrders(`${baseSymbol}-PERP`);
      visibleAfterPlacement = open.some((order: any) => String(order.id) === orderIdText);
      if (visibleAfterPlacement) break;
      await delay(1_500);
    }

    // Cancel even if the indexer is slow. A successful create should not leave
    // an unintended order resting after the smoke test.
    const { request: cancelRequest } = await publicClient.simulateContract({
      address: pool,
      abi: poolAbi,
      functionName: "cancelOrderFor",
      args: [owner, BigInt(orderIdText)],
      account: botAccount,
      gas: GAS_LIMIT,
    });
    const cancelHash = await walletClient.writeContract(cancelRequest as never);
    const cancelReceipt = await publicClient.waitForTransactionReceipt({ hash: cancelHash });
    if (cancelReceipt.status !== "success") {
      throw new Error(`Cancel transaction reverted. The order may still be open. Inspect it now: ${cancelHash}`);
    }
    cancellationReceipt = {
      status: String(cancelReceipt.status),
      hash: cancelHash,
      blockNumber: String(cancelReceipt.blockNumber),
    };

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const open = await exchange.fetchOpenOrders(`${baseSymbol}-PERP`);
      absentAfterCancellation = !open.some((order: any) => String(order.id) === orderIdText);
      if (absentAfterCancellation) break;
      await delay(1_500);
    }

    const record = {
      product: "OrderProof",
      recordedAt: new Date().toISOString(),
      sdkVersion: "0.32.1",
      network: { name: "Somnia Hideki / Tokyo testnet", chainId: 50383 },
      account: { owner, botAddress: botAccount.address },
      order: {
        market: `${baseSymbol}-PERP`,
        side,
        type: "POST_ONLY",
        price: formatUnits(price, quoteDecimals),
        quantity: formatUnits(quantity, baseDecimals),
        notionalPaperUsdso: actualNotional.toFixed(8),
        orderId: orderIdText,
        filledOrdersReportedBySdk: fills,
      },
      placement: placementReceipt,
      cancellation: cancellationReceipt,
      verification: {
        restingOrderWasVisibleAfterPlacement: visibleAfterPlacement,
        restingOrderWasAbsentAfterCancellation: absentAfterCancellation,
        verified: visibleAfterPlacement && absentAfterCancellation && fills === 0,
      },
      notes: [
        "Uses testnet only (chain 50383); no mainnet RPC is configured.",
        "POST_ONLY was selected so a successful smoke test should rest and not take liquidity.",
        "The intended notional is paper USDso, which has no monetary value.",
        "An order receipt alone is not treated as proof that the indexer showed the order state.",
      ],
    };
    writeFileSync(receiptPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    console.log("");
    console.log(`Placement transaction: ${placementReceipt.hash}`);
    console.log(`Cancellation transaction: ${cancellationReceipt.hash}`);
    console.log(`Order appeared in open-order read-back: ${visibleAfterPlacement}`);
    console.log(`Order disappeared after cancellation: ${absentAfterCancellation}`);
    console.log(`Evidence receipt saved: ${receiptPath}`);

    if (!record.verification.verified) {
      throw new Error(
        "The transactions were sent, but indexer read-back did not prove the full order lifecycle. Check the saved receipt before repeating.",
      );
    }
    console.log("LIVE SMOKE TEST PASSED: placement, cancellation, and read-back checks passed.");
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error);

    // If placement succeeded but a later decode/read-back check failed, make
    // one best-effort cancellation attempt before exiting. Never knowingly
    // leave the smoke-test's resting order on the book because a verifier
    // failed. Keep the cleanup result in the evidence file.
    let emergencyCleanup: { hash: string; status: string } | undefined;
    let emergencyCleanupError: string | undefined;
    if (placementReceipt && orderIdText && !cancellationReceipt) {
      try {
        const poolForCleanup = (await exchange.client.listPerpMarkets() as any[])
          .find((row: any) => String(row.baseSymbol).toUpperCase() === baseSymbol)?.poolAddress as `0x${string}` | undefined;
        if (!poolForCleanup) throw new Error("Could not re-resolve the market pool for emergency cancellation.");
        const { request: emergencyRequest } = await publicClient.simulateContract({
          address: poolForCleanup,
          abi: poolAbi,
          functionName: "cancelOrderFor",
          args: [owner, BigInt(orderIdText)],
          account: botAccount,
          gas: GAS_LIMIT,
        });
        const emergencyHash = await walletClient.writeContract(emergencyRequest as never);
        const emergencyReceipt = await publicClient.waitForTransactionReceipt({ hash: emergencyHash });
        emergencyCleanup = { hash: emergencyHash, status: String(emergencyReceipt.status) };
        if (emergencyReceipt.status !== "success") {
          emergencyCleanupError = "Emergency cancellation transaction reverted. Check open orders in dreamDEX immediately.";
        } else {
          cancellationReceipt = {
            status: String(emergencyReceipt.status),
            hash: emergencyHash,
            blockNumber: String(emergencyReceipt.blockNumber),
          };
        }
      } catch (cleanupError) {
        emergencyCleanupError = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      }
    }

    const partialRecord = {
      product: "OrderProof",
      recordedAt: new Date().toISOString(),
      network: { name: "Somnia Hideki / Tokyo testnet", chainId: 50383 },
      placement: placementReceipt ?? null,
      cancellation: cancellationReceipt ?? null,
      orderId: orderIdText ?? null,
      emergencyCleanup: emergencyCleanup ?? null,
      emergencyCleanupError: emergencyCleanupError ?? null,
      verification: {
        restingOrderWasVisibleAfterPlacement: visibleAfterPlacement,
        restingOrderWasAbsentAfterCancellation: absentAfterCancellation,
        verified: visibleAfterPlacement && absentAfterCancellation,
      },
      error: errorText,
      note: "This is a failure receipt, not a successful verification claim.",
    };
    writeFileSync(receiptPath, JSON.stringify(partialRecord, null, 2) + "\n", { mode: 0o600 });
    throw error;
  } finally {
    try {
      await exchange.close?.();
    } catch {
      // Preserve the real transaction/test result if socket cleanup fails.
    }
    // Deliberately do not print privateKey or any full environment variable.
    void errorText;
  }
}

main().catch((error: unknown) => {
  console.error(`LIVE TESTNET SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
