import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPerpMarkets: vi.fn(),
  loadMarkets: vi.fn(),
  fetchOrderBook: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@somnia-chain/markets-sdk", () => ({
  SOMNIA_HIDEKI_TESTNET_ADDRESSES: {},
  SomniaMarkets: vi.fn(function () {
    client: { listPerpMarkets: mocks.listPerpMarkets },
    loadMarkets: mocks.loadMarkets,
    fetchOrderBook: mocks.fetchOrderBook,
    close: mocks.close,
  }),
}));

vi.mock("@somnia-chain/markets-sdk/chains", () => ({
  hidekiTestnet: { id: 50383, name: "Somnia Hideki Testnet" },
}));

import handler from "./market-price.js";

function responseHarness() {
  const state: { statusCode: number; headers: Record<string, string>; body: unknown } = {
    statusCode: 200,
    headers: {},
    body: undefined,
  };
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    setHeader(name: string, value: string) { state.headers[name] = value; },
    json(body: unknown) { state.body = body; },
  };
  return { res, state };
}

const btc = {
  symbol: "BTC-USDso",
  baseSymbol: "BTC",
  quoteSymbol: "USDso",
  baseDecimals: 8,
  quoteDecimals: 18,
  poolAddress: "0x0000000000000000000000000000000000000001",
  marginBank: "0x0000000000000000000000000000000000000002",
};

describe("GET /api/market-price", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPerpMarkets.mockResolvedValue([btc]);
    mocks.loadMarkets.mockResolvedValue({
      "BTC/USDso:USDso": { type: "swap", base: "BTC", quote: "USDso", symbol: "BTC/USDso:USDso" },
    });
    mocks.fetchOrderBook.mockResolvedValue({ bids: [[99_900, 1]], asks: [[100_100, 1]] });
    mocks.close.mockResolvedValue(undefined);
  });

  it("rejects methods other than GET", async () => {
    const { res, state } = responseHarness();
    await handler({ method: "POST", query: { symbol: "BTC-USDso" }, } as never, res);
    expect(state.statusCode).toBe(405);
    expect(state.body).toMatchObject({ ok: false });
    expect(mocks.listPerpMarkets).not.toHaveBeenCalled();
  });

  it("rejects malformed symbols before calling the SDK", async () => {
    const { res, state } = responseHarness();
    await handler({ method: "GET", query: { symbol: "https://example.com" } } as never, res);
    expect(state.statusCode).toBe(400);
    expect(mocks.listPerpMarkets).not.toHaveBeenCalled();
  });

  it("returns the live-book midpoint and explicitly labels its source", async () => {
    const { res, state } = responseHarness();
    await handler({ method: "GET", query: { symbol: "BTC-USDso" } } as never, res);
    expect(state.statusCode).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(state.body).toMatchObject({
      ok: true,
      network: { chainId: 50383 },
      symbol: "BTC-USDso",
      bestBid: 99_900,
      bestAsk: 100_100,
      referencePrice: 100_000,
      readonly: true,
    });
    expect((state.body as { priceSource: string }).priceSource).toContain("not the protocol mark price");
    expect(mocks.fetchOrderBook).toHaveBeenCalledWith("BTC/USDso:USDso", 1);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("does not leak raw upstream exception details to API clients", async () => {
    mocks.listPerpMarkets.mockRejectedValue(new Error("private upstream URL and internal query details"));
    const { res, state } = responseHarness();
    await handler({ method: "GET", query: { symbol: "BTC-USDso" } } as never, res);
    expect(state.statusCode).toBe(502);
    expect(state.body).toMatchObject({ ok: false, error: "Order-book data is temporarily unavailable. Please retry shortly." });
    expect(JSON.stringify(state.body)).not.toContain("private upstream URL");
  });

  it("fails closed when the order book is not two-sided", async () => {
    mocks.fetchOrderBook.mockResolvedValue({ bids: [], asks: [[100_100, 1]] });
    const { res, state } = responseHarness();
    await handler({ method: "GET", query: { symbol: "BTC-USDso" } } as never, res);
    expect(state.statusCode).toBe(502);
    expect(state.body).toMatchObject({ ok: false });
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
