import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPerpMarkets: vi.fn(),
  getPerpRiskParams: vi.fn(),
  getPerpHealthSnapshot: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@somnia-chain/markets-sdk", () => ({
  SOMNIA_HIDEKI_TESTNET_ADDRESSES: {},
  SomniaMarkets: vi.fn(function () {
    return {
      client: {
        listPerpMarkets: mocks.listPerpMarkets,
        getPerpRiskParams: mocks.getPerpRiskParams,
        getPerpHealthSnapshot: mocks.getPerpHealthSnapshot,
      },
      close: mocks.close,
    };
  }),
}));
vi.mock("@somnia-chain/markets-sdk/chains", () => ({
  hidekiTestnet: { id: 50383, name: "Somnia Hideki Testnet" },
}));

import handler from "./market-risk.js";

function responseHarness() {
  const state: { statusCode: number; headers: Record<string, string>; body: any } = {
    statusCode: 200, headers: {}, body: undefined,
  };
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    setHeader(name: string, value: string) { state.headers[name] = value; },
    json(body: unknown) { state.body = body; },
  };
  return { res, state };
}
const btc = {
  symbol: "BTC-USDso", baseSymbol: "BTC", quoteSymbol: "USDso",
  baseDecimals: 8, quoteDecimals: 18,
  poolAddress: "0x0000000000000000000000000000000000000001",
  marginBank: "0x0000000000000000000000000000000000000002",
};

describe("GET /api/market-risk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPerpMarkets.mockResolvedValue([btc]);
    mocks.getPerpRiskParams.mockResolvedValue({
      initialMarginBps: 500n, maintenanceMarginBps: 250n, closeOutMarginBps: 125n,
      maxOpenInterest: 123000000000n, maxPositionSize: 10000000n,
      makerFeeBpsTimes1k: 1500n, takerFeeBpsTimes1k: 0n,
    });
    mocks.getPerpHealthSnapshot.mockResolvedValue({
      priceable: true, markPrice: 100000000000000000000000n, effectiveImfBps: 500n,
    });
    mocks.close.mockResolvedValue(undefined);
  });

  it("rejects unsupported methods and malformed symbols before SDK access", async () => {
    const a = responseHarness();
    await handler({ method: "POST", query: { symbol: "BTC-USDso" } } as never, a.res);
    expect(a.state.statusCode).toBe(405);
    expect(mocks.listPerpMarkets).not.toHaveBeenCalled();
    const b = responseHarness();
    await handler({ method: "GET", query: { symbol: "https://bad.example/" } } as never, b.res);
    expect(b.state.statusCode).toBe(400);
    expect(mocks.listPerpMarkets).not.toHaveBeenCalled();
  });

  it("returns chain-derived margin tiers and fee units with a priceable mark", async () => {
    const { res, state } = responseHarness();
    await handler({ method: "GET", query: { symbol: "BTC-USDso" } } as never, res);
    expect(state.statusCode).toBe(200);
    expect(state.headers["Cache-Control"]).toBe("no-store");
    expect(state.body).toMatchObject({
      ok: true, network: { chainId: 50383 }, symbol: "BTC-USDso", readonly: true,
      riskParameters: {
        initialMarginFloorPercent: 5,
        effectiveInitialMarginPercent: 5,
        maintenanceMarginPercent: 2.5,
        closeOutMarginPercent: 1.25,
        makerFeeBps: 1.5,
        makerFeePercent: 0.015,
        takerFeePercent: 0,
      },
      marketHealth: { priceable: true, status: "mark-available", markPrice: "100000" },
    });
    expect(mocks.getPerpRiskParams).toHaveBeenCalledWith(btc.poolAddress);
    expect(mocks.getPerpHealthSnapshot).toHaveBeenCalledWith(btc.poolAddress);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("keeps static market risk available while clearly flagging a stale or unpriceable mark", async () => {
    mocks.getPerpHealthSnapshot.mockResolvedValue({ priceable: false });
    const { res, state } = responseHarness();
    await handler({ method: "GET", query: { symbol: "BTC-USDso" } } as never, res);
    expect(state.statusCode).toBe(200);
    expect(state.body.riskParameters.maintenanceMarginPercent).toBe(2.5);
    expect(state.body.marketHealth).toMatchObject({ priceable: false, status: "stale-or-unpriceable", markPrice: null });
  });

  it("returns not-found for a market missing from the current list", async () => {
    const { res, state } = responseHarness();
    await handler({ method: "GET", query: { symbol: "NOPE-USDso" } } as never, res);
    expect(state.statusCode).toBe(404);
    expect(mocks.getPerpRiskParams).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("fails closed on an unavailable indexer or RPC without exposing upstream details", async () => {
    mocks.listPerpMarkets.mockRejectedValue(new Error("private RPC endpoint and query"));
    const { res, state } = responseHarness();
    await handler({ method: "GET", query: { symbol: "BTC-USDso" } } as never, res);
    expect(state.statusCode).toBe(502);
    expect(state.body.error).toContain("temporarily unavailable");
    expect(JSON.stringify(state.body)).not.toContain("private RPC endpoint");
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
