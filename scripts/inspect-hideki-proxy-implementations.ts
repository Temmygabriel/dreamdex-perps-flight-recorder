import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, http, keccak256, type Address, type Hex } from "viem";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";

const RPC_URL = "https://api.hideki2.infra.testnet.somnia.network";
const CONTRACTS = [
  { name: "MarginBank", address: "0x478769e1177c0773c43a593dccc4ad15f15f1394" },
  { name: "PerpPoolFactory", address: "0xe631faee547baeE07353E290f0562ea67d856560" },
  { name: "LiquidationEngine", address: "0xa66d3c24ad4a389d863846905d8173e1017e9f4d" },
  { name: "InsuranceFund", address: "0x50826894d47c6d4f3bea38bfdc7dc5c5be171b80" },
] as const;

const SLOTS = {
  eip1967Implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  eip1967Beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  eip1967Admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
} as const;

const BEACON_ABI = [{
  type: "function",
  name: "implementation",
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "", type: "address" }],
}] as const;

function addressFromSlot(raw: Hex | undefined): Address | null {
  if (!raw || /^0x0+$/.test(raw)) return null;
  const candidate = ("0x" + raw.slice(-40)).toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(candidate) && candidate !== "0x0000000000000000000000000000000000000000"
    ? candidate as Address
    : null;
}

async function inspectCode(client: ReturnType<typeof createPublicClient>, address: Address, blockNumber: bigint) {
  const code = await client.getBytecode({ address, blockNumber });
  return {
    address,
    deployed: Boolean(code && code !== "0x"),
    byteLengthBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    runtimeBytecodeKeccak256: code && code !== "0x" ? keccak256(code) : null,
  };
}

async function main() {
  const client = createPublicClient({ chain: hidekiTestnet, transport: http(RPC_URL, { timeout: 20_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== 50383) throw new Error("Wrong RPC chain ID: expected 50383, got " + chainId);
  const blockNumber = await client.getBlockNumber();
  const results: Record<string, unknown>[] = [];

  for (const item of CONTRACTS) {
    const proxyAddress = item.address as Address;
    const proxyCode = await inspectCode(client, proxyAddress, blockNumber);
    const row: Record<string, unknown> = {
      name: item.name,
      proxyAddress,
      proxyCode,
      inspectionBlock: blockNumber.toString(),
      method: "EIP-1967 implementation, beacon, and admin storage slots",
      implementation: null,
      beacon: null,
      admin: null,
      implementationCode: null,
      beaconImplementation: null,
      beaconImplementationCode: null,
      readErrors: [],
    };
    const readErrors = row.readErrors as string[];
    try {
      const [implementationRaw, beaconRaw, adminRaw] = await Promise.all([
        client.getStorageAt({ address: proxyAddress, slot: SLOTS.eip1967Implementation as Hex, blockNumber }),
        client.getStorageAt({ address: proxyAddress, slot: SLOTS.eip1967Beacon as Hex, blockNumber }),
        client.getStorageAt({ address: proxyAddress, slot: SLOTS.eip1967Admin as Hex, blockNumber }),
      ]);
      const implementation = addressFromSlot(implementationRaw);
      const beacon = addressFromSlot(beaconRaw);
      const admin = addressFromSlot(adminRaw);
      row.implementationSlotRaw = implementationRaw ?? null;
      row.beaconSlotRaw = beaconRaw ?? null;
      row.adminSlotRaw = adminRaw ?? null;
      row.implementation = implementation;
      row.beacon = beacon;
      row.admin = admin;
      if (implementation) {
        try {
          row.implementationCode = await inspectCode(client, implementation, blockNumber);
        } catch (error) {
          readErrors.push("implementation code: " + (error instanceof Error ? error.message : "unknown error"));
        }
      }
      if (beacon) {
        try {
          const beaconImplementation = await client.readContract({
            address: beacon,
            abi: BEACON_ABI,
            functionName: "implementation",
            blockNumber,
          });
          row.beaconImplementation = beaconImplementation;
          row.beaconImplementationCode = await inspectCode(client, beaconImplementation, blockNumber);
        } catch (error) {
          readErrors.push("beacon implementation: " + (error instanceof Error ? error.message : "unknown error"));
        }
      }
    } catch (error) {
      readErrors.push("EIP-1967 storage reads: " + (error instanceof Error ? error.message : "unknown error"));
    }
    results.push(row);
  }

  const report = {
    test: "read-only Hideki proxy implementation inspection",
    recordedAt: new Date().toISOString(),
    network: { name: "Somnia Hideki testnet", chainId },
    transactionSubmitted: false,
    accountStateChanged: false,
    sourceVerificationClaimed: false,
    inspectionBlock: blockNumber.toString(),
    slots: SLOTS,
    contracts: results,
    interpretation: "A nonzero EIP-1967 implementation/beacon slot identifies a likely delegate target and its runtime bytecode hash. A zero slot does not prove the address is not a proxy; other proxy patterns require separate analysis. Bytecode presence/hash alone does not establish verified source or liquidation correctness.",
  };
  mkdirSync("artifacts", { recursive: true });
  writeFileSync("artifacts/hideki-proxy-implementation-inspection.json", JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  try { await (client as any).transport?.close?.(); } catch { /* preserve report */ }
}
main().catch((error: unknown) => {
  console.error("PROXY IMPLEMENTATION INSPECTION FAILED:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
