const base = process.env.STRESS_LAB_DEPLOYMENT_URL?.replace(/\/+$/, "");
if (!base) throw new Error("STRESS_LAB_DEPLOYMENT_URL is required.");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(path) {
  const headers = { accept: "application/json" };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) {
    headers["x-vercel-protection-bypass"] = bypass;
    headers["x-vercel-set-bypass-cookie"] = "true";
  }
  const response = await fetch(new URL(path, base), {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const error = new Error(`${path} returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function main() {
  let marketsPayload;
  let lastError;
  for (let attempt = 1; attempt <= 18; attempt++) {
    try {
      marketsPayload = await getJson("/api/markets");
      break;
    } catch (error) {
      lastError = error;
      if (error?.status === 401 || error?.status === 403) {
        throw new Error("Preview deployment is access-protected; public smoke test cannot reach it.");
      }
      if (attempt < 18) await wait(5_000);
    }
  }
  if (!marketsPayload) throw new Error(`Market endpoint never became ready: ${lastError?.message ?? "unknown error"}`);
  if (marketsPayload.ok !== true || marketsPayload.network?.chainId !== 50383 || !Array.isArray(marketsPayload.markets) || marketsPayload.markets.length === 0) {
    throw new Error("Market endpoint returned an unexpected payload or wrong chain ID.");
  }

  const market = marketsPayload.markets.find((item) => String(item.baseSymbol).toUpperCase() === "BTC")
    ?? marketsPayload.markets[0];
  const symbol = String(market.symbol ?? `${market.baseSymbol}-${market.quoteSymbol}`);
  let pricePayload;
  lastError = undefined;
  for (let attempt = 1; attempt <= 18; attempt++) {
    try {
      pricePayload = await getJson("/api/market-price?symbol=" + encodeURIComponent(symbol));
      break;
    } catch (error) {
      lastError = error;
      if (error?.status === 401 || error?.status === 403) {
        throw new Error("Preview deployment is access-protected; public smoke test cannot reach it.");
      }
      if (attempt < 18) await wait(5_000);
    }
  }
  if (!pricePayload) throw new Error(`Order-book endpoint never became ready: ${lastError?.message ?? "unknown error"}`);
  const bid = Number(pricePayload.bestBid);
  const ask = Number(pricePayload.bestAsk);
  const midpoint = Number(pricePayload.referencePrice);
  const timestamp = Date.parse(pricePayload.timestamp ?? "");
  if (pricePayload.ok !== true || pricePayload.network?.chainId !== 50383 ||
      !Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(midpoint) ||
      bid <= 0 || ask < bid || midpoint <= 0 || timestamp <= 0 ||
      Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
    throw new Error("Order-book endpoint returned invalid, stale, or wrong-network data.");
  }

  console.log("DEPLOYED PREVIEW READ-ONLY SMOKE CHECK PASSED");
  console.log(`Deployment: ${base}`);
  console.log(`Network: Somnia Hideki testnet (chain ID ${marketsPayload.network.chainId})`);
  console.log(`Live markets returned: ${marketsPayload.count}`);
  console.log(`Reference market: ${symbol}`);
  console.log(`Best bid / ask / midpoint: ${bid} / ${ask} / ${midpoint}`);
  console.log("Price source: top-of-book midpoint, not the protocol mark price.");
  console.log(`Quote timestamp: ${new Date(timestamp).toISOString()}`);
  console.log("Transaction submitted: no");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown error";
  if (message.includes("access-protected")) {
    console.log("DEPLOYMENT SMOKE CHECK SKIPPED: Vercel preview protection blocks anonymous access. This is not a successful endpoint verification.");
    console.log("To enable this check without making the preview public, add the VERCEL_AUTOMATION_BYPASS_SECRET Actions secret.");
    return;
  }
  console.error("DEPLOYMENT SMOKE CHECK FAILED:", message);
  process.exitCode = 1;
});
