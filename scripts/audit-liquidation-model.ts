import { mkdirSync, writeFileSync } from "node:fs";
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, http } from "viem";
import { calculateStress } from "../src/stress-model.js";

const RPC_URL = "https://api.hideki2.infra.testnet.somnia.network";
const INDEXER_URL = process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";

function clean(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}
function finiteNumber(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("Live protocol returned invalid " + label + ".");
  return n;
}
async function main(): Promise<void> {
  const publicClient = createPublicClient({ chain: hidekiTestnet, transport: http(RPC_URL, { timeout: 20_000 }) });
  const exchange: any = new SomniaMarkets({
    chain: hidekiTestnet, indexerUrl: INDEXER_URL, wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  } as never);
  const path = "artifacts/liquidation-model-calibration.json";
  mkdirSync("artifacts", { recursive: true });
  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== 50383) throw new Error("Wrong network: expected Hideki chain 50383, got " + chainId + ".");
    const markets = await exchange.client.listPerpMarkets() as Array<Record<string, any>>;
    const btc = markets.find((m) => String(m.baseSymbol ?? "").toUpperCase() === "BTC");
    if (!btc) throw new Error("BTC Perps market missing from live SDK response.");

    const risk = await exchange.client.getPerpRiskParams(btc.poolAddress);
    const health = await exchange.client.getPerpHealthSnapshot(btc.poolAddress);
    const initialMarginBps = finiteNumber(risk.initialMarginBps, "initialMarginBps");
    const maintenanceMarginBps = finiteNumber(risk.maintenanceMarginBps, "maintenanceMarginBps");
    const closeOutMarginBps = finiteNumber(risk.closeOutMarginBps, "closeOutMarginBps");
    if (!(initialMarginBps > maintenanceMarginBps && maintenanceMarginBps > closeOutMarginBps && closeOutMarginBps > 0)) {
      throw new Error("Live BTC margin thresholds are inconsistent; refusing to label model calibration successful.");
    }
    const initialMarginPercent = initialMarginBps / 100;
    const maintenancePercent = maintenanceMarginBps / 100;

    // This is a transparent, hypothetical single-position baseline with all starting
    // margin allocated to the position. It is NOT the wallet's current cross-margin
    // liquidation price and does not emulate book execution, fees, funding or ADL.
    const shocks = [-3, -2.57, -2.56, -2.5, 0, 2.5];
    const scenarios = shocks.map((shockPercent) => {
      const result = calculateStress({
        side: "long", entryPrice: 100_000, quantity: 1,
        startingMarginPercent: initialMarginPercent, shockPercent,
        maintenancePercent,
      });
      return {
        shockPercent,
        stressedPrice: result.stressedPrice,
        pnlUsdso: result.pnlUsd,
        allocatedStartingMarginUsdso: result.startingMarginUsd,
        estimatedEquityUsdso: result.equityUsd,
        estimatedMaintenanceUsdso: result.maintenanceUsd,
        estimatedHeadroomUsdso: result.headroomUsd,
        status: result.thresholdStatus,
      };
    });
    let below = -100;
    let above = 0;
    for (let i = 0; i < 60; i += 1) {
      const mid = (below + above) / 2;
      const result = calculateStress({
        side: "long", entryPrice: 100_000, quantity: 1,
        startingMarginPercent: initialMarginPercent, shockPercent: mid,
        maintenancePercent,
      });
      if (result.headroomUsd > 0) above = mid;
      else below = mid;
    }
    const estimatedCriticalShockPercent = (below + above) / 2;
    const healthChecks = {
      priceable: health.priceable === true,
      effectiveInitialMarginMatches: finiteNumber(health.effectiveImfBps, "effectiveImfBps") === initialMarginBps,
      maintenanceMarginMatches: finiteNumber(health.maintenanceMarginBps, "health maintenanceMarginBps") === maintenanceMarginBps,
      closeOutMarginMatches: finiteNumber(health.closeOutMarginBps, "health closeOutMarginBps") === closeOutMarginBps,
    };
    const report = {
      test: "read-only live BTC liquidation model calibration",
      recordedAt: new Date().toISOString(),
      network: { name: "Somnia Hideki testnet", chainId },
      transactionSubmitted: false,
      accountStateChanged: false,
      market: {
        baseSymbol: btc.baseSymbol,
        quoteSymbol: btc.quoteSymbol,
        symbol: btc.symbol,
        poolAddress: btc.poolAddress,
        baseDecimals: btc.baseDecimals,
        quoteDecimals: btc.quoteDecimals,
      },
      liveRiskParameters: clean(risk),
      liveHealthSnapshot: clean(health),
      healthChecks,
      modelAssumptions: {
        side: "long",
        startingMarginPercent: initialMarginPercent,
        maintenancePercent,
        entryPriceUsdso: 100_000,
        quantityBase: 1,
        fundingIncluded: false,
        crossMarginModeled: false,
        note: "Illustrative single-position baseline with starting margin allocated to this position. Not the wallet's current cross-margin liquidation forecast or a promise of liquidation at this price.",
      },
      estimatedCriticalShockPercent,
      scenarios,
      verdict: {
        chainCorrect: chainId === 50383,
        thresholdsOrdered: true,
        liveHealthParametersMatchRiskParameters: Object.values(healthChecks).every(Boolean),
        modelGridFinite: scenarios.every((s) => [s.stressedPrice, s.pnlUsdso, s.allocatedStartingMarginUsdso, s.estimatedEquityUsdso, s.estimatedMaintenanceUsdso, s.estimatedHeadroomUsdso].every(Number.isFinite)),
        liquidationEngineExecutionVerified: false,
        liveLiquidationAttempted: false,
      },
    };
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
    if (!healthChecks.priceable || !healthChecks.effectiveInitialMarginMatches ||
        !healthChecks.maintenanceMarginMatches || !healthChecks.closeOutMarginMatches) {
      throw new Error("Live health snapshot did not match risk parameters; model calibration is not verified.");
    }
  } finally {
    try { await exchange.close?.(); } catch { /* preserve calibration output */ }
  }
}
main().catch((error: unknown) => {
  console.error("LIQUIDATION MODEL CALIBRATION FAILED:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
