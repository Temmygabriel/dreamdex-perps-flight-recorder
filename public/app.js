const $ = (selector) => document.querySelector(selector);

const ui = {
  markets: [],
  loaded: false,
};

function safeText(value) {
  return String(value ?? "");
}

function setGlobalStatus(message, tone = "normal") {
  const el = $("#global-status");
  el.textContent = message;
  el.dataset.tone = tone;
}

function prettyNumber(value, max = 12) {
  const n = Number(value);
  if (!Number.isFinite(n)) return safeText(value);
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

function showMarketRules() {
  const symbol = $("#market-select").value;
  const market = ui.markets.find((item) => item.symbol === symbol);
  const el = $("#market-rules");
  if (!market) {
    el.textContent = "Market tick, lot and minimum size will appear here after the live market list loads.";
    $("#quantity-unit").textContent = "BASE ASSET";
    return;
  }
  $("#quantity-unit").textContent = market.baseSymbol;
  el.textContent =
    `Live limits · tick ${market.tickSize} USDso · ` +
    `lot ${market.lotSize} ${market.baseSymbol} · ` +
    `minimum ${market.minQuantity} ${market.baseSymbol} · ` +
    `quantity decimals ${market.baseDecimals}`;
}

async function loadMarkets() {
  const button = $("#refresh-markets");
  button.disabled = true;
  button.textContent = "Reading live market list…";
  setGlobalStatus("Reading the live Hideki testnet market list. This is read-only.");
  try {
    const response = await fetch("/api/markets", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "Market list request failed.");
    ui.markets = result.markets || [];
    ui.loaded = true;
    const select = $("#market-select");
    const previous = select.value;
    select.replaceChildren();
    ui.markets
      .slice()
      .sort((a, b) => safeText(a.baseSymbol).localeCompare(safeText(b.baseSymbol)))
      .forEach((market) => {
        const option = document.createElement("option");
        option.value = market.symbol;
        option.textContent = `${market.baseSymbol} / ${market.quoteSymbol}`;
        select.appendChild(option);
      });
    if (previous && ui.markets.some((m) => m.symbol === previous)) select.value = previous;
    select.disabled = ui.markets.length === 0;
    $("#market-count").textContent = String(ui.markets.length);
    showMarketRules();
    setGlobalStatus(
      `Live read successful · ${ui.markets.length} markets · chain ${result.network.chainId} · no private key loaded.`,
      "success",
    );
  } catch (error) {
    setGlobalStatus(`Market data unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
    $("#market-count").textContent = "UNAVAILABLE";
  } finally {
    button.disabled = false;
    button.textContent = "Refresh markets ↻";
  }
}

function escapeHTML(value) {
  return safeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setTrace(id, status, type) {
  const row = $(id);
  if (!row) return;
  row.classList.remove("is-pass", "is-fail");
  if (type === "pass") row.classList.add("is-pass");
  if (type === "fail") row.classList.add("is-fail");
  const label = row.querySelector(".trace-check");
  if (label) label.textContent = status;
}

function renderPreflight(result) {
  const box = $("#preflight-result");
  box.hidden = false;
  const passed = result.pass === true;
  const state = $("#preflight-state");
  state.textContent = passed ? "PREFLIGHT PASSED" : "BLOCKED";
  state.className = `result-state ${passed ? "pass" : "blocked"}`;
  $("#preflight-stage").textContent = safeText(result.stage).toUpperCase();
  $("#preflight-message").textContent = result.explanation || result.error || "No explanation returned.";
  const details = $("#preflight-details");
  details.replaceChildren();

  const rows = [];
  if (result.market) {
    rows.push(["Market", result.market.symbol]);
    if (result.market.tickSize) rows.push(["Tick size", result.market.tickSize]);
    if (result.market.lotSize) rows.push(["Lot size", result.market.lotSize]);
    if (result.market.minQuantity) rows.push(["Minimum size", result.market.minQuantity]);
  }
  if (result.order) {
    rows.push(["Side", result.order.side]);
    rows.push(["Limit price", result.order.price]);
    rows.push(["Requested size", result.order.quantity]);
  }
  if (result.sdk) {
    rows.push(["SDK maximum", result.sdk.maxQuantity]);
    rows.push(["Limit source", result.sdk.limitedBy]);
    rows.push(["Live mark usable", result.sdk.priceable ? "Yes" : "No"]);
  }
  (result.failures || []).forEach((item) => rows.push(["Rule", `${item.code}: ${item.message}`]));

  rows.forEach(([key, value]) => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = key;
    dd.textContent = safeText(value);
    details.append(dt, dd);
  });

  setTrace("#trace-preflight", passed ? "PASS" : "BLOCKED", passed ? "pass" : "fail");
  setGlobalStatus(passed ? "Preflight passed. No transaction was sent." : "The proposed order was blocked. No transaction was sent.", passed ? "success" : "error");
}

async function handlePreflight(event) {
  event.preventDefault();
  const button = $("#run-preflight");
  button.disabled = true;
  button.textContent = "Checking live limits…";
  $("#preflight-result").hidden = true;

  const payload = {
    accountAddress: $("#account-address").value.trim(),
    symbol: $("#market-select").value,
    side: $("#side-select").value,
    price: $("#price-input").value.trim(),
    quantity: $("#quantity-input").value.trim(),
  };

  try {
    const response = await fetch("/api/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok && !result.error) throw new Error("The preflight request failed.");
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
    button.innerHTML = 'Run live preflight <span aria-hidden="true">→</span>';
  }
}

function renderReceipt(record) {
  const el = $("#receipt-result");
  el.hidden = false;
  const isVerified = record?.verification?.verified === true;
  const hasPlacement = Boolean(record?.placement?.hash);
  const hasCancellation = Boolean(record?.cancellation?.hash);
  el.className = `receipt-result ${isVerified ? "verified" : "unverified"}`;

  const lines = [];
  lines.push(`<strong>${isVerified ? "VERIFIED LIFECYCLE" : "NOT FULLY VERIFIED"}</strong>`);
  lines.push(`<p>${isVerified
    ? "The saved run reports that the resting order appeared and disappeared after cancellation."
    : "This receipt does not prove every required step. Review the error and transaction evidence below; do not describe it as a successful end-to-end run."}</p>`);
  if (record?.network) lines.push(`<div class="receipt-line"><span>Network: ${escapeHTML(record.network.name)} / chain ${escapeHTML(record.network.chainId)}</span></div>`);
  if (record?.order) {
    lines.push(`<div class="receipt-line"><span>Market: ${escapeHTML(record.order.market)}</span><span>Side: ${escapeHTML(record.order.side)}</span><span>Type: ${escapeHTML(record.order.type)}</span></div>`);
    lines.push(`<div class="receipt-line"><span>Price: ${escapeHTML(record.order.price)}</span><span>Quantity: ${escapeHTML(record.order.quantity)}</span><span>Notional: ${escapeHTML(record.order.notionalPaperUsdso)} paper USDso</span></div>`);
  }
  if (record?.orderId) lines.push(`<div class="receipt-line"><span>Order ID: <code>${escapeHTML(record.orderId)}</code></span></div>`);
  if (hasPlacement) lines.push(`<div class="receipt-line"><span>Placement TX</span><code class="receipt-hash">${escapeHTML(record.placement.hash)}</code></div>`);
  if (hasCancellation) lines.push(`<div class="receipt-line"><span>Cancellation TX</span><code class="receipt-hash">${escapeHTML(record.cancellation.hash)}</code></div>`);
  if (record?.error) lines.push(`<p><strong>Recorded error:</strong> ${escapeHTML(record.error)}</p>`);
  if (record?.verification) {
    lines.push(`<div class="receipt-line"><span>Visible after placement: ${record.verification.restingOrderWasVisibleAfterPlacement ? "YES" : "NO"}</span><span>Absent after cancel: ${record.verification.restingOrderWasAbsentAfterCancellation ? "YES" : "NO"}</span></div>`);
  }
  lines.push('<p><a href="https://explorer.testnet.somnia.network/tokyo" target="_blank" rel="noreferrer">Open Somnia Tokyo testnet explorer ↗</a></p>');
  el.innerHTML = lines.join("");
  setTrace("#trace-order", hasPlacement && hasCancellation ? "PLACED + CANCELLED" : hasPlacement ? "PLACED" : "NOT RUN", hasPlacement && hasCancellation ? "pass" : hasPlacement ? "fail" : "");
  setTrace("#trace-proof", isVerified ? "VERIFIED" : "NOT VERIFIED", isVerified ? "pass" : "fail");
}

async function handleReceipt(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const record = JSON.parse(text);
    renderReceipt(record);
  } catch {
    const el = $("#receipt-result");
    el.hidden = false;
    el.className = "receipt-result unverified";
    el.textContent = "This file is not valid JSON. Choose the live-testnet-smoke.json artifact from GitHub Actions.";
  }
}

$("#refresh-markets").addEventListener("click", loadMarkets);
$("#market-select").addEventListener("change", showMarketRules);
$("#preflight-form").addEventListener("submit", handlePreflight);
$("#receipt-file").addEventListener("change", handleReceipt);
loadMarkets();
