import {
  ORDER_TYPE,
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
  contractErrorsAbi,
  decodePlaceOrder,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  isAddress,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Address,
  type Hash,
} from "viem";

type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?: (event: string, listener: (...args: any[]) => void) => void;
  removeListener?: (event: string, listener: (...args: any[]) => void) => void;
  isRabby?: boolean;
  providers?: Eip1193Provider[];
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

type Market = {
  symbol: string;
  baseSymbol: string;
  quoteSymbol: string;
  poolAddress: Address;
  marginBank: Address;
  baseDecimals: number;
  quoteDecimals: number;
  tickSizeRaw: string;
  lotSizeRaw: string;
  minQuantityRaw: string;
  tickSize: string;
  lotSize: string;
  minQuantity: string;
};

type OpenOrder = {
  id: string;
  symbol: string;
  side: string;
  type: string;
  price: string | null;
  amount: string | null;
  remaining: string | null;
  status: string;
  timestamp: number | null;
};

type OrderEvidence = {
  product: string;
  recordedAt: string;
  network: { name: string; chainId: number };
  sdkVersion: string;
  account: string;
  order: {
    market: string;
    sdkSymbol: string;
    side: "long" | "short";
    orderType: "POST_ONLY";
    price: string;
    quantity: string;
    notionalPaperUsdso: string;
    orderId: string | null;
    fillsReportedBySdk: number | null;
  };
  placement: { hash: string; status: string; blockNumber: string };
  verification: {
    orderVisibleAfterPlacement: boolean;
    cancelled: boolean;
    orderAbsentAfterCancellation: boolean;
    verified: boolean;
  };
  cancellation?: { hash: string; status: string; blockNumber: string };
  error?: string;
  notes: string[];
};

type State = {
  markets: Market[];
  walletAddress?: Address;
  activeOrder?: {
    id: string;
    market: Market;
    sdkSymbol: string;
    side: "long" | "short";
    price: string;
    quantity: string;
    notional: number;
    placementHash: Hash;
    placementStatus: string;
    placementBlock: bigint;
    fills: number | null;
  };
  evidence?: OrderEvidence;
};

const $ = <T extends HTMLElement>(selector: string): T => {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`Required page element missing: ${selector}`);
  return node as T;
};

const state: State = { markets: [] };
const RPC_URL = "https://api.hideki2.infra.testnet.somnia.network";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";
const INDEXER_URL = "https://hideki-dev.smk.somnia.host/v1/graphql";
const CHAIN_ID = 50383;
const CHAIN_ID_HEX = "0xc4cf";
const MAX_ORDER_NOTIONAL = 25;
const GAS_LIMIT = 10_000_000n;

const poolAbi = [
  ...parseAbi([
    "function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)",
    "function cancelOrder(uint128 orderId)",
  ]),
  ...contractErrorsAbi,
] as const;

function safeText(value: unknown): string {
  return String(value ?? "");
}

function prettyNumber(value: number, max = 12): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: max });
}

function escapeHtml(value: unknown): string {
  return safeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setStatus(message: string, tone: "normal" | "success" | "error" = "normal"): void {
  const el = $("#global-status");
  el.textContent = message;
  el.dataset.tone = tone;
}

function setLiveStatus(message: string, tone: "normal" | "success" | "error" = "normal"): void {
  const el = $("#live-order-status");
  el.textContent = message;
  el.dataset.tone = tone;
}

function setTrace(selector: string, status: string, tone: "pass" | "fail" | "pending"): void {
  const row = $(selector);
  row.classList.remove("is-pass", "is-fail");
  if (tone === "pass") row.classList.add("is-pass");
  if (tone === "fail") row.classList.add("is-fail");
  const check = row.querySelector(".trace-check");
  if (check) check.textContent = status;
}

function currentMarket(): Market | undefined {
  const symbol = ($("#market-select") as HTMLSelectElement).value;
  return state.markets.find((item) => item.symbol === symbol);
}

function formPayload(): Record<string, string> {
  return {
    accountAddress: ($("#account-address") as HTMLInputElement).value.trim(),
    symbol: ($("#market-select") as HTMLSelectElement).value,
    side: ($("#side-select") as HTMLSelectElement).value,
    price: ($("#price-input") as HTMLInputElement).value.trim(),
    quantity: ($("#quantity-input") as HTMLInputElement).value.trim(),
  };
}

function showMarketRules(): void {
  const market = currentMarket();
  if (!market) {
    $("#market-rules").textContent = "Market tick, lot and minimum size will appear here after the live market list loads.";
    $("#quantity-unit").textContent = "BASE ASSET";
    return;
  }
  $("#quantity-unit").textContent = market.baseSymbol;
  $("#market-rules").textContent =
    `Live limits · tick ${market.tickSize} USDso · lot ${market.lotSize} ${market.baseSymbol} · ` +
    `minimum ${market.minQuantity} ${market.baseSymbol} · quantity precision ${market.baseDecimals} decimals.`;
}

async function loadMarkets(): Promise<void> {
  const button = $("#refresh-markets") as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "Reading live market list…";
  setStatus("Reading live Hideki testnet markets. This is read-only.");
  try {
    const response = await fetch("/api/markets", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "Market list request failed.");
    state.markets = result.markets as Market[];
    const select = $("#market-select") as HTMLSelectElement;
    const previous = select.value;
    select.replaceChildren();
    state.markets
      .slice()
      .sort((a, b) => a.baseSymbol.localeCompare(b.baseSymbol))
      .forEach((market) => {
        const option = document.createElement("option");
        option.value = market.symbol;
        option.textContent = `${market.baseSymbol} / ${market.quoteSymbol}`;
        select.appendChild(option);
      });
    if (previous && state.markets.some((item) => item.symbol === previous)) select.value = previous;
    select.disabled = state.markets.length === 0;
    $("#market-count").textContent = String(state.markets.length);
    showMarketRules();
    setStatus(`Live market read passed · ${state.markets.length} markets · chain ${result.network.chainId} · no private key loaded.`, "success");
  } catch (error) {
    $("#market-count").textContent = "UNAVAILABLE";
    setStatus(`Market data unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Refresh markets ↻";
  }
}

async function requestTestnetNetwork(provider: Eip1193Provider): Promise<void> {
  const chainId = String(await provider.request({ method: "eth_chainId" })).toLowerCase();
  if (chainId === CHAIN_ID_HEX) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? Number((error as { code: unknown }).code)
      : 0;
    if (code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: CHAIN_ID_HEX,
        chainName: "Somnia Hideki (dreamDEX Tokyo testnet)",
        nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
        rpcUrls: [RPC_URL],
      }],
    });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
  }
  const checked = String(await provider.request({ method: "eth_chainId" })).toLowerCase();
  if (checked !== CHAIN_ID_HEX) {
    throw new Error("Your wallet did not switch to chain 50383. No transaction was sent.");
  }
}

function updateWalletUI(): void {
  const button = $("#connect-wallet") as HTMLButtonElement;
  const label = $("#wallet-status");
  const accountInput = $("#account-address") as HTMLInputElement;
  if (state.walletAddress) {
    const short = `${state.walletAddress.slice(0, 7)}…${state.walletAddress.slice(-5)}`;
    label.textContent = `${short} · chain 50383`;
    label.classList.add("wallet-connected");
    button.textContent = "Wallet connected";
    button.classList.add("wallet-is-connected");
    accountInput.value = state.walletAddress;
    accountInput.readOnly = true;
    $("#run-preflight").textContent = "Run live preflight →";
  } else {
    label.textContent = "Wallet not connected";
    label.classList.remove("wallet-connected");
    button.textContent = "Connect wallet";
    button.classList.remove("wallet-is-connected");
    accountInput.readOnly = false;
  }
  refreshPlaceButton();
}

async function connectWallet(): Promise<void> {
  const provider = window.ethereum;
  if (!provider) {
    throw new Error("No browser wallet found. Install or open Rabby, unlock it, then reload this page.");
  }
  const button = $("#connect-wallet") as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
    const address = accounts?.[0];
    if (!address || !isAddress(address)) throw new Error("The wallet did not return a valid public address.");
    await requestTestnetNetwork(provider);
    state.walletAddress = address as Address;
    const accountInput = $("#account-address") as HTMLInputElement;
    accountInput.value = state.walletAddress;
    updateWalletUI();
    setStatus("Wallet connected on chain 50383. Connecting does not sign or send a transaction.", "success");
  } finally {
    button.disabled = false;
    if (!state.walletAddress) button.textContent = "Connect wallet";
  }
}

function getWalletClient() {
  const provider = window.ethereum;
  if (!provider || !state.walletAddress) throw new Error("Connect your browser wallet first.");
  return createWalletClient({
    account: state.walletAddress,
    chain: hidekiTestnet,
    transport: custom(provider as any),
  });
}

function getPublicClient() {
  return createPublicClient({ chain: hidekiTestnet, transport: http(RPC_URL) });
}

async function requestPreflight(): Promise<any> {
  const payload = formPayload();
  if (!payload.accountAddress || !payload.symbol || !payload.side || !payload.price || !payload.quantity) {
    throw new Error("Enter the account, market, side, price and quantity first.");
  }
  if (!isAddress(payload.accountAddress)) throw new Error("The account field must contain a valid public wallet address.");
  const response = await fetch("/api/preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok && !result.error) throw new Error("Live preflight request failed.");
  return result;
}

function renderPreflight(result: any): void {
  const box = $("#preflight-result");
  box.hidden = false;
  const passed = result.pass === true;
  const stateLabel = $("#preflight-state");
  stateLabel.textContent = passed ? "PREFLIGHT PASSED" : "BLOCKED";
  stateLabel.className = `result-state ${passed ? "pass" : "blocked"}`;
  $("#preflight-stage").textContent = safeText(result.stage).toUpperCase();
  $("#preflight-message").textContent = result.explanation || result.error || "No explanation returned.";

  const details = $("#preflight-details");
  details.replaceChildren();
  const rows: Array<[string, string]> = [];
  if (result.market) {
    rows.push(["Market", safeText(result.market.symbol)]);
    if (result.market.tickSize) rows.push(["Tick size", safeText(result.market.tickSize)]);
    if (result.market.lotSize) rows.push(["Lot size", safeText(result.market.lotSize)]);
    if (result.market.minQuantity) rows.push(["Minimum size", safeText(result.market.minQuantity)]);
  }
  if (result.order) {
    rows.push(["Side", safeText(result.order.side)]);
    rows.push(["Limit price", safeText(result.order.price)]);
    rows.push(["Requested size", safeText(result.order.quantity)]);
  }
  if (result.sdk) {
    rows.push(["SDK maximum", safeText(result.sdk.maxQuantity)]);
    rows.push(["Limit source", safeText(result.sdk.limitedBy)]);
    rows.push(["Live mark usable", result.sdk.priceable ? "Yes" : "No"]);
  }
  for (const failure of (result.failures ?? [])) {
    rows.push(["Rule", `${safeText(failure.code)}: ${safeText(failure.message)}`]);
  }
  rows.forEach(([key, value]) => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = key;
    dd.textContent = value;
    details.append(dt, dd);
  });

  setTrace("#trace-preflight", passed ? "PASS" : "BLOCKED", passed ? "pass" : "fail");
  setStatus(passed ? "Preflight passed. No transaction has been sent." : "The proposed order was blocked. No transaction has been sent.", passed ? "success" : "error");
  $("#live-order-box").hidden = !passed;
  const summary = $("#live-order-summary");
  summary.textContent = passed
    ? `${payloadText(result.order?.side)} ${safeText(result.order?.quantity)} ${safeText(result.market?.symbol)} at ${safeText(result.order?.price)} USDso. Order type: post-only limit. Testnet only; max notional ${MAX_ORDER_NOTIONAL} paper USDso.`
    : "Fix the issue above, then run preflight again.";
  refreshPlaceButton();
}

function payloadText(side: unknown): string {
  return safeText(side).toLowerCase() === "short" ? "SELL / SHORT" : "BUY / LONG";
}

function refreshPlaceButton(): void {
  const button = $("#place-order") as HTMLButtonElement;
  const connected = Boolean(state.walletAddress);
  const account = ($("#account-address") as HTMLInputElement).value.trim().toLowerCase();
  const preflightLabel = ($("#preflight-state")).textContent;
  const canPlace = connected && account === state.walletAddress?.toLowerCase() &&
    preflightLabel === "PREFLIGHT PASSED" && !state.activeOrder;
  button.disabled = !canPlace;
  if (!connected) button.textContent = "Connect wallet to place order";
  else if (state.activeOrder) button.textContent = "Order already placed — cancel it first";
  else if (preflightLabel !== "PREFLIGHT PASSED") button.textContent = "Run preflight first";
  else button.textContent = "Place post-only testnet order";
}

async function handlePreflight(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const button = $("#run-preflight") as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "Checking live limits…";
  $("#preflight-result").hidden = true;
  $("#live-order-box").hidden = true;
  setTrace("#trace-order", "NOT RUN", "pending");
  setTrace("#trace-proof", "NOT VERIFIED", "pending");
  try {
    const result = await requestPreflight();
    renderPreflight(result);
  } catch (error) {
    renderPreflight({
      pass: false,
      stage: "request",
      error: error instanceof Error ? error.message : String(error),
      explanation: "The check could not finish. No order was sent.",
    });
  } finally {
    button.disabled = false;
    button.textContent = "Run live preflight →";
  }
}

async function getOpenOrders(account: Address, baseSymbol: string): Promise<OpenOrder[]> {
  const params = new URLSearchParams({ accountAddress: account, baseSymbol });
  const response = await fetch(`/api/orders?${params.toString()}`, { cache: "no-store" });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || "Could not read the account's open orders.");
  return result.orders as OpenOrder[];
}

async function pollOrderVisibility(account: Address, baseSymbol: string, orderId: string, wantPresent: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const orders = await getOpenOrders(account, baseSymbol);
      const found = orders.some((order) => String(order.id) === orderId);
      if (found === wantPresent) return true;
    } catch {
      // The market indexer can take a moment to catch up after a transaction.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_250));
  }
  return false;
}

function appendDetail(key: string, value: string): void {
  const details = $("#live-order-details");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = key;
  dd.textContent = value;
  details.append(dt, dd);
}

function clearLiveDetails(): void {
  $("#live-order-details").replaceChildren();
}

function appendHash(key: string, value: string): void {
  appendDetail(key, value);
}

function saveEvidence(): void {
  if (!state.evidence) return;
  const contents = JSON.stringify(state.evidence, null, 2) + "\n";
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "perps-flight-recorder-receipt.json";
  link.click();
  URL.revokeObjectURL(url);
}

function setEvidenceVisibility(): void {
  ($("#download-receipt") as HTMLButtonElement).hidden = !state.evidence;
}

async function placeOrder(): Promise<void> {
  const placeButton = $("#place-order") as HTMLButtonElement;
  placeButton.disabled = true;
  placeButton.textContent = "Checking again before signing…";
  state.evidence = undefined;
  state.activeOrder = undefined;
  ($("#cancel-order") as HTMLButtonElement).hidden = true;
  ($("#download-receipt") as HTMLButtonElement).hidden = true;

  try {
    const provider = window.ethereum;
    if (!provider) throw new Error("No wallet provider found. Nothing was sent.");
    if (!state.walletAddress) throw new Error("Connect your wallet first. Nothing was sent.");
    await requestTestnetNetwork(provider);

    const currentAddress = String(await provider.request({ method: "eth_accounts" })).split(",")[0];
    if (!currentAddress || currentAddress.toLowerCase() !== state.walletAddress.toLowerCase()) {
      throw new Error("The selected wallet account changed. Reconnect the correct account and run preflight again.");
    }
    if (($("#account-address") as HTMLInputElement).value.trim().toLowerCase() !== state.walletAddress.toLowerCase()) {
      throw new Error("The checked account does not match the connected wallet. Nothing was sent.");
    }

    const latest = await requestPreflight();
    renderPreflight(latest);
    if (latest.pass !== true) throw new Error(latest.explanation || "The latest live preflight blocked this order.");
    const market = currentMarket();
    if (!market) throw new Error("The selected market is no longer in the live list. Nothing was sent.");

    const side = ($("#side-select") as HTMLSelectElement).value === "short" ? "short" : "long";
    const priceText = ($("#price-input") as HTMLInputElement).value.trim();
    const quantityText = ($("#quantity-input") as HTMLInputElement).value.trim();
    const price = parseUnits(priceText, market.quoteDecimals);
    const quantity = parseUnits(quantityText, market.baseDecimals);
    if (price <= 0n || quantity <= 0n) throw new Error("Price and quantity must be greater than zero.");

    const notionalRaw = (price * quantity) / (10n ** BigInt(market.baseDecimals));
    const notional = Number(formatUnits(notionalRaw, market.quoteDecimals));
    if (!Number.isFinite(notional) || notional > MAX_ORDER_NOTIONAL + 0.001) {
      throw new Error(`Safety stop: estimated order value must stay at or below ${MAX_ORDER_NOTIONAL} paper USDso.`);
    }

    const confirmation =
      `You are about to send a real TESTNET transaction (not mainnet).\n\n` +
      `Market: ${market.baseSymbol}-PERP\nSide: ${side.toUpperCase()}\n` +
      `Type: POST-ONLY limit (should rest; it should not fill immediately)\n` +
      `Price: ${priceText} USDso\nQuantity: ${quantityText} ${market.baseSymbol}\n` +
      `Approximate value: ${notional.toFixed(4)} paper USDso\n\n` +
      "Your wallet will ask you to approve the transaction. A resting order reserves paper margin until it is filled or cancelled. Continue?";
    if (!window.confirm(confirmation)) {
      setLiveStatus("You cancelled before signing. No transaction was sent.");
      return;
    }

    const account = state.walletAddress;
    let beforeIds = new Set<string>();
    try {
      const before = await getOpenOrders(account, market.baseSymbol);
      beforeIds = new Set(before.map((row) => String(row.id)));
    } catch {
      // Optional baseline only; on-chain order sizing and simulation still gate the write.
    }

    const publicClient = getPublicClient();
    const walletClient = getWalletClient();
    const expiryNs = BigInt(Math.floor(Date.now() / 1000) + 50 * 365 * 24 * 60 * 60) * 1_000_000_000n;

    setLiveStatus("Simulating the order against the current pool rules. No transaction has been sent yet.");
    const { request } = await publicClient.simulateContract({
      address: market.poolAddress,
      abi: poolAbi,
      functionName: "placeOrder",
      args: [
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
      account,
      gas: GAS_LIMIT,
      value: 0n,
    });

    placeButton.textContent = "Waiting for wallet approval…";
    setLiveStatus("Simulation passed. Approve the testnet transaction in your wallet.");
    const hash = await walletClient.writeContract(request as never);
    setLiveStatus(`Transaction submitted: ${hash}. Waiting for the testnet confirmation…`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      setTrace("#trace-order", "TRANSACTION REVERTED", "fail");
      throw new Error(`The transaction was included but reverted. Hash: ${hash}`);
    }

    let orderId: string | null = null;
    let fills: number | null = null;
    let decoderError: string | undefined;
    try {
      const decoded = decodePlaceOrder(receipt as any, market.poolAddress);
      orderId = decoded.orderId == null ? null : String(decoded.orderId);
      fills = Array.isArray(decoded.fills) ? decoded.fills.length : null;
    } catch (error) {
      decoderError = error instanceof Error ? error.message : String(error);
    }

    setTrace("#trace-order", "TRANSACTION CONFIRMED", "pass");
    setLiveStatus("The placement transaction succeeded. Checking whether the order appears in the live open-order list…");
    let openOrders: OpenOrder[] = [];
    let visibilityVerified = false;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        openOrders = await getOpenOrders(account, market.baseSymbol);
        if (orderId) {
          visibilityVerified = openOrders.some((row) => String(row.id) === orderId);
        } else {
          const matches = openOrders.filter((row) =>
            !beforeIds.has(String(row.id)) &&
            row.side.toLowerCase() === (side === "long" ? "buy" : "sell") &&
            row.price != null && Math.abs(Number(row.price) - Number(priceText)) < 1e-8 &&
            row.amount != null && Math.abs(Number(row.amount) - Number(quantityText)) < 1e-8
          );
          if (matches.length > 0) {
            const newest = matches.slice().sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0))[0];
            orderId = String(newest.id);
            visibilityVerified = true;
          }
        }
        if (visibilityVerified) break;
      } catch {
        // A lagging indexer is not proof of failure; keep checking.
      }
      await new Promise((resolve) => setTimeout(resolve, 1_250));
    }

    state.activeOrder = {
      id: orderId ?? "",
      market,
      sdkSymbol: `${market.baseSymbol}/${market.quoteSymbol}:USDso`,
      side,
      price: priceText,
      quantity: quantityText,
      notional,
      placementHash: hash,
      placementStatus: String(receipt.status),
      placementBlock: receipt.blockNumber,
      fills,
    };

    state.evidence = {
      product: "Perps Flight Recorder",
      recordedAt: new Date().toISOString(),
      network: { name: "Somnia Hideki / Tokyo testnet", chainId: CHAIN_ID },
      sdkVersion: "0.32.1",
      account,
      order: {
        market: `${market.baseSymbol}-PERP`,
        sdkSymbol: state.activeOrder.sdkSymbol,
        side,
        orderType: "POST_ONLY",
        price: priceText,
        quantity: quantityText,
        notionalPaperUsdso: notional.toFixed(8),
        orderId,
        fillsReportedBySdk: fills,
      },
      placement: {
        hash,
        status: String(receipt.status),
        blockNumber: String(receipt.blockNumber),
      },
      verification: {
        orderVisibleAfterPlacement: visibilityVerified,
        cancelled: false,
        orderAbsentAfterCancellation: false,
        verified: false,
      },
      notes: [
        "Wallet signed a testnet transaction on chain 50383. No mainnet transaction was sent.",
        "POST_ONLY was used to avoid intentionally crossing the book.",
        "Preflight was repeated immediately before signing; market/account state may still change after simulation.",
        decoderError ? `SDK receipt decoding note: ${decoderError}` : "The SDK receipt decoder ran.",
        fills === 0 ? "The SDK reported no immediate fills." : fills == null ? "Fill count could not be decoded." : `The SDK reported ${fills} fill(s); inspect account positions immediately.`,
      ],
    };

    clearLiveDetails();
    appendDetail("Network", "Somnia Hideki / Tokyo testnet (50383)");
    appendDetail("Order ID", orderId ?? "Could not decode; inspect the app's open orders before proceeding");
    appendDetail("Placement TX hash", hash);
    appendDetail("Block number", String(receipt.blockNumber));
    appendDetail("Order visible in open-order list", visibilityVerified ? "YES" : "NOT CONFIRMED");
    appendDetail("Immediate fills reported", fills == null ? "Unknown" : String(fills));
    appendHash("Order value (paper USDso)", notional.toFixed(4));
    ($("#cancel-order") as HTMLButtonElement).hidden = !orderId;
    ($("#download-receipt") as HTMLButtonElement).hidden = false;
    setEvidenceVisibility();
    refreshPlaceButton();

    if (fills != null && fills > 0) {
      setLiveStatus("Safety warning: the SDK reports an immediate fill. Do not repeat the test; inspect your testnet position now.", "error");
    } else if (!orderId) {
      setLiveStatus("Transaction confirmed, but the order ID could not be recovered. Inspect open orders in dreamDEX before doing anything else.", "error");
    } else if (visibilityVerified) {
      setLiveStatus("Order placed and found in live open orders. Cancel it now to release any reserved paper margin.", "success");
      setTrace("#trace-proof", "ORDER FOUND · CANCEL PENDING", "pass");
    } else {
      setLiveStatus("Placement transaction succeeded, but the open-order list did not confirm it yet. Keep the receipt and inspect the testnet app before repeating.", "error");
      setTrace("#trace-proof", "READ-BACK NOT CONFIRMED", "fail");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLiveStatus(message, "error");
    setStatus(message, "error");
  } finally {
    refreshPlaceButton();
  }
}

async function cancelOrder(): Promise<void> {
  const order = state.activeOrder;
  if (!order || !order.id) throw new Error("No confirmed order ID is available to cancel. Check open orders in dreamDEX first.");
  if (!state.walletAddress || !window.ethereum) throw new Error("Reconnect the wallet before cancelling.");
  await requestTestnetNetwork(window.ethereum);

  const confirmation = `Cancel testnet order ${order.id} on ${order.market.baseSymbol}-PERP?\n\nThis sends another testnet transaction and uses a small amount of STT for gas.`;
  if (!window.confirm(confirmation)) {
    setLiveStatus("You cancelled before signing the cancellation. The order may still be open.", "error");
    return;
  }

  const button = $("#cancel-order") as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "Waiting for wallet…";
  try {
    const publicClient = getPublicClient();
    const walletClient = getWalletClient();
    const { request } = await publicClient.simulateContract({
      address: order.market.poolAddress,
      abi: poolAbi,
      functionName: "cancelOrder",
      args: [BigInt(order.id)],
      account: state.walletAddress,
      gas: GAS_LIMIT,
    });
    setLiveStatus("Simulation passed. Approve the cancellation in your wallet.");
    const hash = await walletClient.writeContract(request as never);
    setLiveStatus(`Cancellation submitted: ${hash}. Waiting for testnet confirmation…`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Cancellation reverted. Inspect the order in dreamDEX now. TX: ${hash}`);

    const absent = await pollOrderVisibility(state.walletAddress, order.market.baseSymbol, order.id, false);
    if (state.evidence) {
      state.evidence.cancellation = { hash, status: String(receipt.status), blockNumber: String(receipt.blockNumber) };
      state.evidence.verification.cancelled = true;
      state.evidence.verification.orderAbsentAfterCancellation = absent;
      state.evidence.verification.verified =
        state.evidence.verification.orderVisibleAfterPlacement && absent &&
        (state.evidence.order.fillsReportedBySdk ?? 0) === 0;
      state.evidence.recordedAt = new Date().toISOString();
    }

    clearLiveDetails();
    appendDetail("Order ID", order.id);
    appendDetail("Placement TX hash", order.placementHash);
    appendDetail("Cancellation TX hash", hash);
    appendDetail("Cancellation block", String(receipt.blockNumber));
    appendDetail("Order absent after cancellation", absent ? "YES" : "NOT CONFIRMED");
    appendDetail("Full lifecycle verified", state.evidence?.verification.verified ? "YES" : "NOT FULLY VERIFIED");

    button.hidden = absent;
    button.disabled = false;
    button.textContent = absent ? "Cancel this order" : "Check / retry cancellation";
    setEvidenceVisibility();
    setTrace("#trace-order", "CANCEL TX CONFIRMED", "pass");
    setTrace("#trace-proof", state.evidence?.verification.verified ? "VERIFIED" : "READ-BACK PENDING", state.evidence?.verification.verified ? "pass" : "fail");
    setLiveStatus(
      state.evidence?.verification.verified
        ? "Verified: the order appeared, the cancellation transaction succeeded, and the order disappeared from the open-order list. Download the receipt for your submission."
        : "Cancellation transaction succeeded, but the read-back did not confirm that the order disappeared. Keep this order selected, inspect open orders in dreamDEX, and check again before placing another order.",
      state.evidence?.verification.verified ? "success" : "error",
    );
    if (absent) state.activeOrder = undefined;
    refreshPlaceButton();
  } catch (error) {
    setLiveStatus(error instanceof Error ? error.message : String(error), "error");
    button.disabled = false;
    button.textContent = "Retry cancellation";
  }
}

function renderReceipt(record: any): void {
  const element = $("#receipt-result");
  element.hidden = false;
  const verified = record?.verification?.verified === true;
  element.className = `receipt-result ${verified ? "verified" : "unverified"}`;
  element.replaceChildren();

  const title = document.createElement("strong");
  title.textContent = verified ? "VERIFIED LIFECYCLE" : "NOT FULLY VERIFIED";
  element.appendChild(title);

  const summary = document.createElement("p");
  summary.textContent = verified
    ? "This saved receipt says the order appeared in the open-order list, then disappeared after cancellation."
    : "This file does not prove the complete order lifecycle. Check the transaction hashes, any error, and the actual testnet account.";
  element.appendChild(summary);

  const fields: Array<[string, string]> = [];
  if (record?.network) fields.push(["Network", `${safeText(record.network.name)} · chain ${safeText(record.network.chainId)}`]);
  if (record?.order) {
    fields.push(["Market", safeText(record.order.market)]);
    fields.push(["Side and type", `${safeText(record.order.side)} · ${safeText(record.order.orderType ?? record.order.type)}`]);
    fields.push(["Price", safeText(record.order.price)]);
    fields.push(["Quantity", safeText(record.order.quantity)]);
  }
  if (record?.placement?.hash) fields.push(["Placement transaction", safeText(record.placement.hash)]);
  if (record?.cancellation?.hash) fields.push(["Cancellation transaction", safeText(record.cancellation.hash)]);
  if (record?.error) fields.push(["Error", safeText(record.error)]);
  fields.forEach(([name, value]) => {
    const row = document.createElement("p");
    row.className = "receipt-line";
    const strong = document.createElement("strong");
    strong.textContent = `${name}: `;
    const span = document.createElement("span");
    span.textContent = value;
    row.append(strong, span);
    element.appendChild(row);
  });
}

async function handleReceipt(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    renderReceipt(JSON.parse(await file.text()));
  } catch {
    const element = $("#receipt-result");
    element.hidden = false;
    element.className = "receipt-result unverified";
    element.textContent = "This file is not valid JSON. Choose the JSON evidence receipt downloaded from the GitHub Actions artifact or the app.";
  }
}


function invalidatePreflightOnEdit(): void {
  // A passed check describes only the exact inputs that were checked. If any
  // field changes, make the user run the live check again before a transaction.
  const stateLabel = $("#preflight-state");
  if (stateLabel.textContent === "PREFLIGHT PASSED" || stateLabel.textContent === "BLOCKED") {
    stateLabel.textContent = "CHECK AGAIN";
    stateLabel.className = "result-state";
    $("#preflight-message").textContent = "Your inputs changed. Run live preflight again before placing an order.";
    $("#live-order-box").hidden = true;
    setTrace("#trace-preflight", "RECHECK REQUIRED", "pending");
  }
  refreshPlaceButton();
}

for (const selector of ["#account-address", "#market-select", "#side-select", "#price-input", "#quantity-input"]) {
  $(selector).addEventListener("input", invalidatePreflightOnEdit);
  $(selector).addEventListener("change", invalidatePreflightOnEdit);
}

$("#connect-wallet").addEventListener("click", () => {
  connectWallet().catch((error) => setStatus(error instanceof Error ? error.message : String(error), "error"));
});
$("#refresh-markets").addEventListener("click", () => loadMarkets());
$("#market-select").addEventListener("change", showMarketRules);
$("#preflight-form").addEventListener("submit", (event) => {
  handlePreflight(event as SubmitEvent).catch((error) => setStatus(error instanceof Error ? error.message : String(error), "error"));
});
$("#place-order").addEventListener("click", () => {
  placeOrder().catch((error) => setLiveStatus(error instanceof Error ? error.message : String(error), "error"));
});
$("#cancel-order").addEventListener("click", () => {
  cancelOrder().catch((error) => setLiveStatus(error instanceof Error ? error.message : String(error), "error"));
});
$("#download-receipt").addEventListener("click", saveEvidence);
$("#receipt-file").addEventListener("change", (event) => {
  handleReceipt(event).catch((error) => setStatus(error instanceof Error ? error.message : String(error), "error"));
});

if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", (...args: any[]) => {
    const accounts = args[0] as string[];
    state.walletAddress = accounts?.[0] && isAddress(accounts[0]) ? accounts[0] as Address : undefined;
    updateWalletUI();
    if (!state.walletAddress) setStatus("Wallet disconnected.", "normal");
    else setStatus("Wallet account changed. Run preflight again for the new account.", "normal");
    $("#preflight-result").hidden = true;
    $("#live-order-box").hidden = true;
  });
  window.ethereum.on("chainChanged", (...args: any[]) => {
    const chainId = String(args[0] ?? "").toLowerCase();
    if (chainId !== CHAIN_ID_HEX) {
      setStatus("Your wallet changed networks. Connect again to use Hideki testnet (50383).", "error");
      $("#preflight-result").hidden = true;
      $("#live-order-box").hidden = true;
    }
  });
}

updateWalletUI();
loadMarkets();
