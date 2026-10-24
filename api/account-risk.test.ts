import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPerpMarkets: vi.fn(),
  getMarginAccount: vi.fn(),
  getPerpCollateralBasis: vi.fn(),
  listPerpPositions: vi.fn(),
  getPerpPosition: vi.fn(),
  getPerpPositionAnalytics: vi.fn(),
  getLiquidationPrice: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@somnia-chain/markets-sdk", () => ({
  SOMNIA_HIDEKI_TESTNET_ADDRESSES: {},
  SomniaMarkets: vi.fn(function () {
    return {
      client: {
        listPerpMarkets: mocks.listPerpMarkets,
        getMarginAccount: mocks.getMarginAccount,
        getPerpCollateralBasis: mocks.getPerpCollateralBasis,
        listPerpPositions: mocks.listPerpPositions,
        getPerpPosition: mocks.getPerpPosition,
        getPerpPositionAnalytics: mocks.getPerpPositionAnalytics,
        getLiquidationPrice: mocks.getLiquidationPrice,
      },
      close: mocks.close,
    };
  }),
}));
vi.mock("@somnia-chain/markets-sdk/chains", () => ({
  hidekiTestnet: { id: 50383, name: "Somnia Hideki Testnet" },
}));

import handler from "./account-risk.js";

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
const btcPool = "0x0000000000000000000000000000000000000001";
const ethPool = "0x0000000000000000000000000000000000000003";
const bank = "0x0000000000000000000000000000000000000002";
const account = "0x19393aEd711c5C17C8B62C4cB6Cc2c32A31B5f7A";
const markets = [
  { symbol: "BTC-USDso", baseSymbol: "BTC", quoteSymbol: "USDso", baseDecimals: 8, quoteDecimals: 18, poolAddress: btcPool, marginBank: bank },
  { symbol: "ETH-USDso", baseSymbol: "ETH", quoteSymbol: "USDso", baseDecimals: 18, quoteDecimals: 18, poolAddress: ethPool, marginBank: bank },
];
const marginState = (pools: string[] = []) => ({
  unlockedCollateralBalance: 100000000000000000000n, lockedCollateral: 0n,
  equity: 100000000000000000000n, withdrawable: 90000000000000000000n,
  imReq: 10000000000000000000n, mmReq: 2500000000000000000n,
  cmReq: 1250000000000000000n, marginStatus: "Healthy", activePerpPools: pools,
});
const posFor = (pool: string) => pool === btcPool
  ? { size: 100000n, avgEntryPrice: 100000000000000000000000n }
  : { size: -2000000000000000n, avgEntryPrice: 2000000000000000000000n };
const metricsFor = (pool: string) => ({
  priceable: true,
  markPrice: pool === btcPool ? 100000000000000000000000n : 2000000000000000000000n,
  notional: 10000000000000000000n, unrealizedPnl: 1000000000000000000n,
  accruedFunding: 100000000000000000n, equityContribution: 900000000000000000n,
  initialMarginRequirement: 500000000000000000n, maintenanceMarginRequirement: 250000000000000000n,
  closeOutMarginRequirement: 125000000000000000n,
});

describe("GET /api/account-risk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPerpMarkets.mockResolvedValue(markets);
    mocks.getMarginAccount.mockResolvedValue(marginState());
    mocks.getPerpCollateralBasis.mockResolvedValue(100000000000000000000n);
    mocks.listPerpPositions.mockResolvedValue([]);
    mocks.getPerpPosition.mockImplementation(async (ref: { pool: string }) => posFor(ref.pool));
    mocks.getPerpPositionAnalytics.mockImplementation(async (ref: { pool: string }) => metricsFor(ref.pool));
    mocks.getLiquidationPrice.mockResolvedValue(85000000000000000000000n);
    mocks.close.mockResolvedValue(undefined);
  });

  it("rejects malformed addresses and unsupported methods before reading account data", async () => {
    const a = responseHarness();
    await handler({ method: "GET", query: { address: "not-a-wallet" } } as never, a.res);
    expect(a.state.statusCode).toBe(400);
    expect(mocks.listPerpMarkets).not.toHaveBeenCalled();
    const b = responseHarness();
    await handler({ method: "POST", query: { address: account } } as never, b.res);
    expect(b.state.statusCode).toBe(405);
  });

  it("returns an empty, healthy account honestly rather than inventing a position", async () => {
    const { res, state } = responseHarness();
    await handler({ method: "GET", query: { address: account, symbol: "BTC-USDso" } } as never, res);
    expect(state.statusCode).toBe(200);
    expect(state.body).toMatchObject({
      ok: true, readOnly: true, signerRequired: false, accountHealthAvailable: true,
      summary: { equityUsdso: "100", maintenanceMarginRequirementUsdso: "2.5", activePositionCount: 0 },
      positionCount: 0, positions: [],
    });
    expect(mocks.getLiquidationPrice).not.toHaveBeenCalled();
  });

  it("reads every active pool and returns multiple cross-margin positions with independent SDK estimates", async () => {
    mocks.getMarginAccount.mockResolvedValue(marginState([btcPool, ethPool]));
    const { res, state } = responseHarness();
    await handler({ method: "GET", query: { address: account, symbol: "BTC-USDso" } } as never, res);
    expect(state.statusCode).toBe(200);
    expect(state.body.positionCount).toBe(2);
    expect(state.body.positions.map((row: any) => row.symbol)).toEqual(["BTC-USDso", "ETH-USDso"]);
    expect(state.body.positions.map((row: any) => row.side)).toEqual(["long", "short"]);
    expect(state.body.positions[0].estimatedLiquidationPrice).toBe("85000");
    expect(mocks.getLiquidationPrice).toHaveBeenCalledTimes(2);
    expect(mocks.getLiquidationPrice).toHaveBeenCalledWith({ marginBank: bank, account, pool: btcPool });
  });

  it("preserves collateral visibility and suppresses liquidation verdicts when marks are stale", async () => {
    mocks.getMarginAccount.mockRejectedValue(new Error("oracle mark stale"));
    mocks.getPerpCollateralBasis.mockResolvedValue(7000000000000000000n);
    mocks.listPerpPositions.mockResolvedValue([{ pool: btcPool, size: "100000" }]);
    mocks.getPerpPositionAnalytics.mockResolvedValue({ priceable: false });
    mocks.getLiquidationPrice.mockRejectedValue(new Error("stale mark"));
    const { res, state } = responseHarness();
    await handler({ method: "GET", query: { address: account, symbol: "BTC-USDso" } } as never, res);
    expect(state.statusCode).toBe(200);
    expect(state.body.accountHealthAvailable).toBe(false);
    expect(state.body.summary).toMatchObject({
      equityUsdso: null, collateralBasisUsdso: "7", marginStatus: "unavailable-stale-mark-or-rpc",
    });
    expect(state.body.positions[0]).toMatchObject({
      priceable: false, markPrice: null, estimatedLiquidationPrice: null,
      liquidationPriceStatus: "unavailable-stale-mark-or-rpc",
    });
  });

  it("returns a safe 502 when indexer data is unavailable", async () => {
    mocks.listPerpMarkets.mockRejectedValue(new Error("private indexer endpoint"));
    const { res, state } = responseHarness();
    await handler({ method: "GET", query: { address: account } } as never, res);
    expect(state.statusCode).toBe(502);
    expect(JSON.stringify(state.body)).not.toContain("private indexer endpoint");
  });

  it("returns a safe 502 when account reads and the collateral fallback both fail", async () => {
    mocks.getMarginAccount.mockRejectedValue(new Error("RPC offline"));
    mocks.getPerpCollateralBasis.mockRejectedValue(new Error("RPC offline"));
    const { res, state } = responseHarness();
    await handler({ method: "GET", query: { address: account } } as never, res);
    expect(state.statusCode).toBe(502);
    expect(state.body.error).toContain("No risk verdict was produced");
    expect(JSON.stringify(state.body)).not.toContain("RPC offline");
  });
});
