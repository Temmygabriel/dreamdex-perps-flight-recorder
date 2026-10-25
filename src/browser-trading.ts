import { ORDER_TYPE, SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { createWalletClient, custom, formatUnits, parseUnits, type Address, type Hex } from "viem";

type InjectedProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, callback: (...args: unknown[]) => void): void;
  removeListener?(event: string, callback: (...args: unknown[]) => void): void;
};
declare global { interface Window { ethereum?: InjectedProvider } }

const CHAIN_ID = 50383;
const RPC = "https://api.hideki2.infra.testnet.somnia.network";
const INDEXER = "https://hideki-dev.smk.somnia.host/v1/graphql";
const WS = "wss://api.hideki2.infra.testnet.somnia.network/ws";
const MAX_NOTIONAL = 15;
const TARGET_NOTIONAL = 10;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const set = (id: string, value: string) => { const el = $(id); if (el) el.textContent = value; };
const short = (s: string) => s.length > 14 ? s.slice(0, 6) + "…" + s.slice(-4) : s;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let exchange: any = null;
let walletAddress: Address | null = null;
let market: any = null;
let marketSymbol = "";
let lastEntryHash: Hex | null = null;

function status(message: string, error = false) {
  set("wallet-trade-status", message);
  const el = $("wallet-trade-status");
  el.dataset.state = error ? "error" : "info";
}
function txLink(hash: string) {
  const root = $("wallet-trade-evidence");
  root.replaceChildren();
  const link = document.createElement("a");
  link.href = "https://shannon-explorer.somnia.network/tx/" + hash;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "View transaction " + short(hash);
  root.append(link);
}
function injected() {
  if (!window.ethereum) throw new Error("No injected EVM wallet found. Open this page in MetaMask or a compatible wallet browser.");
  return window.ethereum;
}
async function ensureChain(provider: InjectedProvider) {
  const raw = await provider.request({ method: "eth_chainId" });
  if (Number(raw) === CHAIN_ID) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xc52f" }] });
  } catch (error) {
    const e = error as { code?: number };
    if (e.code !== 4902) throw new Error("Switch your wallet to Somnia Hideki testnet (chain 50383) before trading.");
    await provider.request({ method: "wallet_addEthereumChain", params: [{
      chainId: "0xc52f", chainName: "Somnia Hideki Testnet",
      nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
      rpcUrls: [RPC], blockExplorerUrls: ["https://shannon-explorer.somnia.network"]
    }] });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xc52f" }] });
  }
  const switched = await provider.request({ method: "eth_chainId" });
  if (Number(switched) !== CHAIN_ID) throw new Error("Wallet network is not Somnia Hideki testnet. No order was submitted.");
}
async function connect() {
  const provider = injected();
  status("Waiting for wallet connection approval…");
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
  if (!Array.isArray(accounts) || !accounts[0] || !/^0x[a-fA-F0-9]{40}$/.test(accounts[0])) throw new Error("Wallet did not return a valid public account.");
  await ensureChain(provider);
  walletAddress = accounts[0] as Address;
  const walletClient = createWalletClient({ account: walletAddress, chain: hidekiTestnet, transport: custom(provider as any) });
  exchange = new SomniaMarkets({ chain: hidekiTestnet, indexerUrl: INDEXER, wsRpcUrl: WS, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, walletClient } as any);
  const chainId = await exchange.client.publicClient?.getChainId?.().catch?.(() => CHAIN_ID);
  if (chainId != null && Number(chainId) !== CHAIN_ID) throw new Error("SDK RPC chain mismatch; trading disabled.");
  const markets = await exchange.client.listPerpMarkets() as any[];
  market = markets.find(row => String(row.baseSymbol ?? "").toUpperCase() === "BTC");
  if (!market) throw new Error("BTC Perps market is not available on Hideki.");
  const loaded = await exchange.loadMarkets();
  const resolved = Object.values(loaded).find((row: any) => row.type === "swap" && String(row.base ?? row.info?.baseSymbol ?? "").toUpperCase() === "BTC" && String(row.quote ?? row.info?.quoteSymbol ?? "").toUpperCase() === String(market.quoteSymbol).toUpperCase()) as any;
  if (!resolved?.symbol) throw new Error("SDK could not resolve the BTC Perps order book.");
  marketSymbol = String(resolved.symbol);
  set("wallet-account", short(walletAddress));
  set("wallet-connect", "Connected");
  $("wallet-connect").setAttribute("aria-label", "Wallet connected " + walletAddress);
  $("wallet-open").removeAttribute("disabled");
  await refreshPosition();
  status("Connected to Somnia Hideki testnet. Review the capped order details before submitting.");
}
async function refreshPosition() {
  if (!exchange || !walletAddress) return;
  const positions = await exchange.fetchPositions() as any[];
  const p = positions.find((row: any) => row.symbol === marketSymbol || String(row.base ?? row.info?.baseSymbol ?? "").toUpperCase() === "BTC" || String(row.symbol ?? "").toUpperCase().startsWith("BTC/"));
  const quantity = p ? Math.abs(Number(p.contracts ?? 0)) : 0;
  const open = Number.isFinite(quantity) && quantity > 0;
  set("wallet-position", open ? "BTC " + String(p.side ?? "position") + " · " + quantity.toString() + " contracts" : "No open BTC position detected");
  $("wallet-close").toggleAttribute("disabled", !open);
  return { position: p, quantity, open };
}
async function waitForPosition(open: boolean) {
  for (let i = 0; i < 15; i++) {
    await wait(1000);
    const result = await refreshPosition();
    if (open ? result?.open : !result?.open) return result;
  }
  throw new Error(open ? "Order was submitted, but the BTC position did not appear in the SDK read-back. Do not submit another order until you reconcile the account." : "Close was submitted, but the BTC position remains visible. Check the account before retrying.");
}
function asBigInt(v: unknown, name: string): bigint {
  try { const n = BigInt(String(v)); if (n <= 0n) throw new Error(); return n; }
  catch { throw new Error("Hideki returned an invalid " + name + ". Trading stopped."); }
}
function alignDown(v: bigint, step: bigint) { return v / step * step; }
function alignUp(v: bigint, step: bigint) { return (v + step - 1n) / step * step; }
async function openPosition() {
  if (!exchange || !market || !walletAddress) throw new Error("Connect your wallet first.");
  if (Number(await injected().request({ method: "eth_chainId" })) !== CHAIN_ID) throw new Error("Wallet network changed. Reconnect to Somnia Hideki testnet.");
  const current = await refreshPosition();
  const orders = await exchange.fetchOpenOrders(marketSymbol);
  if (current?.open || (Array.isArray(orders) && orders.length)) throw new Error("Safety stop: this account already has a BTC position or open BTC orders. Close/reconcile them first.");
  const book = await exchange.fetchOrderBook(marketSymbol, 5);
  const ask = Number(book.asks?.[0]?.[0]);
  if (!Number.isFinite(ask) || ask <= 0) throw new Error("BTC ask price is unavailable. No order submitted.");
  const quoteDecimals = Number(market.quoteDecimals);
  const baseDecimals = Number(market.baseDecimals);
  const tick = asBigInt(market.tickSize, "BTC tick size");
  const lot = asBigInt(market.lotSize, "BTC lot size");
  const minQty = asBigInt(market.minQuantity, "BTC minimum quantity");
  const price = alignUp(parseUnits(ask.toFixed(8), quoteDecimals) * 10150n / 10000n, tick);
  let quantity = alignDown(parseUnits(String(TARGET_NOTIONAL), quoteDecimals) * (10n ** BigInt(baseDecimals)) / price, lot);
  if (quantity < minQty) quantity = minQty;
  const notional = Number(formatUnits(quantity * price / (10n ** BigInt(baseDecimals)), quoteDecimals));
  if (!Number.isFinite(notional) || notional <= 0 || notional > MAX_NOTIONAL || notional < 5) throw new Error("Lot-aligned order would be " + notional.toFixed(4) + " USDso; safety band is 5–15 USDso.");
  const gate = await exchange.client.getMaxPerpOrderSize({ pool: market.poolAddress, marginBank: market.marginBank, account: walletAddress, isBid: true, price });
  if (!gate.priceable || !gate.placeable || quantity > BigInt(String(gate.maxQuantity))) throw new Error("Protocol preflight blocked this order (" + String(gate.limitedBy ?? "risk/price check") + "). No transaction submitted.");
  set("wallet-order-preview", "BTC long MARKET · ~" + notional.toFixed(2) + " USDso · max 15 USDso · 1.5% price guard");
  if (!window.confirm("Submit this REAL Hideki testnet BTC long MARKET order?\n\nEstimated notional: " + notional.toFixed(2) + " USDso\nMaximum allowed: 15 USDso\nYour wallet will ask you to approve the transaction.")) return status("Order cancelled before wallet approval. No transaction submitted.");
  $("wallet-open").setAttribute("disabled", "");
  status("Waiting for wallet approval for the BTC entry transaction…");
  try {
    const result = await exchange.trader.placePerpOrder({ pool: market.poolAddress, isBid: true, price, quantity, orderType: ORDER_TYPE.MARKET, gas: 10000000n });
    const hash = (result as any)?.hash ?? (result as any)?.transactionHash;
    if (typeof hash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error("SDK returned without a recognizable transaction hash. Reconcile the account before retrying.");
    lastEntryHash = hash as Hex;
    txLink(hash);
    status("Entry transaction confirmed by the SDK. Verifying BTC position read-back…");
    await waitForPosition(true);
    status("BTC position verified on Hideki. Transaction hash captured; you can now close the position.");
  } catch (error) {
    const e = error as { code?: number; name?: string; message?: string };
    if (e.code === 4001 || /user rejected|user denied/i.test(e.message ?? "")) status("Wallet request rejected. No retry was sent.", true);
    else status("Order failed or could not be verified: " + (e.message ?? "unknown error") + ". Check wallet activity and account state before retrying.", true);
    throw error;
  } finally { $("wallet-open").removeAttribute("disabled"); }
}
async function closePosition() {
  if (!exchange || !walletAddress || !market) throw new Error("Connect your wallet first.");
  const current = await refreshPosition();
  if (!current?.open || !current.position) throw new Error("No BTC position was found to close.");
  const p = current.position;
  const side = String(p.side ?? "").toLowerCase();
  if (side !== "long" && side !== "short") throw new Error("Cannot safely infer the current position side. Close disabled.");
  const quantity = parseUnits(Math.abs(Number(p.contracts)).toFixed(Number(market.baseDecimals)), Number(market.baseDecimals));
  const book = await exchange.fetchOrderBook(marketSymbol, 5);
  const touch = Number((side === "long" ? book.bids?.[0]?.[0] : book.asks?.[0]?.[0]));
  if (!Number.isFinite(touch) || touch <= 0 || quantity <= 0n) throw new Error("No safe opposing quote/quantity available to close.");
  const tick = asBigInt(market.tickSize, "BTC tick size");
  const raw = parseUnits(touch.toFixed(8), Number(market.quoteDecimals));
  const price = side === "long" ? alignDown(raw * 9700n / 10000n, tick) : alignUp(raw * 10300n / 10000n, tick);
  if (price <= 0n) throw new Error("Computed close price guard is invalid.");
  if (!window.confirm("Submit a separate REAL Hideki testnet transaction to close the full BTC " + side + " position? Your wallet will ask for approval.")) return status("Close cancelled before wallet approval. Position remains open.");
  $("wallet-close").setAttribute("disabled", "");
  status("Waiting for wallet approval for the close transaction…");
  try {
    const result = await exchange.trader.placePerpOrder({ pool: market.poolAddress, isBid: side === "short", price, quantity, orderType: ORDER_TYPE.MARKET, gas: 10000000n });
    const hash = (result as any)?.hash ?? (result as any)?.transactionHash;
    if (typeof hash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error("SDK returned without a recognizable close transaction hash. Reconcile the account.");
    txLink(hash);
    status("Close transaction confirmed by the SDK. Verifying flat state…");
    await waitForPosition(false);
    const ordersAfter = await exchange.fetchOpenOrders(marketSymbol);
    if (Array.isArray(ordersAfter) && ordersAfter.length) throw new Error("Position size is zero but open BTC orders remain. Cancel/reconcile them before claiming a clean exit.");
    status("Exit verified: no open BTC position or BTC orders detected.");
  } catch (error) {
    const e = error as { code?: number; message?: string };
    if (e.code === 4001 || /user rejected|user denied/i.test(e.message ?? "")) status("Close request rejected. Position may still be open; refresh the account before retrying.", true);
    else status("Close failed or could not be verified. Check current position and wallet activity before retrying.", true);
    throw error;
  } finally { $("wallet-close").removeAttribute("disabled"); await refreshPosition().catch(() => undefined); }
}
function reportError(error: unknown) {
  const e = error as { message?: string };
  status(e?.message ?? "Wallet operation failed. Check network and wallet state.", true);
}
export function initBrowserTrading() {
  if (!$("wallet-connect")) return;
  $("wallet-connect").addEventListener("click", () => void connect().catch(reportError));
  $("wallet-open").addEventListener("click", () => void openPosition().catch(reportError));
  $("wallet-close").addEventListener("click", () => void closePosition().catch(reportError));
  const provider = window.ethereum;
  provider?.on?.("accountsChanged", () => {
    walletAddress = null; exchange = null; market = null;
    $("wallet-open").setAttribute("disabled", ""); $("wallet-close").setAttribute("disabled", "");
    set("wallet-account", "Not connected"); set("wallet-position", "Reconnect wallet to refresh position state.");
    status("Wallet account changed. Reconnect and re-verify account state.");
  });
  provider?.on?.("chainChanged", () => {
    walletAddress = null; exchange = null; market = null;
    $("wallet-open").setAttribute("disabled", ""); $("wallet-close").setAttribute("disabled", "");
    set("wallet-account", "Not connected"); status("Wallet network changed. Reconnect to Hideki testnet.");
  });
}
