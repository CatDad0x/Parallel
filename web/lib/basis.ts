"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { decodeEventLog, parseAbiItem, type Address, type Hex } from "viem";
import { deployment, DEPLOY_BLOCK } from "./config";

const ev = {
  deposit: parseAbiItem("event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)"),
  withdraw: parseAbiItem("event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)"),
  settledD: parseAbiItem("event DepositSettled(uint256 indexed id, address indexed receiver, uint256 assets, uint256 shares)"),
  settledR: parseAbiItem("event RedeemSettled(uint256 indexed id, address indexed receiver, uint256 shares, uint256 assets)"),
  routed: parseAbiItem("event DepositedWith(address indexed user, address indexed vault, address token, uint256 amount, uint256 shares)"),
  nav: parseAbiItem("event NavSnapshot(uint256 nav, uint256 navPerShare, uint256 equityValue, int256 hedgeMtm, uint256 cash, uint256 usdPerLocal, uint256 timestamp)"),
};

interface Basis {
  net: number; // local currency deposited minus withdrawn
  fx0?: number; // usdPerLocal at first deposit
}

/** Net contributions per vault from onchain events, plus the FX rate at the user's first deposit. */
export function useBasis(user?: Address) {
  const client = usePublicClient();
  const [basis, setBasis] = useState<Record<string, Basis>>({});
  useEffect(() => {
    if (!client || !user) return;
    (async () => {
      const latest = await client.getBlockNumber();
      const start = (latest > 60_000n ? latest - 60_000n : 0n) > DEPLOY_BLOCK ? (latest > 60_000n ? latest - 60_000n : 0n) : DEPLOY_BLOCK;
      const out: Record<string, Basis & { firstTx?: Hex; firstBlock?: bigint }> = {};
      const add = (v: string, amt: number, tx?: Hex, block?: bigint) => {
        const b = (out[v.toLowerCase()] ??= { net: 0 });
        b.net += amt;
        if (amt > 0 && tx && (b.firstBlock === undefined || (block ?? 0n) < b.firstBlock)) {
          b.firstTx = tx;
          b.firstBlock = block;
        }
      };
      const vaults = deployment.vaults.map((v) => v.address);
      for (let f = start; f <= latest; f += 9_000n) {
        const to = f + 8_999n > latest ? latest : f + 8_999n;
        const [d, w, sd, sr, r] = await Promise.all([
          client.getLogs({ address: vaults, event: ev.deposit, args: { owner: user }, fromBlock: f, toBlock: to }),
          client.getLogs({ address: vaults, event: ev.withdraw, args: { owner: user }, fromBlock: f, toBlock: to }),
          client.getLogs({ address: vaults, event: ev.settledD, args: { receiver: user }, fromBlock: f, toBlock: to }),
          client.getLogs({ address: vaults, event: ev.settledR, args: { receiver: user }, fromBlock: f, toBlock: to }),
          client.getLogs({ address: deployment.router, event: ev.routed, args: { user }, fromBlock: f, toBlock: to }),
        ]);
        // Router deposits emit Deposit(owner=user) and DepositedWith; count router flows once via DepositedWith.
        d.filter((l) => l.args.sender!.toLowerCase() !== deployment.router.toLowerCase()).forEach((l) =>
          add(l.address, Number(l.args.assets) / 1e6, l.transactionHash, l.blockNumber),
        );
        r.forEach((l) => add(l.args.vault!, Number(l.args.amount) / 1e6, l.transactionHash, l.blockNumber));
        sd.forEach((l) => add(l.address, Number(l.args.assets) / 1e6, l.transactionHash, l.blockNumber));
        w.forEach((l) => add(l.address, -Number(l.args.assets) / 1e6));
        sr.forEach((l) => add(l.address, -Number(l.args.assets) / 1e6));
      }
      // FX at first deposit = the NavSnapshot emitted in that transaction.
      await Promise.all(
        Object.entries(out).map(async ([v, b]) => {
          if (!b.firstTx) return;
          const rc = await client.getTransactionReceipt({ hash: b.firstTx });
          for (const lg of rc.logs) {
            if (lg.address.toLowerCase() !== v) continue;
            try {
              const dec = decodeEventLog({ abi: [ev.nav], data: lg.data, topics: lg.topics });
              b.fx0 = Number(dec.args.usdPerLocal) / 1e18;
            } catch {}
          }
        }),
      );
      setBasis(out);
    })().catch(() => {});
  }, [client, user]);
  return basis;
}

