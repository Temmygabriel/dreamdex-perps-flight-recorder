import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Hex, keccak256 } from "viem";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";

const TARGETS = [
  { name: "LiquidationEngine proxy", address: "0xa66d3c24ad4a389d863846905d8173e1017e9f4d" },
  { name: "LiquidationEngine implementation", address: "0xf46c4966f2f17703b39e1208f98cd3dc80e4702d" },
] as const;
const SOURCIFY_BASES = [
  "https://repo.sourcify.dev/contracts/full_match/50383/",
  "https://repo.sourcify.dev/contracts/partial_match/50383/",
];
const EXPLORER_APIS = [
  "https://explorer.testnet.somnia.network/api",
  "https://explorer.testnet.somnia.network/tokyo/api",
  "https://api.etherscan.io/v2/api?chainid=50383",
];
async function getJson(url: string): Promise<{ ok: boolean; status: number | null; json?: unknown; error?: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
    const text = await response.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = { responsePreview: text.slice(0, 250) }; }
    return { ok: response.ok, status: response.status, json };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message.slice(0, 250) : "request failed" };
  }
}
async function main(): Promise<void> {
  const rpc = createPublicClient({ chain: hidekiTestnet, transport: http("https://api.hideki2.infra.testnet.somnia.network", { timeout: 15_000 }) });
  const block = await rpc.getBlockNumber();
  const report: Record<string, unknown> = {
    test: "public verified-source and ABI discovery; read-only",
    recordedAt: new Date().toISOString(),
    chainId: await rpc.getChainId(),
    blockNumber: block.toString(),
    transactionsSubmitted: false,
    accountStateChanged: false,
    targets: [],
    sources: [],
    interpretation: [
      "Source verification is only claimed if an authoritative endpoint returns verified source/ABI metadata for the exact implementation address.",
      "An ABI discovered from an SDK package is not proof that the deployed implementation source is verified.",
      "Network errors and unsupported endpoints are inconclusive, not proof that source is absent.",
    ],
  };
  const targetRows: Record<string, unknown>[] = [];
  const sourceRows: Record<string, unknown>[] = [];
  for (const target of TARGETS) {
    const code = await rpc.getBytecode({ address: target.address as Hex });
    targetRows.push({
      ...target,
      bytecodePresent: Boolean(code && code !== "0x"),
      byteLengthBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
      runtimeBytecodeKeccak256: code && code !== "0x" ? keccak256(code) : null,
    });
    for (const base of SOURCIFY_BASES) {
      const url = base + target.address + "/metadata.json";
      const result = await getJson(url);
      const body = result.json as Record<string, any> | undefined;
      sourceRows.push({
        target: target.name,
        endpoint: base.includes("full_match") ? "Sourcify full match" : "Sourcify partial match",
        status: result.status,
        reachable: result.ok,
        metadataReturned: Boolean(body && typeof body === "object" && body.compiler && body.output),
        compiler: body?.compiler?.version ?? null,
        contractName: body?.settings?.compilationTarget ? Object.values(body.settings.compilationTarget)[0] : null,
        abiEntryCount: Array.isArray(body?.output?.abi) ? body.output.abi.length : null,
        error: result.error ?? null,
      });
    }
    for (const base of EXPLORER_APIS) {
      const sep = base.includes("?") ? "&" : "?";
      const url = base + sep + "module=contract&action=getsourcecode&address=" + target.address;
      const result = await getJson(url);
      const body = result.json as Record<string, any> | undefined;
      const rows = Array.isArray(body?.result) ? body.result : [];
      const row = rows[0] as Record<string, any> | undefined;
      sourceRows.push({
        target: target.name,
        endpoint: base.includes("etherscan.io") ? "Etherscan-compatible API (no key)" : base.includes("/tokyo/") ? "Explorer Tokyo API" : "Explorer API",
        status: result.status,
        reachable: result.ok,
        apiStatus: body?.status ?? null,
        message: typeof body?.message === "string" ? body.message.slice(0, 180) : null,
        verifiedSourceReturned: Boolean(row?.SourceCode && String(row.SourceCode).trim() !== ""),
        contractName: row?.ContractName ?? null,
        abiReturned: Boolean(row?.ABI && String(row.ABI).startsWith("[")),
        abiEntryCount: row?.ABI && String(row.ABI).startsWith("[") ? (() => { try { return JSON.parse(row.ABI).length; } catch { return null; } })() : null,
        error: result.error ?? null,
      });
    }
  }
  report.targets = targetRows;
  report.sources = sourceRows;
  report.verifiedImplementationSourceEstablished = sourceRows.some((row: any) => row.target === "LiquidationEngine implementation" && (row.metadataReturned || row.verifiedSourceReturned));
  mkdirSync("artifacts", { recursive: true });
  const output = JSON.stringify(report, null, 2) + "\n";
  writeFileSync("artifacts/liquidation-source-discovery.json", output, { mode: 0o600 });
  console.log(output);
}
main().catch((error: unknown) => {
  console.error("LIQUIDATION SOURCE DISCOVERY FAILED:", error instanceof Error ? error.message.slice(0, 300) : "unknown error");
  process.exitCode = 1;
});
