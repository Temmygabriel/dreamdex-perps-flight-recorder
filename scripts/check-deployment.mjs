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
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const error = new Error(`${path} returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function probeRoot() {
  let result = { status: 0, finalUrl: base, stressLabBranding: false, contentType: "unavailable", headers: {}, html: "" };
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const response = await fetch(base, {
        headers: { accept: "text/html" },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      const html = await response.text();
      result = {
        status: response.status,
        finalUrl: response.url,
        stressLabBranding: html.includes("Perps Stress Lab"),
        contentType: response.headers.get("content-type") ?? "unknown",
        headers: Object.fromEntries(response.headers.entries()),
        html,
      };
      const rootReady = result.status === 200 && result.stressLabBranding;
      const securityPolicyReady = Boolean(result.headers["content-security-policy"]);
      if (rootReady && securityPolicyReady) {
        console.log(`Deployment root probe: HTTP ${result.status}; Stress Lab branding: ${result.stressLabBranding}; content type: ${result.contentType}`);
        return result;
      }
      if (attempt < 8) {
        console.log(`Deployment root not fully propagated yet (attempt ${attempt}/8; HTTP ${result.status}; branding ${result.stressLabBranding}; CSP ${securityPolicyReady ? "present" : "missing"}). Retrying in 4 seconds.`);
      }
    } catch (error) {
      result = { status: 0, finalUrl: base, stressLabBranding: false, contentType: "unavailable", headers: {}, html: "" };
      console.log(`Deployment root probe attempt ${attempt}/8 failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (attempt < 8) await wait(4_000);
  }
  console.log(`Deployment root probe exhausted retries: HTTP ${result.status}; Stress Lab branding: ${result.stressLabBranding}; content type: ${result.contentType}; CSP ${result.headers["content-security-policy"] ? "present" : "missing"}.`);
  return result;
}

async function main() {
  const rootProbe = await probeRoot();
  if (rootProbe.status === 200 && rootProbe.stressLabBranding) {
    const requiredHeaders = [
      ["content-security-policy", "Content-Security-Policy"],
      ["x-content-type-options", "X-Content-Type-Options"],
      ["x-frame-options", "X-Frame-Options"],
      ["referrer-policy", "Referrer-Policy"],
      ["permissions-policy", "Permissions-Policy"],
      ["strict-transport-security", "Strict-Transport-Security"],
    ];
    for (const [key, label] of requiredHeaders) {
      if (!rootProbe.headers?.[key]) throw new Error(`Production root is missing the expected ${label} security header.`);
    }
    const csp = rootProbe.headers["content-security-policy"];
    if (!csp.includes("script-src 'self'") || !csp.includes("frame-ancestors 'none'") || !csp.includes("object-src 'none'")) {
      throw new Error("Production Content-Security-Policy is missing an expected script/frame/object restriction.");
    }
    console.log("Production security-header probe passed: CSP, nosniff, frame protection, referrer policy, permissions policy and HSTS.");

    const cssHref = rootProbe.html.match(/href=["']([^"']+\.css(?:\?[^"']*)?)["']/i)?.[1];
    if (!cssHref) throw new Error("Production HTML did not reference a bundled stylesheet; the UI may render unstyled.");
    const cssResponse = await fetch(new URL(cssHref, base), {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const cssText = await cssResponse.text();
    if (!cssResponse.ok || !(cssResponse.headers.get("content-type") ?? "").includes("text/css") ||
        !cssText.includes(".metric-grid") || !cssText.includes(".toggle")) {
      throw new Error(`Bundled stylesheet failed verification: HTTP ${cssResponse.status}; content type ${cssResponse.headers.get("content-type") ?? "unknown"}.`);
    }
    console.log(`Bundled stylesheet probe: HTTP ${cssResponse.status}; layout rules present.`);
  }
  let marketsPayload;
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      marketsPayload = await getJson("/api/markets");
      break;
    } catch (error) {
      lastError = error;
      if (error?.status === 401 || error?.status === 403) {
        throw new Error("Preview deployment is access-protected; public smoke test cannot reach it.");
      }
      if (attempt < 8) await wait(4_000);
    }
  }
  if (!marketsPayload) throw new Error(`Market endpoint never became ready: ${lastError?.message ?? "unknown error"}; root probe HTTP ${rootProbe.status}, Stress Lab branding ${rootProbe.stressLabBranding}`);
  if (marketsPayload.ok !== true || marketsPayload.network?.chainId !== 50383 || !Array.isArray(marketsPayload.markets) || marketsPayload.markets.length === 0) {
    throw new Error("Market endpoint returned an unexpected payload or wrong chain ID.");
  }

  const market = marketsPayload.markets.find((item) => String(item.baseSymbol).toUpperCase() === "BTC")
    ?? marketsPayload.markets[0];
  const symbol = String(market.symbol ?? `${market.baseSymbol}-${market.quoteSymbol}`);
  let pricePayload;
  lastError = undefined;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      pricePayload = await getJson("/api/market-price?symbol=" + encodeURIComponent(symbol));
      break;
    } catch (error) {
      lastError = error;
      if (error?.status === 401 || error?.status === 403) {
        throw new Error("Preview deployment is access-protected; public smoke test cannot reach it.");
      }
      if (attempt < 8) await wait(4_000);
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

  console.log("DEPLOYED READ-ONLY SMOKE CHECK PASSED");
  console.log(`Deployment: ${base}`);
  console.log(`Network: Somnia Hideki testnet (chain ID ${marketsPayload.network.chainId})`);
  console.log(`Live markets returned: ${marketsPayload.count}`);
  console.log(`Reference market: ${symbol}`);
  console.log(`Best bid / ask / midpoint: ${bid} / ${ask} / ${midpoint}`);
  console.log("Price source: top-of-book midpoint, not the protocol mark price.");
  console.log("Quote timestamp: " + new Date(timestamp).toISOString());

  let riskPayload;
  try {
    riskPayload = await getJson("/api/market-risk?symbol=" + encodeURIComponent(symbol));
  } catch (error) {
    throw new Error("Market risk endpoint failed: " + (error instanceof Error ? error.message : "unknown error"));
  }
  const risk = riskPayload.riskParameters;
  if (riskPayload.ok !== true || riskPayload.network?.chainId !== 50383 ||
      !Number.isFinite(Number(risk?.maintenanceMarginPercent)) ||
      Number(risk.maintenanceMarginPercent) <= 0 ||
      !Number.isFinite(Number(risk?.closeOutMarginPercent)) ||
      Number(risk.closeOutMarginPercent) <= 0 ||
      typeof riskPayload.marketHealth?.priceable !== "boolean") {
    throw new Error("Market risk endpoint returned incomplete risk parameters or an invalid chain/priceability status.");
  }
  if (riskPayload.marketHealth.priceable === false && riskPayload.marketHealth.markPrice != null) {
    throw new Error("Market risk endpoint exposed a mark price while the protocol reported the market unpriceable.");
  }
  console.log("Market risk read passed: maintenance " + risk.maintenanceMarginPercent + "%; close-out " + risk.closeOutMarginPercent + "%; protocol priceable " + riskPayload.marketHealth.priceable + ".");

  // A known public zero address exercises the empty-account read without a signer,
  // private key, wallet connection, or transaction. Empty-account behaviour is also
  // covered in deterministic mocked tests.
  const emptyAddress = "0x0000000000000000000000000000000000000000";
  let accountPayload;
  try {
    accountPayload = await getJson("/api/account-risk?address=" + emptyAddress + "&symbol=" + encodeURIComponent(symbol));
  } catch (error) {
    throw new Error("Read-only account-risk endpoint failed: " + (error instanceof Error ? error.message : "unknown error"));
  }
  if (accountPayload.ok !== true || accountPayload.network?.chainId !== 50383 ||
      accountPayload.readOnly !== true || accountPayload.signerRequired !== false ||
      !Array.isArray(accountPayload.positions) || typeof accountPayload.accountHealthAvailable !== "boolean") {
    throw new Error("Account-risk endpoint returned an unexpected payload or did not affirm read-only behaviour.");
  }
  if (!accountPayload.accountHealthAvailable && accountPayload.summary?.equityUsdso != null) {
    throw new Error("Account-risk endpoint presented equity even though account health was unavailable.");
  }
  console.log("Read-only account risk passed: account health available " + accountPayload.accountHealthAvailable + "; positions returned " + accountPayload.positionCount + "; no transaction submitted.");
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
