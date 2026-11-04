/**
 * Parallel Markets keeper.
 *
 * Jobs (cadence configurable via env):
 *  - prices:      DemoPyth mode: simulated random walk around anchor levels, pushed every PRICE_SECS.
 *                 Real Pyth mode: fetch signed updates from Hermes (needs PYTH_API_KEY) and push.
 *  - queues:      settle queued deposits/redeems when the market is open.
 *  - rebalance:   restore weights / cash buffer / hedge ratio.
 *  - roll:        settle-and-reopen hedges (monthly, or on demand).
 *  - liquidations: scan Morpho borrowers, liquidate unhealthy positions, exit seized collateral.
 *  - poke:        NAV snapshot events for charts.
 *  - /health:     JSON status on HEALTH_PORT.
 *
 * Env: RPC_URL, KEEPER_PRIVATE_KEY, CHAIN_ID (default 31337), PYTH_API_KEY (real Pyth only),
 *      HEALTH_PORT (default 8787), DEPLOY_BLOCK (default 0).
 */
import { createServer } from "node:http";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  defineChain,
} from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";
import {
  getDeployment,
  marketParams,
  vaultAbi,
  oracleHubAbi,
  routerAbi,
  morphoAbi,
  demoPythAbi,
  exchangeAbi,
  tokenAbi,
  type MarketInfo,
} from "@parallel/shared";

// ------------------------------------------------------------------ config

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing env ${k}`);
  return v;
};
const CHAIN_ID = Number(env("CHAIN_ID", "31337"));
const RPC_URL = env("RPC_URL", "http://127.0.0.1:8545");
const PK = env(
  "KEEPER_PRIVATE_KEY",
  // anvil account #1 (local only)
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
) as Hex;
const ONCE = process.argv.includes("--once");
const PRICE_SECS = Number(env("PRICE_SECS", "30"));
const QUEUE_SECS = Number(env("QUEUE_SECS", "60"));
const REBALANCE_SECS = Number(env("REBALANCE_SECS", "300"));
const LIQ_SECS = Number(env("LIQ_SECS", "20"));
const POKE_SECS = Number(env("POKE_SECS", "900"));
const ROLL_DAYS = Number(env("ROLL_DAYS", "30"));
const HEALTH_PORT = Number(env("HEALTH_PORT", "8787"));
const DEPLOY_BLOCK = BigInt(env("DEPLOY_BLOCK", "0"));

const d = getDeployment(CHAIN_ID);
const chain =
  CHAIN_ID === 84532 ? baseSepolia : CHAIN_ID === 31337 ? foundry : defineChain({ ...foundry, id: CHAIN_ID });
const account = privateKeyToAccount(PK, { nonceManager }); // safe for concurrent lanes
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const wallet = createWalletClient({ chain, transport: http(RPC_URL), account });

// ------------------------------------------------------------------ status + logging

const status: Record<string, { lastRun?: string; lastOk?: string; lastError?: string; info?: unknown }> = {};
const log = (job: string, msg: string) => console.log(`${new Date().toISOString()} [${job}] ${msg}`);

async function job(name: string, fn: () => Promise<unknown>) {
  const s = (status[name] ??= {});
  s.lastRun = new Date().toISOString();
  try {
    const info = await fn();
    s.lastOk = s.lastRun;
    if (info !== undefined) s.info = info;
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    s.lastError = `${s.lastRun} ${msg}`;
    log(name, `error: ${msg}`);
  }
}

async function send(address: Address, abi: any, functionName: string, args: unknown[] = []) {
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account } as any);
  const hash = await wallet.writeContract(request as any);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  return hash;
}

const marketOpen = () =>
  pub.readContract({ address: d.oracleHub, abi: oracleHubAbi, functionName: "isMarketOpen" }) as Promise<boolean>;

// ------------------------------------------------------------------ prices

/** Annualised vol per feed for the simulated walk, and anchors (expo -5) it mean-reverts to. */
const SIM: Record<string, { vol: number; anchor?: number }> = {
  SPY: { vol: 0.16 },
  AAPL: { vol: 0.28 },
  MSFT: { vol: 0.25 },
  NVDA: { vol: 0.5 },
  AMZN: { vol: 0.32 },
  GOOGL: { vol: 0.3 },
  AUD: { vol: 0.1 },
  EUR: { vol: 0.07 },
  INR: { vol: 0.05 },
};

function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

async function pushDemoPrices() {
  const ids = d.feeds.map((f) => f.pythId);
  const current = await Promise.all(
    ids.map(
      (id) =>
        pub.readContract({ address: d.pyth, abi: demoPythAbi, functionName: "getPriceUnsafe", args: [id] }) as Promise<{
          price: bigint;
        }>,
    ),
  );
  const dt = PRICE_SECS / (365 * 24 * 3600);
  const next = d.feeds.map((f, i) => {
    const cfg = SIM[f.name] ?? { vol: 0.2 };
    const p = Number(current[i].price);
    cfg.anchor ??= p; // first observed level = anchor
    const reversion = 0.5 * Math.log(cfg.anchor / p) * dt * 50; // gentle pull back to anchor
    const shock = cfg.vol * Math.sqrt(dt) * gaussian();
    return BigInt(Math.max(1, Math.round(p * Math.exp(reversion + shock))));
  });
  await send(d.pyth, demoPythAbi, "setPrices", [ids, next, -5]);
  return Object.fromEntries(d.feeds.map((f, i) => [f.name, Number(next[i]) / 1e5]));
}

async function pushPythPrices() {
  const key = env("PYTH_API_KEY");
  const qs = d.feeds.map((f) => `ids[]=${f.pythId}`).join("&");
  const res = await fetch(`https://pyth.dourolabs.app/hermes/v2/updates/price/latest?${qs}&encoding=hex`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Hermes ${res.status}`);
  const body = (await res.json()) as { binary: { data: string[] } };
  const data = body.binary.data.map((x) => (x.startsWith("0x") ? x : `0x${x}`) as Hex);
  const fee = (await pub.readContract({
    address: d.pyth,
    abi: [parseAbiItem("function getUpdateFee(bytes[]) view returns (uint256)")],
    functionName: "getUpdateFee",
    args: [data],
  })) as bigint;
  const { request } = await pub.simulateContract({
    address: d.oracleHub,
    abi: oracleHubAbi,
    functionName: "updatePrices",
    args: [data],
    value: fee,
    account,
  });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
  return { feeds: data.length };
}

// ------------------------------------------------------------------ vault jobs

async function settleQueues() {
  if (!(await marketOpen())) return "market closed";
  let settled = 0;
  for (const v of d.vaults) {
    const [deps, reds] = (await pub.readContract({
      address: v.address,
      abi: vaultAbi,
      functionName: "queueLengths",
    })) as [bigint, bigint];
    if (deps + reds > 0n) {
      await send(v.address, vaultAbi, "processQueue", [50n]);
      settled += Number(deps + reds);
      log("queues", `${v.symbol}: processed ${deps + reds}`);
    }
  }
  return { settled };
}

async function rebalanceAll() {
  if (!(await marketOpen())) return "market closed";
  for (const v of d.vaults) {
    await job(`rebalance:${v.symbol}`, () => send(v.address, vaultAbi, "rebalance"));
  }
}

let lastRoll = Date.now();
async function rollIfDue(force = false) {
  if (!force && Date.now() - lastRoll < ROLL_DAYS * 86_400_000) return "not due";
  if (!(await marketOpen())) return "market closed";
  for (const v of d.vaults.filter((x) => x.hedged)) await send(v.address, vaultAbi, "rollHedge");
  lastRoll = Date.now();
  return "rolled";
}

async function pokeAll() {
  for (const v of d.vaults) await send(v.address, vaultAbi, "poke");
}

// ------------------------------------------------------------------ liquidations

const borrowEvent = parseAbiItem(
  "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
);
const borrowers = new Map<Hex, Set<Address>>();
let scannedTo = DEPLOY_BLOCK > 0n ? DEPLOY_BLOCK - 1n : -1n;

async function refreshBorrowers() {
  const latest = await pub.getBlockNumber();
  const step = 9_000n;
  for (let from = scannedTo + 1n; from <= latest; from += step) {
    const to = from + step - 1n > latest ? latest : from + step - 1n;
    const logs = await pub.getLogs({ address: d.morpho, event: borrowEvent, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const id = l.args.id as Hex;
      if (!borrowers.has(id)) borrowers.set(id, new Set());
      borrowers.get(id)!.add(l.args.onBehalf as Address);
    }
    scannedTo = to;
  }
}

async function exitCollateral(m: MarketInfo, amount: bigint, open: boolean) {
  const vault = d.vaults.find((v) => v.address.toLowerCase() === m.collateralToken.toLowerCase());
  if (vault) {
    // Vault-share collateral: redeem when open, otherwise queue for the next open.
    if (open) await send(vault.address, vaultAbi, "redeem", [amount, account.address, account.address]);
    else await send(vault.address, vaultAbi, "requestRedeem", [amount, account.address, 0n]);
    return open ? "redeemed" : "queued redeem";
  }
  // Equity collateral: sell via SimExchange when open, otherwise hold until open.
  if (!open) return "holding equity until open";
  await send(d.exchange, exchangeAbi, "sellEquity", [m.collateralToken, m.loanToken, amount, 0n, account.address]);
  return "sold";
}

async function liquidate() {
  await refreshBorrowers();
  const open = await marketOpen();
  const done: string[] = [];
  for (const m of d.markets) {
    const users = borrowers.get(m.id);
    if (!users?.size) continue;
    const mp = marketParams(m);
    for (const user of users) {
      const hf = (await pub.readContract({
        address: d.router,
        abi: routerAbi,
        functionName: "healthFactor",
        args: [mp, user],
      })) as bigint;
      if (hf >= 10n ** 18n) continue;

      const pos = (await pub.readContract({
        address: d.morpho,
        abi: morphoAbi,
        functionName: "position",
        args: [m.id, user],
      })) as readonly [bigint, bigint, bigint];
      const borrowShares = pos[1];
      if (borrowShares === 0n) continue;

      // Repay half the debt (or all of it for dust positions).
      const repayShares = borrowShares > 10n ** 12n ? borrowShares / 2n : borrowShares;
      await ensureAllowance(m.loanToken, d.morpho);
      const before = (await pub.readContract({
        address: m.collateralToken,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [account.address],
      })) as bigint;
      await send(d.morpho, morphoAbi, "liquidate", [mp, user, 0n, repayShares, "0x"]);
      const after = (await pub.readContract({
        address: m.collateralToken,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [account.address],
      })) as bigint;
      const seized = after - before;
      const exit = await exitCollateral(m, seized, open);
      const line = `${m.label}: liquidated ${user} (hf ${(Number(hf) / 1e18).toFixed(3)}), seized ${seized}, ${exit}`;
      log("liquidate", line);
      done.push(line);
    }
  }
  return { liquidations: done.length, last: done.at(-1) };
}

const approved = new Set<string>();
async function ensureAllowance(token: Address, spender: Address) {
  const k = `${token}:${spender}`;
  if (approved.has(k)) return;
  await send(token, tokenAbi, "approve", [spender, 2n ** 255n]);
  approved.add(k);
}

// ------------------------------------------------------------------ main

async function tick(name: string, fn: () => Promise<unknown>) {
  await job(name, fn);
}

async function main() {
  log("boot", `chain ${CHAIN_ID}, keeper ${account.address}, ${d.demoPyth ? "DemoPyth (simulated prices)" : "Pyth"}`);
  const prices = d.demoPyth ? pushDemoPrices : pushPythPrices;

  if (ONCE) {
    await tick("prices", prices);
    await tick("queues", settleQueues);
    await tick("rebalance", rebalanceAll);
    await tick("liquidate", liquidate);
    await tick("poke", pokeAll);
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("access-control-allow-origin", "*");
    if (req.url === "/roll") {
      void tick("roll", () => rollIfDue(true));
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.end(JSON.stringify({ ok: true, keeper: account.address, chainId: CHAIN_ID, status }, null, 2));
  }).listen(HEALTH_PORT, () => log("boot", `health on :${HEALTH_PORT}`));

  // Two lanes: prices + liquidations stay fast; slower maintenance runs in its own queue.
  // Within a lane jobs never overlap; the nonce manager keeps concurrent lanes safe.
  const lane = () => {
    let busy: Promise<unknown> = Promise.resolve();
    const running = new Set<string>();
    return (name: string, secs: number, fn: () => Promise<unknown>) => {
      const run = () => {
        if (running.has(name)) return; // skip if the previous run of this job is still going
        running.add(name);
        busy = busy.then(() => tick(name, fn)).finally(() => running.delete(name));
      };
      run();
      setInterval(run, secs * 1000);
    };
  };
  const fast = lane();
  const slow = lane();
  fast("prices", PRICE_SECS, prices);
  fast("liquidate", LIQ_SECS, liquidate);
  slow("queues", QUEUE_SECS, settleQueues);
  slow("rebalance", REBALANCE_SECS, rebalanceAll);
  slow("roll", 3600, () => rollIfDue());
  slow("poke", POKE_SECS, pokeAll);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
