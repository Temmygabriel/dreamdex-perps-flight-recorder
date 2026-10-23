import { mkdirSync, writeFileSync } from "node:fs";
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, formatUnits, http, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = "https://api.hideki2.infra.testnet.somnia.network";
const INDEXER_URL = process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";
const WITHDRAW_USDSO = "5";
const GAS_LIMIT = 10_000_000n;
const ERC20_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;
function asBigInt(value: unknown, label: string): bigint { try { return typeof value === "bigint" ? value : BigInt(String(value)); } catch { throw new Error("Could not read a valid " + label + "."); } }
function txHash(value: unknown): string | null {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) return value;
  if (value && typeof value === "object") { const row = value as Record<string, unknown>; const receipt = row.receipt as Record<string, unknown> | undefined; for (const c of [row.hash, row.transactionHash, receipt?.transactionHash, receipt?.hash]) if (typeof c === "string" && /^0x[0-9a-fA-F]{64}$/.test(c)) return c; }
  return null;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stringify = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);

async function main() {
  if (process.env.CONFIRM_SPOT_WITHDRAWAL_E2E !== "YES") throw new Error("Safety stop: set CONFIRM_SPOT_WITHDRAWAL_E2E=YES to withdraw exactly 5 paper USDso from Perps to Spot on Hideki testnet.");
  const rawKey = process.env.WALLET_KEY?.trim();
  if (!rawKey) throw new Error("Missing GitHub Actions secret wallet_key.");
  const privateKey = (rawKey.startsWith("0x") ? rawKey : "0x" + rawKey) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("wallet_key must be a 32-byte EVM private key; key material was not printed.");
  const account = privateKeyToAccount(privateKey);
  const exchange: any = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: INDEXER_URL, wsRpcUrl: WS_RPC_URL, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, privateKey } as never);
  const publicClient = createPublicClient({ chain: hidekiTestnet, transport: http(RPC_URL, { timeout: 20_000 }) });
  const receiptPath = "artifacts/perps-stress-lab-spot-withdrawal.json";
  mkdirSync("artifacts", { recursive: true });
  let receipt: Record<string, unknown> = { test: "withdraw eligible collateral from Perps back to Spot", startedAt: new Date().toISOString(), verified: false };
  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== 50383) throw new Error("Safety stop: expected Hideki chain 50383, got " + chainId + ".");
    const markets = await exchange.client.listPerpMarkets() as any[];
    const market = markets.find((row) => String(row.baseSymbol).toUpperCase() === "BTC");
    if (!market) throw new Error("BTC Perps market not found; no transaction sent.");
    const marginBank = String(market.marginBank);
    const decimals = Number(market.quoteDecimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Unexpected collateral decimals.");
    const config = await exchange.client.getPerpSystemConfig(marginBank);
    const token = String(config?.collateral ?? market.quoteToken ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("Could not resolve configured collateral token.");
    if (typeof exchange.trader.withdrawMargin !== "function" || typeof exchange.fetchPositions !== "function") throw new Error("SDK lacks withdrawal or position read API; no transaction sent.");
    const positionsBefore = await exchange.fetchPositions() as any[];
    if (positionsBefore.length) throw new Error("Safety stop: account has an open position; refusing withdrawal.");
    const marketSymbol = String(market.symbol ?? "BTC/USDso:USDso");
    const orders = await exchange.fetchOpenOrders(marketSymbol);
    if (Array.isArray(orders) && orders.length) throw new Error("Safety stop: open orders exist; refusing withdrawal.");
    const amount = parseUnits(WITHDRAW_USDSO, decimals);
    const walletBalance = async () => BigInt(await publicClient.readContract({ address: token as any, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }));
    const walletBefore = await walletBalance();
    const marginBefore = await exchange.client.getMarginAccount(marginBank, account.address) as Record<string, unknown>;
    const unlockedBefore = asBigInt(marginBefore.unlockedCollateralBalance, "unlocked collateral");
    const withdrawableBefore = asBigInt(marginBefore.withdrawable, "withdrawable collateral");
    if (withdrawableBefore < amount || unlockedBefore < amount) throw new Error("Safety stop: exactly 5 USDso is not currently withdrawable. No transaction sent.");
    console.log("Withdrawing exactly 5 paper USDso from Perps MarginBank back to this wallet's Spot balance.");
    const txResult = await exchange.trader.withdrawMargin({ marginBank, amount, gas: GAS_LIMIT });
    const hash = txHash(txResult);
    if (!hash) throw new Error("SDK did not return a recognized withdrawal transaction hash; inspect account before retrying.");
    let walletAfter = walletBefore;
    let marginAfter: Record<string, unknown> = {};
    let verified = false;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      walletAfter = await walletBalance();
      marginAfter = await exchange.client.getMarginAccount(marginBank, account.address) as Record<string, unknown>;
      if (walletAfter - walletBefore === amount && unlockedBefore - asBigInt(marginAfter.unlockedCollateralBalance, "post-withdrawal unlocked collateral") === amount) { verified = true; break; }
    }
    const positionsAfter = await exchange.fetchPositions() as any[];
    receipt = {
      product: "Perps Stress Lab", test: "withdraw eligible collateral from Perps back to Spot", recordedAt: new Date().toISOString(),
      network: { name: "Somnia Hideki testnet", chainId }, account: account.address, market: marketSymbol, collateralToken: token,
      amountUsdso: WITHDRAW_USDSO, transaction: hash,
      walletUsdsoBefore: formatUnits(walletBefore, decimals), walletUsdsoAfter: formatUnits(walletAfter, decimals),
      walletDeltaUsdso: formatUnits(walletAfter - walletBefore, decimals),
      perpsUnlockedBefore: formatUnits(unlockedBefore, decimals),
      perpsUnlockedAfter: formatUnits(asBigInt(marginAfter.unlockedCollateralBalance, "post-withdrawal unlocked collateral"), decimals),
      perpsWithdrawableBefore: formatUnits(withdrawableBefore, decimals),
      perpsWithdrawableAfter: marginAfter.withdrawable == null ? null : formatUnits(asBigInt(marginAfter.withdrawable, "post-withdrawal withdrawable"), decimals),
      positionsBefore: positionsBefore.length, positionsAfter: positionsAfter.length,
      verification: { correctChain: chainId === 50383, exactWalletIncrease: walletAfter - walletBefore === amount, exactPerpsUnlockedDecrease: unlockedBefore - asBigInt(marginAfter.unlockedCollateralBalance, "post-withdrawal unlocked collateral") === amount, noPositionsRemain: positionsAfter.length === 0, verified },
    };
    console.log("Withdrawal verification: " + stringify(receipt));
    if (!verified || positionsAfter.length !== 0) throw new Error("Withdrawal completed but independent balance/state verification failed. Inspect receipt before retrying.");
  } finally {
    writeFileSync(receiptPath, stringify(receipt) + "\n", { mode: 0o600 });
    try { await exchange.close?.(); } catch { /* preserve evidence */ }
    console.log("Redacted withdrawal receipt written to " + receiptPath);
  }
}
main().catch((error: unknown) => { console.error("SPOT WITHDRAWAL TEST FAILED:", error instanceof Error ? error.message : "Unknown failure"); process.exitCode = 1; });
