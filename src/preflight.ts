import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  SomniaMarkets,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";

const NETWORK = {
  name: "Somnia Hideki / dreamDEX Tokyo testnet",
  chainId: 50383,
  rpc: "https://api.hideki2.infra.testnet.somnia.network",
  websocket: "wss://api.hideki2.infra.testnet.somnia.network/ws",
  indexer: process.env.HIDEKI_INDEXER_URL ?? "https://hideki-dev.smk.somnia.host/v1/graphql",
};

function printable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

async function main(): Promise<void> {
  console.log("DREAMDEX PERPS FLIGHT RECORDER — READ-ONLY PREFLIGHT");
  console.log(printable(NETWORK));
  console.log("Private key loaded: no (this command is read-only)");
  console.log("");

  const markets = new SomniaMarkets({
    chain: hidekiTestnet,
    indexerUrl: NETWORK.indexer,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  });

  try {
    const rows = await markets.client.listPerpMarkets();
    const summary = rows.map((market: any) => ({
      symbol: market.symbol ?? [market.baseSymbol, market.quoteSymbol].filter(Boolean).join("-"),
      baseSymbol: market.baseSymbol,
      quoteSymbol: market.quoteSymbol,
      poolAddress: market.poolAddress,
      marginBank: market.marginBank,
      baseDecimals: market.baseDecimals,
      quoteDecimals: market.quoteDecimals,
      tickSize: typeof market.tickSize === "bigint" ? market.tickSize.toString() : market.tickSize,
      lotSize: typeof market.lotSize === "bigint" ? market.lotSize.toString() : market.lotSize,
      minQuantity: typeof market.minQuantity === "bigint" ? market.minQuantity.toString() : market.minQuantity,
    }));

    console.log(`Markets returned: ${summary.length}`);
    console.log(printable(summary));

    if (summary.length === 0) {
      console.error("PREFLIGHT FAILED: the indexer returned no perps markets.");
      process.exitCode = 1;
    } else {
      console.log("");
      console.log("PREFLIGHT RESULT: SDK connected and returned market rows.");
      console.log("This does not yet prove wallet funding, account margin, or order execution.");
    }
  } finally {
    // No signer/private key was configured and no transaction is submitted.
    const maybeClose = (markets as unknown as { close?: () => Promise<void> }).close;
    if (typeof maybeClose === "function") await maybeClose.call(markets);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`PREFLIGHT FAILED: ${message}`);
  process.exitCode = 1;
});
