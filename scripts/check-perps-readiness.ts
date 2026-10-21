import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, http, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rpcUrl = "https://api.hideki2.infra.testnet.somnia.network";
const indexerUrl = process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const wsRpcUrl = "wss://api.hideki2.infra.testnet.somnia.network/ws";

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

async function main(): Promise<void> {
  const rawKey = process.env.WALLET_KEY?.trim();
  if (!rawKey) throw new Error("WALLET_KEY is missing.");
  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("WALLET_KEY must be a 32-byte hex private key; it will not be printed.");

  const derivedAccount = privateKeyToAccount(privateKey);
  const exchange = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl,
    wsRpcUrl,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    privateKey,
  } as never);

  try {
    const publicClient = createPublicClient({ chain: hidekiTestnet, transport: http(rpcUrl, { timeout: 15_000 }) });
    const chainId = await publicClient.getChainId();
    if (chainId !== 50383) throw new Error(`Wrong chain ID: ${chainId}`);
    const rows = await exchange.client.listPerpMarkets() as any[];
    const btc = rows.find((row) => String(row.baseSymbol).toUpperCase() === "BTC");
    if (!btc) throw new Error("BTC Perps market was not returned by the live SDK.");

    const account = String(exchange.walletAddress ?? derivedAccount.address) as `0x${string}`;
    const eligibility = await exchange.client.getPerpVoucherEligibility(btc.marginBank, account);
    const campaign = await exchange.client.getPerpVoucherCampaign(btc.marginBank);
    const voucher = await exchange.client.getPerpVoucher(btc.marginBank, account);
    const sdkMarkets = await exchange.loadMarkets();
    const sdkMarket = Object.values(sdkMarkets).find((item: any) =>
      item.type === "swap" &&
      String(item.base ?? item.info?.baseSymbol ?? "").toUpperCase() === "BTC" &&
      String(item.quote ?? item.info?.quoteSymbol ?? "").toUpperCase() === String(btc.quoteSymbol).toUpperCase()
    ) as any;
    if (!sdkMarket?.symbol) throw new Error("The SDK could not resolve BTC Perps to an order book.");

    const book = await exchange.fetchOrderBook(sdkMarket.symbol, 1);
    const openOrders = await exchange.fetchOpenOrders(sdkMarket.symbol);
    let positions: unknown = "position read not available";
    try { positions = await exchange.fetchPositions([sdkMarket.symbol]); } catch (error) { positions = error instanceof Error ? error.message : "position read failed"; }
    const bid = Number(book.bids?.[0]?.[0]);
    if (!Number.isFinite(bid) || bid <= 0) throw new Error("The BTC order book did not return a valid best bid.");
    const quoteDecimals = Number(btc.quoteDecimals);
    const price = parseUnits(bid.toFixed(Math.min(quoteDecimals, 8)), quoteDecimals);
    const maxSize = await exchange.client.getMaxPerpOrderSize({
      pool: btc.poolAddress,
      marginBank: btc.marginBank,
      account,
      isBid: true,
      price,
    });

    console.log("READ-ONLY PERPS READINESS CHECK");
    console.log(`Network: Somnia Hideki testnet (chain ID ${chainId})`);
    console.log(`Derived EOA: ${derivedAccount.address}`);
    console.log(`SDK wallet address: ${String(exchange.walletAddress ?? "not exposed")}`);
    console.log(`Readiness account used: ${account}`);
    console.log(`Native balance check is handled by the separate wallet step.`);
    console.log(`Market: BTC (${sdkMarket.symbol})`);
    console.log(`Best bid: ${bid} USDso`);
    console.log("Open orders for BTC market:", openOrders.length);
    console.log("Position read:");
    console.log(json(positions));
    console.log("Voucher eligibility:");
    console.log(json(eligibility));
    console.log("Voucher campaign state:");
    console.log(json(campaign));
    console.log("Current account voucher state:");
    console.log(json(voucher));
    console.log("SDK max-order-size gate:");
    console.log(json({
      priceable: (maxSize as any).priceable,
      placeable: (maxSize as any).placeable,
      maxQuantity: (maxSize as any).maxQuantity,
      limitedBy: (maxSize as any).limitedBy,
    }));
    console.log("Transaction submitted: no");
    console.log("Private key printed or written to artifact: no");
  } finally {
    try { await exchange.close?.(); } catch { /* Preserve diagnostic output. */ }
  }
}

main().catch((error: unknown) => {
  console.error("PERPS READINESS CHECK FAILED:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
