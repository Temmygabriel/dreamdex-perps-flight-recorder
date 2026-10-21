import { createPublicClient, defineChain, formatEther, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rpcUrl = "https://api.hideki2.infra.testnet.somnia.network";
const rawKey = process.env.WALLET_KEY?.trim();

async function main(): Promise<void> {
  if (!rawKey) {
    throw new Error("WALLET_KEY secret is missing. Add the Actions secret named wallet_key, then run this workflow manually.");
  }
  const normalized = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("WALLET_KEY must be a 32-byte hex private key. The key itself will not be printed.");
  }

  const account = privateKeyToAccount(normalized);
  const chain = defineChain({
    id: 50383,
    name: "Somnia Hideki Testnet",
    nativeCurrency: { name: "Somnia Testnet Token", symbol: "STT", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000 }) });

  const [chainId, balance] = await Promise.all([
    client.getChainId(),
    client.getBalance({ address: account.address }),
  ]);
  if (chainId !== 50383) throw new Error(`RPC chain ID mismatch: expected 50383, received ${chainId}`);

  console.log("READ-ONLY TEST WALLET CHECK");
  console.log(`Network: ${chain.name} (chain ID ${chainId})`);
  console.log(`Derived wallet address: ${account.address}`);
  console.log(`Native testnet balance: ${formatEther(balance)} STT`);
  console.log("Transaction submitted: no");
  console.log("Private key printed or written to artifact: no");
  console.log("This confirms key/address derivation and native balance only; it does not test Perps order placement.");
}

main().catch((error: unknown) => {
  console.error("WALLET CHECK FAILED:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
