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

test.beforeEach(async ({ page }) => {
  await page.route("**/api/markets", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(marketPayload),
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
  await expect(page.locator("#result-price")).toHaveText("$90,000.00");
  await expect(page.locator("#result-pnl")).toHaveText("−$100.00");
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
  await expect(page.locator("#result-pnl")).toHaveText("−$100.00");
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
  await expect(page.locator("#result-price")).toHaveText("$111,111.00");
});
