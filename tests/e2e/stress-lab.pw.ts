import { Buffer } from "node:buffer";
import { expect, test } from "@playwright/test";

const marketPayload = {
  ok: true,
  network: { name: "Somnia Hideki / dreamDEX Tokyo testnet", chainId: 50383 },
  sdkVersion: "0.32.1",
  count: 1,
  markets: [{ symbol: "BTC-USDso", baseSymbol: "BTC", quoteSymbol: "USDso" }],
  source: "mocked for browser test",
  readonly: true,
};

const pricePayload = {
  ok: true,
  network: { name: "Somnia Hideki / dreamDEX Tokyo testnet", chainId: 50383 },
  symbol: "BTC-USDso",
  bestBid: 99_900,
  bestAsk: 100_100,
  referencePrice: 100_000,
  spreadBps: 20,
  priceSource: "Top-of-book bid/ask midpoint; not the protocol mark price.",
  timestamp: new Date().toISOString(),
  readonly: true,
};


const marketRiskPayload = {
  ok: true, symbol: "BTC-USDso", baseSymbol: "BTC", quoteSymbol: "USDso",
  readAt: new Date().toISOString(), readonly: true,
  riskParameters: {
    initialMarginFloorPercent: 5, effectiveInitialMarginPercent: 5,
    maintenanceMarginPercent: 2.5, closeOutMarginPercent: 1.25,
    makerFeePercent: 0.015, takerFeePercent: 0,
    maxPositionSizeBase: "0.1",
  },
  marketHealth: { priceable: true, status: "mark-available", markPrice: "100000" },
};
const accountRiskPayload = {
  ok: true, readOnly: true, signerRequired: false, accountHealthAvailable: true,
  accountHealthStatus: "available", readAt: new Date().toISOString(),
  marketScope: { symbol: "BTC-USDso" },
  positionsSource: "MarginBank active pools", positionsStatus: "available",
  summary: {
    equityUsdso: "100", unlockedCollateralUsdso: "95", lockedCollateralUsdso: "5",
    withdrawableUsdso: "90", initialMarginRequirementUsdso: "10",
    maintenanceMarginRequirementUsdso: "2.5", closeOutMarginRequirementUsdso: "1.25",
    marginStatus: "Healthy", activePositionCount: 2,
  },
  positionCount: 2,
  positions: [
    { symbol: "BTC-USDso", poolAddress: "0x0000000000000000000000000000000000000001", side: "long", quantityBase: "0.001", entryPrice: "100000", markPrice: "100000", notionalUsdso: "100", unrealizedPnlUsdso: "1", accruedFundingOwedUsdso: "0.1", maintenanceMarginRequirementUsdso: "2.5", estimatedLiquidationPrice: "85000", liquidationPriceStatus: "sdk-estimate", priceable: true },
    { symbol: "ETH-USDso", poolAddress: "0x0000000000000000000000000000000000000003", side: "short", quantityBase: "0.002", entryPrice: "2000", markPrice: "2000", notionalUsdso: "4", unrealizedPnlUsdso: "0.5", accruedFundingOwedUsdso: "0.01", maintenanceMarginRequirementUsdso: "0.1", estimatedLiquidationPrice: "2300", liquidationPriceStatus: "sdk-estimate", priceable: true },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/markets", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(marketPayload),
  }));
  await page.route("**/api/market-risk?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(marketRiskPayload),
  }));
  await page.route("**/api/account-risk?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(accountRiskPayload),
  }));
  await page.route("**/api/market-price?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(pricePayload),
  }));
  await page.goto("/");
});

test("starts with internally consistent default calculations and live-preview wording", async ({ page }) => {
  await expect(page.locator("#scenario-status")).toHaveText("LIVE PREVIEW");
  await expect(page.locator("#result-price")).toHaveText("90,000.00");
  await expect(page.locator("#result-pnl")).toHaveText("−100.00");
  await expect(page.locator("#result-equity")).toHaveText("$0.00");
  await expect(page.locator("#result-headroom")).toHaveText("−$22.50");
  await expect(page.locator("#trace-equity-value")).toHaveText("$0.00");
});

test("prefills the selected market from a labelled read-only book midpoint", async ({ page }) => {
  await expect(page.locator("#market-hint")).toContainText("Live book midpoint");
  await expect(page.locator("#entry")).toHaveValue("100000");
  await expect(page.locator("#market-hint")).toContainText("not a mark price");
  await expect(page.locator("#data-status")).toContainText("Market list loaded");
  await page.locator("#run-scenario").click();
  await expect(page.locator("#scenario-status")).toHaveText("SCENARIO REVIEWED");
});

test("direction and price shock change the estimated P&L in opposite ways", async ({ page }) => {
  await expect(page.locator("#market-hint")).toContainText("Live book midpoint");
  await page.locator("#shock").evaluate((el: HTMLInputElement) => {
    el.value = "10";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator('[data-side="short"]').click();
  await expect(page.locator("#result-pnl")).toHaveClass(/negative/);
  await page.locator('[data-side="long"]').click();
  await expect(page.locator("#result-pnl")).toHaveClass(/positive/);
});

test("exports an honest scenario report with source and on-chain flags", async ({ page }) => {
  await expect(page.locator("#market-hint")).toContainText("Live book midpoint");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-json").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^perps-stress-lab-.*\.json$/);
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  expect(report.source).toBe("live-order-book-midpoint");
  expect(report.priceReference.bestBid).toBe(99_900);
  expect(report.verification.onChain).toBe(false);
  expect(report.verification.liveAccountDataUsed).toBe(false);
});

test("keeps the mobile viewport free of horizontal page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#market-hint")).toContainText("Live book midpoint");
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
});


test("keeps the mobile UI spaced and free of leaked glyphs", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.locator(".nav-list")).toBeVisible();
  await expect(page.getByText("Include funding", { exact: true })).toBeVisible();
  await expect(page.locator(".metric-card")).toHaveCount(4);
  await expect(page.locator(".metric-icon")).toHaveCount(0);
  await expect(page.locator(".file-icon")).toHaveText("JSON");
  await expect(page.locator(".evidence-tags span")).toHaveCount(3);
  await expect(page.locator(".method-grid article > span")).toHaveCount(0);
  await expect(page.getByText('{"}', { exact: true })).toHaveCount(0);
  await expect(page.getByText("Build a position. Apply pressure.", { exact: true })).toHaveCount(0);
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    nav: getComputedStyle(document.querySelector(".nav-list")!).display,
    cardRects: Array.from(document.querySelectorAll(".metric-card")).map((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width };
    }),
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.nav).not.toBe("none");
  expect(dimensions.cardRects).toHaveLength(4);
  expect(dimensions.cardRects[0].left).not.toBe(dimensions.cardRects[1].left);
  expect(dimensions.cardRects[0].top).toBe(dimensions.cardRects[1].top);
  expect(dimensions.cardRects[2].top).toBeGreaterThan(dimensions.cardRects[0].top);
});

test("switches between light and dim mode and keeps the selected theme after reload", async ({ page }) => {
  const root = page.locator("html");
  const toggle = page.getByRole("button", { name: "Switch to dim mode" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(page.locator("#theme-toggle-label")).toHaveText("Dim mode");

  await toggle.click();
  await expect(root).toHaveAttribute("data-theme", "dim");
  await expect(page.getByRole("button", { name: "Switch to light mode" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#theme-toggle-label")).toHaveText("Light mode");
  const dimPanel = await page.locator(".position-panel").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(dimPanel).not.toBe("rgb(255, 255, 255)");

  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dim");
  await expect(page.locator("#theme-toggle-label")).toHaveText("Light mode");
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(page.locator("#theme-toggle-label")).toHaveText("Dim mode");
});


test("invalid input clears stale results and cannot be marked reviewed or exported", async ({ page }) => {
  await page.locator("#run-scenario").click();
  await expect(page.locator("#scenario-status")).toHaveText("SCENARIO REVIEWED");
  await page.locator("#entry").fill("");
  await expect(page.locator("#scenario-status")).toHaveText("CHECK INPUTS");
  await expect(page.locator("#result-pnl")).toHaveText("—");
  await expect(page.locator("#result-price")).toHaveText("—");
  await expect(page.locator("#export-json")).toBeDisabled();
  await expect(page.locator("#copy-summary")).toBeDisabled();
  await page.locator("#run-scenario").click();
  await expect(page.locator("#scenario-status")).toHaveText("CHECK INPUTS");
  await expect(page.locator("#result-pnl")).toHaveText("—");
  await page.locator("#entry").fill("100000");
  await expect(page.locator("#result-pnl")).toHaveText("−100.00");
  await expect(page.locator("#export-json")).toBeEnabled();
  await page.locator("#run-scenario").click();
  await expect(page.locator("#scenario-status")).toHaveText("SCENARIO REVIEWED");
});

test("preserves a manually entered price when a delayed refreshed quote arrives", async ({ page }) => {
  let startQuote!: () => void;
  let releaseQuote!: () => void;
  const quoteStarted = new Promise<void>((resolve) => { startQuote = resolve; });
  const quoteGate = new Promise<void>((resolve) => { releaseQuote = resolve; });
  await page.route("**/api/market-price?**", async (route) => {
    startQuote();
    await quoteGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...pricePayload, referencePrice: 111111, bestBid: 111000, bestAsk: 111222 }),
    });
  });
  await page.locator("#refresh-data").click();
  await quoteStarted;
  await page.locator("#entry").fill("123456.78");
  releaseQuote();
  await expect(page.locator("#entry")).toHaveValue("123456.78");
  await expect(page.locator("#market-hint")).toContainText("Manual entry retained");
  await expect(page.locator("#result-price")).toHaveText("111,111.10");
});


test("shows custom leverage instead of a misleading nearest preset", async ({ page }) => {
  await page.locator("#starting-margin").evaluate((el: HTMLInputElement) => {
    el.value = "11";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#margin-label")).toHaveText("11% of notional");
  await expect(page.locator("#leverage")).toHaveValue("custom");
  await expect(page.locator("#leverage option[value='custom']")).toHaveText("Custom · 9.1×");
  await page.locator("#leverage").selectOption("5");
  await expect(page.locator("#starting-margin")).toHaveValue("20");
  await expect(page.locator("#margin-label")).toHaveText("20% of notional");
});


test("exposes selected direction and shock presets to assistive technology", async ({ page }) => {
  const long = page.locator('[data-side="long"]');
  const short = page.locator('[data-side="short"]');
  await expect(long).toHaveAttribute("aria-pressed", "true");
  await expect(short).toHaveAttribute("aria-pressed", "false");
  await short.click();
  await expect(short).toHaveAttribute("aria-pressed", "true");
  await expect(long).toHaveAttribute("aria-pressed", "false");
  const severe = page.locator('[data-shock="-20"]');
  const pullback = page.locator('[data-shock="-5"]');
  await pullback.click();
  await expect(pullback).toHaveAttribute("aria-pressed", "true");
  await expect(severe).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#shock")).toHaveAttribute("aria-label", "Price shock percentage");
});


test("shows live protocol risk settings separately from the editable scenario price", async ({ page }) => {
  await expect(page.locator("#market-risk-status")).toContainText("Protocol mark available");
  await expect(page.locator("#market-risk-imf")).toHaveText("5.00%");
  await expect(page.locator("#market-risk-maintenance")).toHaveText("2.50%");
  await expect(page.locator("#market-risk-mark")).toHaveText("100,000.00");
  await expect(page.locator("#market-risk-note")).toContainText("Static risk limits");
});

test("read-only Account Risk Check displays cross-margin summary and multiple positions", async ({ page }) => {
  await page.locator("#account-risk-address").fill("0x19393aEd711c5C17C8B62C4cB6Cc2c32A31B5f7A");
  await page.locator("#account-risk-submit").click();
  await expect(page.locator("#account-risk-status")).toContainText("Account snapshot loaded");
  await expect(page.locator("#account-risk-equity")).toHaveText("100.00");
  await expect(page.locator("#account-risk-position-count")).toHaveText("2");
  await expect(page.locator(".account-position-card")).toHaveCount(2);
  await expect(page.locator(".account-position-card").first()).toContainText("SDK liquidation estimate");
  await expect(page.locator(".account-risk-caveat")).toContainText("other market contributions are held constant");
});

test("preserves market risk parameters while marking a stale protocol price unavailable", async ({ page }) => {
  await page.route("**/api/market-risk?**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ...marketRiskPayload, marketHealth: { priceable: false, status: "stale-or-unpriceable", markPrice: null } }),
  }));
  await page.locator("#refresh-data").click();
  await expect(page.locator("#market-risk-status")).toHaveText("Mark stale or unpriceable");
  await expect(page.locator("#market-risk-maintenance")).toHaveText("2.50%");
  await expect(page.locator("#market-risk-mark")).toHaveText("Unavailable");
  await expect(page.locator("#market-risk-note")).toContainText("Do not treat missing price data as zero");
});

test("rejects stale order-book references rather than presenting them as live", async ({ page }) => {
  const staleQuote = {
    ...pricePayload, referencePrice: 123456, bestBid: 123400, bestAsk: 123512,
    timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  };
  await page.route("**/api/market-price?**", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(staleQuote),
  }));
  await page.reload();
  await expect(page.locator("#market-hint")).toContainText("Live reference price unavailable");
  await expect(page.locator("#entry")).toHaveValue("100000");
  await expect(page.locator("#market-hint")).not.toContainText("Live book midpoint $123,456.00");
});

test("reports an unavailable account-risk endpoint without displaying a false healthy status", async ({ page }) => {
  await page.route("**/api/account-risk?**", (route) => route.fulfill({
    status: 502, contentType: "application/json",
    body: JSON.stringify({ ok: false, error: "Account risk data is temporarily unavailable from the Hideki RPC/indexer. No risk verdict was produced; retry when data is healthy." }),
  }));
  await page.locator("#account-risk-address").fill("0x19393aEd711c5C17C8B62C4cB6Cc2c32A31B5f7A");
  await page.locator("#account-risk-submit").click();
  await expect(page.locator("#account-risk-status")).toContainText("No risk verdict was produced");
  await expect(page.locator("#account-risk-results")).toBeHidden();
});
