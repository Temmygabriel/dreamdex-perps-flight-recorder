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
  page.on("pageerror", (error) => console.log("PAGE_ERROR", error.message));
  page.on("console", (message) => { if (message.type() === "error") console.log("BROWSER_CONSOLE_ERROR", message.text()); });
  page.on("response", (response) => {
    if (response.url().includes("app.css") || response.url().includes("stress-lab.ts")) {
      console.log("APP_ASSET_RESPONSE", response.status(), response.url(), response.headers()["content-type"] ?? "");
    }
  });
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
    gridDisplay: getComputedStyle(document.querySelector(".metric-grid")!).display,
    gridColumns: getComputedStyle(document.querySelector(".metric-grid")!).gridTemplateColumns,
    gridParent: document.querySelector(".metric-grid")?.parentElement?.className,
    cardRects: Array.from(document.querySelectorAll(".metric-card")).map((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width };
    }),
    overflowers: Array.from(document.querySelectorAll("body *")).map((el) => {
      const rect = el.getBoundingClientRect();
      return { tag: el.tagName, id: el.id, cls: typeof el.className === "string" ? el.className : "", left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), scrollWidth: (el as HTMLElement).scrollWidth };
    }).filter((el) => el.right > document.documentElement.clientWidth + 1 || el.left < -1).slice(0, 18),
    scrollers: Array.from(document.querySelectorAll("body *")).map((el) => {
      const node = el as HTMLElement;
      const style = getComputedStyle(node);
      return { tag: el.tagName, id: el.id, cls: typeof el.className === "string" ? el.className : "", clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, overflowX: style.overflowX };
    }).filter((el) => el.scrollWidth > el.clientWidth + 4 && el.overflowX === "visible").slice(0, 18),
  }));
  console.log("MOBILE_LAYOUT_DIAGNOSTIC", JSON.stringify(dimensions));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.nav).not.toBe("none");
  expect(dimensions.cardRects).toHaveLength(4);
  expect(dimensions.cardRects[0].left).not.toBe(dimensions.cardRects[1].left);
  expect(dimensions.cardRects[0].top).toBe(dimensions.cardRects[1].top);
  expect(dimensions.cardRects[2].top).toBeGreaterThan(dimensions.cardRects[0].top);
});
