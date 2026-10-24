import { mkdirSync, writeFileSync } from "node:fs";
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, formatEther, formatUnits, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = "https://api.hideki2.infra.testnet.somnia.network";
const INDEXER_URL = process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";
const EXPECTED = {
  marginBank: "0x478769e1177c0773c43a593dcc4ad15f15f1394",
  collateral: "0xed7993a74dae1e6656b704a424dcd8711aaf4f72",
  factory: "0xe631faee547baee07353e290f0562ea67d856560",
  liquidationEngine: "0xa66d3c24ad4a389d863846905d8173e1017e9f4d",
  insuranceFund: "0x50826894d47c6d4f3bea38bfdc7dc5c5be171b80",
} as const;
const ERC20_ABI = [{
  type: "function", name: "balanceOf", stateMutability: "view",
  inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }],
}] as const;

function clean(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}
function norm(value: unknown): string { return typeof value === "string" ? value.toLowerCase() : ""; }
function address(value: unknown, label: string): string {
  const result = norm(value);
  if (!/^0x[0-9a-f]{40}$/.test(result)) throw new Error("Missing/invalid " + label + " address in live SDK response.");
  return result;
}
function summaryPosition(p: Record<string, any>): Record<string, unknown> {
  return {
    symbol: p.symbol ?? p.info?.symbol ?? null,
    side: p.side ?? p.info?.side ?? null,
    contracts: p.contracts ?? p.info?.contracts ?? p.info?.quantity ?? null,
    entryPrice: p.entryPrice ?? p.info?.entryPrice ?? null,
    markPrice: p.markPrice ?? p.info?.markPrice ?? null,
    unrealizedPnl: p.unrealizedPnl ?? p.info?.unrealizedPnl ?? null,
  };
}
async function main(): Promise<void> {
  if (process.env.CONFIRM_READ_ONLY_LIQUIDATION_AUDIT !== "YES") {
    throw new Error("Safety stop: this workflow requires explicit YES to run the read-only audit.");
  }
  const rawKey = process.env.WALLET_KEY?.trim();
  if (!rawKey) throw new Error("Missing Actions secret wallet_key; key material will not be printed.");
  const privateKey = (rawKey.startsWith("0x") ? rawKey : "0x" + rawKey) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("wallet_key must be a 32-byte EVM private key; key material will not be printed.");
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: hidekiTestnet, transport: http(RPC_URL, { timeout: 20000 }) });
  // A signer is attached only so SDK account-scoped reads resolve this wallet.
  // This script never invokes a write method and never broadcasts a transaction.
  const exchange: any = new SomniaMarkets({
    chain: hidekiTestnet, indexerUrl: INDEXER_URL, wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, privateKey,
  } as never);
  const report: Record<string, any> = {
    test: "read-only liquidation preflight audit",
    recordedAt: new Date().toISOString(),
    network: { name: "Somnia Hideki testnet", expectedChainId: 50383 },
    transactionSubmitted: false,
    privateKeyPrintedOrStored: false,
    limitation: "This report observes account state and deployed bytecode presence only. It does not execute or prove liquidation behavior, and bytecode hashes do not identify verified source.",
  };
  mkdirSync("artifacts", { recursive: true });
  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== 50383) throw new Error("Wrong RPC chain ID: expected 50383, received " + chainId);
    const nativeBalance = await publicClient.getBalance({ address: account.address });
    const markets = await exchange.client.listPerpMarkets() as Array<Record<string, any>>;
    if (!markets.length) throw new Error("Live SDK returned no Perps markets.");
    const btc = markets.find((m) => String(m.baseSymbol ?? "").toUpperCase() === "BTC");
    if (!btc) throw new Error("BTC Perps market is missing from live SDK response.");
    const collateral = address(btc.quoteToken, "Perps USDso collateral");
    const [walletUsdsoRaw, positionsRaw] = await Promise.all([
      publicClient.readContract({ address: collateral as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
      exchange.fetchPositions(),
    ]);
    const positions = (Array.isArray(positionsRaw) ? positionsRaw : []).map((p: Record<string, any>) => summaryPosition(p));
    const uniqueBanks = [...new Set(markets.map((m) => address(m.marginBank, "market MarginBank")))];
    const marginAccounts: Record<string, unknown>[] = [];
    const systemConfigs: Record<string, unknown>[] = [];
    for (const bank of uniqueBanks) {
      const config = await exchange.client.getPerpSystemConfig(bank as `0x${string}`) as Record<string, any>;
      const margin = await exchange.client.getMarginAccount(bank as `0x${string}`, account.address) as Record<string, any>;
      marginAccounts.push({ marginBank: bank, account: clean(margin) });
      const actual = {
        collateral: address(config.collateral ?? config.collateralToken ?? config.collateralAddress ?? btc.quoteToken, "configured collateral"),
        factory: address(config.factory ?? config.perpPoolFactory, "configured factory"),
        liquidationEngine: address(config.liquidationEngine, "configured liquidation engine"),
        insuranceFund: address(config.insuranceFund, "configured insurance fund"),
      };
      systemConfigs.push({
        marginBank: bank,
        fullyWired: config.fullyWired ?? null,
        actual,
        publishedAddressesMatch: bank === EXPECTED.marginBank &&
          actual.collateral === EXPECTED.collateral && actual.factory === EXPECTED.factory &&
          actual.liquidationEngine === EXPECTED.liquidationEngine && actual.insuranceFund === EXPECTED.insuranceFund,
      });
    }
    const openOrders: Record<string, unknown>[] = [];
    const orderReadErrors: string[] = [];
    for (const market of markets) {
      const symbol = String(market.symbol ?? market.id ?? market.baseSymbol ?? "unknown");
      try {
        const orders = await exchange.fetchOpenOrders(market.symbol ?? symbol);
        if (Array.isArray(orders)) {
          for (const order of orders) openOrders.push({
            market: symbol,
            id: order.id ?? order.orderId ?? order.info?.orderId ?? null,
            side: order.side ?? null,
            type: order.type ?? null,
            price: order.price ?? null,
            amount: order.amount ?? order.remaining ?? null,
            status: order.status ?? null,
          });
        } else {
          orderReadErrors.push(symbol + ": SDK returned a non-array order result");
        }
      } catch (error) {
        orderReadErrors.push(symbol + ": " + (error instanceof Error ? error.message : "unknown read failure"));
      }
    }
    const contracts = [EXPECTED.marginBank, EXPECTED.factory, EXPECTED.liquidationEngine, EXPECTED.insuranceFund];
    const bytecode: Record<string, unknown>[] = [];
    // Some Hideki RPC nodes reject the symbolic "latest" block tag for eth_getCode.
    // Pin reads to a concrete observed block, and preserve the account-state report if code inspection is unsupported.
    const observedBlockNumber = await publicClient.getBlockNumber();
    for (const contract of contracts) {
      try {
        const code = await publicClient.getBytecode({
          address: contract as `0x${string}`,
          blockNumber: observedBlockNumber,
        });
        bytecode.push({
          address: contract,
          deployed: Boolean(code && code !== "0x"),
          byteLengthBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
          runtimeBytecodeKeccak256: code && code !== "0x" ? keccak256(code) : null,
          readError: null,
        });
      } catch (error) {
        bytecode.push({
          address: contract,
          deployed: null,
          byteLengthBytes: null,
          runtimeBytecodeKeccak256: null,
          readError: error instanceof Error ? error.message : "unknown eth_getCode failure",
        });
      }
    }
    report.chainId = chainId;
    report.account = account.address;
    report.nativeBalanceSTT = formatEther(nativeBalance);
    report.walletUsdso = formatUnits(walletUsdsoRaw, Number(btc.quoteDecimals ?? 18));
    report.marketCount = markets.length;
    report.accountState = {
      positions,
      openOrders,
      orderReadErrors,
      marginAccounts,
      positionsReadSucceeded: Array.isArray(positionsRaw),
      allMarketOrderReadsSucceeded: orderReadErrors.length === 0,
      safeForLiveLiquidationTest: positions.length === 0 && openOrders.length === 0 && orderReadErrors.length === 0,
    };
    report.deployment = { observedBlockNumber: observedBlockNumber.toString(), systemConfigs, bytecode };
    report.verdict = {
      accountStateClean: positions.length === 0 && openOrders.length === 0 && orderReadErrors.length === 0,
      allExpectedContractsHaveBytecode: bytecode.every((x: any) => x.deployed === true),
      bytecodeInspectionComplete: bytecode.every((x: any) => x.readError === null),
      publishedSystemWiringMatches: systemConfigs.every((x: any) => x.publishedAddressesMatch && x.fullyWired === true),
      liquidationEngineSourceVerified: false,
      liveLiquidationAttemptAuthorized: false,
    };
    const output = JSON.stringify(report, null, 2) + "\n";
    writeFileSync("artifacts/liquidation-preflight-audit.json", output, { mode: 0o600 });
    console.log(output);
    console.log("Report saved to artifacts/liquidation-preflight-audit.json");
    if (orderReadErrors.length) throw new Error("Some market order reads failed; do not use this audit to authorize a live test.");
  } finally {
    try { await exchange.close?.(); } catch { /* preserve audit result */ }
  }
}
main().catch((error: unknown) => {
  console.error("READ-ONLY LIQUIDATION AUDIT FAILED:", error instanceof Error ? error.message : "Unknown failure");
  process.exitCode = 1;
});
