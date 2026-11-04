import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, isAddress, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { faucetAbi } from "@parallel/shared";
import { chain, RPC_URL, deployment } from "@/lib/config";

/**
 * Sponsored onboarding: sends a little test ETH for gas (if the user has almost none) and claims the
 * faucet bundle on their behalf. Requires RELAYER_PRIVATE_KEY (a funded testnet-only key).
 */
const GAS_DRIP = parseEther("0.002");
const MIN_BALANCE = parseEther("0.0005");

export async function POST(req: Request) {
  const key = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!key) return NextResponse.json({ error: "Sponsored onboarding is not configured." }, { status: 501 });

  const { address } = (await req.json().catch(() => ({}))) as { address?: string };
  if (!address || !isAddress(address)) return NextResponse.json({ error: "Invalid address." }, { status: 400 });

  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain, transport: http(RPC_URL) });
  const wallet = createWalletClient({ chain, transport: http(RPC_URL), account });

  const next = (await pub.readContract({
    address: deployment.faucet,
    abi: faucetAbi,
    functionName: "nextClaimAt",
    args: [address as Address],
  })) as bigint;
  const { timestamp } = await pub.getBlock();
  if (next > timestamp) {
    return NextResponse.json({ error: "Test funds were already claimed in the last 24 hours." }, { status: 429 });
  }

  const result: { gas?: Hex; claim?: Hex } = {};
  const bal = await pub.getBalance({ address: address as Address });
  if (bal < MIN_BALANCE) {
    result.gas = await wallet.sendTransaction({ to: address as Address, value: GAS_DRIP });
    await pub.waitForTransactionReceipt({ hash: result.gas });
  }
  result.claim = await wallet.writeContract({
    address: deployment.faucet,
    abi: faucetAbi,
    functionName: "claimFor",
    args: [address as Address],
  });
  await pub.waitForTransactionReceipt({ hash: result.claim });
  return NextResponse.json({ ok: true, ...result });
}
