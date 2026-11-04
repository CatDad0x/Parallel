"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { parseAbiItem, type Address } from "viem";
import { vaultAbi } from "@parallel/shared";
import { useSteps } from "@/lib/hooks";

const depReq = parseAbiItem("event DepositRequested(uint256 indexed id, address indexed sender, address indexed receiver, uint256 assets)");
const redReq = parseAbiItem("event RedeemRequested(uint256 indexed id, address indexed owner, address indexed receiver, uint256 shares)");

/** Lists this user's open queued requests on a vault, with cancel buttons. */
export function PendingRequests({ vault }: { vault: Address }) {
  const { address } = useAccount();
  const client = usePublicClient();
  const steps = useSteps();
  const [reqs, setReqs] = useState<{ kind: "deposit" | "redeem"; id: bigint; amount: bigint }[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!client || !address) return;
    (async () => {
      const latest = await client.getBlockNumber();
      const from = latest > 40_000n ? latest - 40_000n : 0n;
      const out: typeof reqs = [];
      for (let f = from; f <= latest; f += 9_000n) {
        const to = f + 8_999n > latest ? latest : f + 8_999n;
        const [d, r] = await Promise.all([
          client.getLogs({ address: vault, event: depReq, args: { sender: address }, fromBlock: f, toBlock: to }),
          client.getLogs({ address: vault, event: redReq, args: { owner: address }, fromBlock: f, toBlock: to }),
        ]);
        d.forEach((l) => out.push({ kind: "deposit", id: l.args.id!, amount: l.args.assets! }));
        r.forEach((l) => out.push({ kind: "redeem", id: l.args.id!, amount: l.args.shares! }));
      }
      const live = await Promise.all(
        out.map(async (q) => {
          const entry = (await client.readContract({
            address: vault,
            abi: vaultAbi,
            functionName: q.kind === "deposit" ? "depositQueue" : "redeemQueue",
            args: [q.id],
          })) as readonly [Address, Address, bigint, bigint];
          return entry[2] > 0n ? q : null;
        }),
      );
      setReqs(live.filter(Boolean) as typeof reqs);
    })().catch(() => {});
  }, [client, address, vault, tick, steps.done]);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 10_000);
    return () => clearInterval(t);
  }, []);

  if (!reqs.length) return null;
  return (
    <div className="stack small" style={{ gap: 8 }}>
      <h3>Waiting for the market to open</h3>
      {reqs.map((q) => (
        <div key={`${q.kind}${q.id}`} className="row spread">
          <span>
            {q.kind === "deposit"
              ? `Deposit of ${(Number(q.amount) / 1e6).toLocaleString("en-AU")}`
              : `Withdrawal of ${(Number(q.amount) / 1e18).toLocaleString("en-AU", { maximumFractionDigits: 4 })} shares`}
          </span>
          <button
            className="btn small secondary"
            disabled={steps.running}
            onClick={() =>
              steps.run(
                [{ label: "Cancelling", address: vault, abi: vaultAbi, functionName: q.kind === "deposit" ? "cancelDeposit" : "cancelRedeem", args: [q.id] }],
                "Request cancelled and refunded.",
              )
            }
          >
            Cancel
          </button>
        </div>
      ))}
      {steps.error && <p className="notice error">{steps.error}</p>}
    </div>
  );
}
