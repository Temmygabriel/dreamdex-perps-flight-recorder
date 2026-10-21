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
