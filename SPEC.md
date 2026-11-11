# Parallel Markets — MVP Build Spec

**Local-currency access to US equities, with optional FX hedging and borrowing against your position.**

Status: v0.3 implemented and tested locally; **v0.4 product direction agreed 4 Nov 2026, not yet built (see §14)**; awaiting Base Sepolia deployment · Target: working demo on **Base Sepolia** · Audience: AUDD / AUDM teams, investors, partners

---

## 0. Purpose and scope

### Goal
A fully working, publicly accessible **testnet demo** that shows the complete user journey:

1. Deposit a local-currency stablecoin (AUDD, AUDM, AUDC, EURC, INR).
2. Invest in US equities (S&P 500 index or a stock basket), **hedged or unhedged** against USD.
3. See the position valued in your own currency.
4. **Borrow** local stablecoins against equity tokens or vault shares.
5. Watch risk controls work live (price shocks, liquidations, market-closed behaviour).

### Non-goals (MVP)
- No mainnet deployment, no real user funds, no real equity tokens.
- No real FX hedge. The hedge is **simulated onchain** with a live FX feed. In production it would be held offchain with an institutional counterparty (ISDA/CSA).
- No governance token, no audits, no KYC.
- The vault-share oracle is not manipulation-proof (§4.9), and market-hours borrowing limits are interface-level only (§5.4).

### Hard rules
- Every asset is a **mock token**, labelled as such in the UI ("Testnet demo · mock assets").
- The UI never implies it is an official AUDD/AUDM product.
- Contracts are Solidity, tested with Foundry. Target 90%+ line coverage on core contracts.

---

## 1. Decisions locked in

> **v0.4 changes** to the table below (hedged only, 6 vaults, new exit mechanism and lending scope) are in §14.

| Area | Decision |
|---|---|
| Chain | Base Sepolia |
| Deposit assets | mAUDD, mAUDM, mAUDC* (AUD group), mEURC (EUR), mINR (INR). *See §12 item 4. |
| Strategies | S&P 500 index (`mSPY`) and a 5-stock basket |
| Hedge | Each strategy offered **hedged** and **unhedged** |
| Vault count | 3 currencies × 2 strategies × 2 hedge modes = **12 vaults**, from one factory |
| Lending | **Morpho Blue** (existing Base Sepolia deployment if available, otherwise self-deployed) |
| Prices | **Pyth** live feeds plus an admin override for staged shocks |
| Access | Email login (embedded wallet) **and** external wallet connect, with gas sponsored |
| Build | Hybrid: spec and core contracts built in chat, then continued locally with Claude Code |

---

## 2. System overview

```
                 ┌───────────────────────────── Frontend (Next.js) ─────────────────────────────┐
                 │  Onboard/Faucet · Vaults · Portfolio · Borrow · Lend · Simulator · Admin       │
                 └──────────────┬──────────────────────────────┬─────────────────────────────────┘
                                │                              │
                         ParallelRouter                    Indexer (Ponder)
                                │
   ┌───────────────┬────────────┼──────────────┬──────────────────┬──────────────────┐
   │               │            │              │                  │                  │
 Faucet      VaultFactory   ParallelVault ×12   HedgeBook      SimExchange       Morpho Blue
   │               │            │              │                  │           (markets + IRM)
   │               └────────────┴──────┬───────┴──────────────────┘                  │
   │                                   │                                              │
   └──────── Mock tokens ──────── OracleHub (Pyth + overrides + market hours) ── Morpho oracle adapters
                                                   ▲
                                              Keeper bot (Pyth updates, hedge rebalance,
                                              queue settlement, liquidations, NAV snapshots)
```

---

## 3. Conventions

- **Price convention:** all FX is stored as **USD per 1 unit of local currency** (`usdPerLocal`), 18 decimals. Pyth's `USD/INR` is inverted on ingest.
- **Equity prices:** USD per token, 18 decimals.
- **Token decimals:** mock stables use 6, mock equities use 18. Vault shares use 18 decimals (ERC-4626 decimals offset).
- **Local value of USD amount:** `local = usd / usdPerLocal`.
- **Roles:** `ADMIN` (deployer multisig or EOA for the demo), `KEEPER` (bot), `VAULT` (registered vaults).

---

## 4. Contracts

### 4.1 Mock tokens — `MockStable`, `MockEquity`
- ERC-20 + ERC-20Permit. Mint/burn restricted to `MINTER` role, granted to `Faucet`, `SimExchange` and `HedgeBook`.
- Stables: `mAUDD`, `mAUDM`, `mAUDC`, `mEURC`, `mINR` (6 dp).
- Equities: `mSPY`, and basket `mAAPL`, `mMSFT`, `mNVDA`, `mAMZN`, `mGOOGL` (18 dp).

### 4.2 `Faucet`
- `claim()`: mints a fixed bundle per address per 24 h (e.g. 10,000 of each AUD coin, 10,000 mEURC, 500,000 mINR, plus a small amount of mSPY for borrow demos).
- Admin can adjust amounts and cooldown.

### 4.3 `OracleHub`
Single source of truth for prices.

```solidity
function equityPriceUsd(address token) external view returns (uint256 price, uint256 updatedAt);
function usdPerLocal(bytes32 currency) external view returns (uint256 rate, uint256 updatedAt);
function priceStatus(bytes32 key) external view returns (uint256 price, uint256 updatedAt, bool marketOpen, bool overridden);
function isMarketOpen() external view returns (bool);
```

- **Normalisation:** Pyth `price × 10^expo` is scaled to 18 dp. Prices must be positive, and the confidence interval must be within `maxConfBps` (default 2%) of the price, or the read reverts. Inverted feeds (USD/INR) are flipped to USD per local.
- **Override:** `setOverride(key, price, expiry)` by ADMIN replaces Pyth until expiry. `shock(key, bps, duration)` sets it to current × (1 + bps). Overrides only exist for staged demos.
- **Staleness (fail-closed):** while the market is open, Pyth data older than `maxAge` (15 min) reverts. Every vault operation that values the portfolio (deposit, redeem, rebalance, queue settlement) is therefore disabled until the keeper pushes fresh prices. `totalAssets()` also reverts in that state. Frontends treat a revert as "prices updating".
- **Override recovery:** when an override expires, the live Pyth price applies again. If that price is stale, operations stay disabled (fail-closed) until the keeper pushes an update. The keeper pushes before shocks expire.
- **Market closed:** the last published price is returned (the "last close"). The status flag is exposed through `priceStatus`, not the price return value.
- **Market hours:** `AUTO` (NYSE weekday 09:30–16:00 ET, admin-set UTC offset for DST, holiday list), `FORCE_OPEN` or `FORCE_CLOSED`.

### 4.4 `SimExchange`
An oracle-priced execution venue that stands in for real market makers.

- `buyEquity(localToken, currency, equity, localIn, minOut)`: burns local stable, mints equity at oracle price × (1 + `spreadBps`).
- `sellEquity(...)`: the reverse, at oracle price × (1 − `spreadBps`).
- `swapStable(fromLocal, toLocal, amount)`: converts between AUD coins at par (minus `pegFeeBps`, default 0).
- Reverts on equity trades when the market is closed.
- Default spread 10 bps (configurable), so the demo shows realistic execution cost.

### 4.5 `HedgeBook` (spot-based hedge simulation with accrued carry)
Tracks one position per hedged vault: **short USD / long local**. This is a *simulation*: it is marked against spot FX with a carry accrual. It is not a priced forward contract (no maturity, forward points or valuation curve). A production version would hold real forwards with an institutional counterparty.

State per vault: `notionalUsd` (N), `strike` (K, USD per local), `lastAccrual`. Carry is set per currency.

- **MTM (local):** `N × (1/K − 1/S_t) − N/K × carryBps × Δt / year`. When the local currency strengthens (S rises), the hedge gains.
- **One adjustment rule (settle and reopen):** every `adjust(newNotional)` (a) realises the *entire* current MTM into the vault's cash (minted on gain, burned on loss), then (b) reopens the full position at `newNotional` with strike = spot. No P&L is ever erased, because it is always settled before re-striking. Increases, decreases and rolls all use this same rule.
- **Roll = settle and reopen, not close.** A monthly roll leaves the vault hedged at the target notional. Only a redemption of the whole vault takes notional to zero.
- **Funding losses:** before a loss is settled, the vault sells equities pro-rata until cash covers it (`_ensureCash`). The 3% buffer is a liquidity cushion, not the loss-funding mechanism. Tested at AUD −30%.
- **Market closed:** no settlement happens (rebalance and roll require an open market). Unrealised MTM stays in NAV until the next open.

### 4.6 `ParallelVault` (ERC-4626, ×12)
One contract, configured at init:

```solidity
struct VaultConfig {
  bytes32 currency;          // "AUD" | "EUR" | "INR"
  IERC20  asset;             // canonical local stable (mAUDD for AUD vaults)
  address[] equities;        // [mSPY] or the basket
  uint16[] weightsBps;       // sums to 10_000
  bool    hedged;
  uint16  targetHedgeBps;    // 10_000 = fully hedged
  uint16  hedgeDriftBps;     // rebalance trigger, default 300
  uint16  cashBufferBps;     // default 300 — liquidity for hedge losses + small redemptions
  uint16  mgmtFeeBps;        // default 50 (0.50% p.a.)
}
```

**NAV (local currency):**
```
NAV = Σ(equityQty_i × priceUsd_i) / usdPerLocal     (mid price)
    + cash                                          (local stable held, EXCLUDING queued deposits)
    + hedgeMtm                                      (0 if unhedged)
navPerShare = NAV / (totalSupply + pendingFeeShares)
```
There is no fee deduction in NAV. The management fee is charged **only** by dilution (see Fees).

**Who pays trading costs:**
- **Deposit:** shares are minted on `assets − entryCost`, where `entryCost = assets × spread × investedFraction` (≈ 9.7 bps with a 10 bps spread and 3% buffer). The newcomer bears their own execution cost.
- **Redeem:** pays `assets − exitCost`, where `exitCost = assets × spread × equityValue / NAV`. When hedge losses push gross equity above NAV, the exit charge scales up, so remaining holders never fund an exit.
- `previewDeposit` and `previewRedeem` match execution exactly (tested, including after fee accrual). `mint` and `withdraw` are unsupported, because exact-output flows can't be priced without a quote. Slippage limits for instant flows go in the router (`minShares` / `minAssets`).

**Instant flows (market open):** deposit buys equities by weight, keeps the cash buffer and resizes the hedge. Redeem sells a pro-rata slice of equities, resizes the hedge (realising MTM) and pays out.

**Queued flows (market closed).** This is a custom async queue inspired by ERC-7540; it does **not** claim ERC-7540 compliance.
- `requestDeposit(assets, receiver, minShares)`: assets are held in the vault but tracked in `pendingDepositAssets` and excluded from NAV and `cash()`.
- `requestRedeem(shares, receiver, minAssets)`: shares are escrowed in the vault.
- **Ownership:** the requester is the request owner and can `cancelDeposit` / `cancelRedeem` at any time before settlement.
- **Settlement:** the keeper calls `processQueue(maxItems)` at the next open and settles at the then-current NAV with the normal entry/exit costs.
- **Limits:** if a request's `minShares` / `minAssets` isn't met, it fails and is refunded to the owner. Settlement is all-or-nothing, with no partial fills.
- **Claiming:** push model. Shares or assets are sent to the receiver on settlement; there's no separate claim step.

**Rebalancing (keeper `rebalance()`):** restore basket weights (±5% drift), restore the cash buffer (top up or invest excess) and resize the hedge if it drifts more than 3% from target. `rollHedge()` settles and reopens.

**Fees:** management fee (0.50% p.a.) is charged by minting shares to the treasury. Pending fee shares are included in share pricing so previews are exact, and they're minted on every state-changing call.

**Events:** `NavSnapshot(nav, navPerShare, equityValue, hedgeMtm, cash, usdPerLocal, timestamp)` on every state change and `poke()`.

**Inflation-attack protection:** ERC-4626 virtual shares (decimals offset 12). This addresses the first-depositor donation attack on share pricing.

### 4.7 `VaultFactory`
- **Proxy pattern:** EIP-1167 minimal clones of a single `ParallelVault` implementation. Clones are **not upgradeable**, so there is no upgrade authority. The implementation's constructor disables initialisers, and each clone is initialised atomically in `createVault`.
- `createVault` (ADMIN only) initialises the clone, registers it with the HedgeBook (the factory holds `REGISTRAR_ROLE`) and grants the keeper role.
- `vaults()` / `vaultsByCurrency()` for the frontend.

### 4.8 `ParallelRouter`
The UX layer and the single entry point the frontend uses.

- `depositWith(vault, token, amount)`: accepts any token in the vault's currency group (e.g. mAUDM → swaps to mAUDD at par → deposits).
- `redeemTo(vault, shares, outToken)`.
- Morpho helpers: `supplyCollateralAndBorrow`, `repayAndWithdraw`, `depositToVaultAndBorrow` (one-click "invest, then borrow against it").
- **Borrow gate:** blocks new borrows when `!isMarketOpen()` (repay and add collateral are always allowed). See limitation in §5.4.
- Single-signature flows (permit + multicall, or batched calls via smart wallets) are used **where the wallet and token support them**. Otherwise the UI falls back to approve-then-call.
- Instant deposit/redeem helpers take `minShares` / `minAssets` slippage limits.

### 4.9 Morpho oracle adapters
Morpho Blue expects `price()` = the price of **one whole collateral token in whole loan tokens**, scaled by `10^(36 + d_loan − d_collateral)`.

- `EquityOracleAdapter(equity, currency)`: whole-token price = `equityUsd / usdPerLocal`. mSPY (18 dp) against mAUDD (6 dp) gives a scale of `10^24`.
- `VaultShareOracleAdapter(vault)`: whole-token price = `navPerShare` (assets per 10^18 shares). Shares (18 dp) against mAUDD (6 dp) gives a scale of `10^24`.

**What this does and doesn't protect against.** ERC-4626 virtual shares stop the classic first-depositor inflation attack. In the Phase 1 implementation, cash and equity holdings are read with `balanceOf`, so a direct donation **does** raise NAV per share. The donor gives value to every holder pro-rata, so the attack only pays off for an attacker who owns most of the supply and is borrowing against it. Phase 2 hardening: switch to tracked internal balances so donations are ignored. Either way, the oracle is **not** manipulation-proof. NAV still depends on equity balances, Pyth prices (or admin overrides on testnet), hedge MTM, pending fee shares and the exclusion of queued assets. A compromised price feed or admin key moves the oracle directly. On testnet the admin can do this deliberately, which is what the demo shocks are.

---

## 5. Lending---

## 5. Lending (Morpho Blue)

### 5.1 Deployment
- **Finding (11 Nov 2026):** the canonical Morpho Blue on Base Sepolia and Base mainnet only allows governance-enabled LLTVs (38.5%, 62.5%, 77%) and IRMs, so our 50% / 60% LLTVs and KinkedIrm cannot be used there. The testnet therefore deploys its own Morpho copy (leave `MORPHO_ADDRESS` unset). On mainnet we would need governance enablement or different LLTVs.
- Original plan: use the canonical Morpho Blue deployment on Base Sepolia if one exists. Otherwise deploy `morpho-org/morpho-blue` (check the licence) and enable the required LLTVs and IRM.
- IRM: deploy a simple kinked IRM (`base 2%`, `slope1` to 8% at 80% utilisation, `slope2` steep above that). The AdaptiveCurveIRM is acceptable if already deployed.

### 5.2 Initial markets
**Superseded by §14.3–14.4:** same-currency markets per collateral, with LTVs to be back-tested. The table below is the v0.3 build.

**All parameters are illustrative, pending proper risk calibration.** Morpho market parameters, including LLTV, are immutable once a market is created, so these are chosen deliberately for the demo.

| Loan | Collateral | Max opening LTV (router/UI) | Liquidation LTV (LLTV) |
|---|---|---|---|
| mAUDD | mSPY | 45% | 62.5% |
| mAUDD | AUD Hedged Index vault shares | 55% | 77% |
| mAUDD | AUD Unhedged Index vault shares | 45% | 62.5% |
| mEURC | mSPY | 45% | 62.5% |
| mINR | mSPY | 45% | 62.5% |

**How to describe the hedged LLTV.** Hedging removes one source of local-currency volatility, which is why the demo shows a higher threshold. It also adds hedge execution, counterparty, margin and liquidity dependencies, and the exit path for vault shares is slower (§5.5). The 77% figure demonstrates the mechanism; it is not a claim that 77% is appropriate. The UI always shows opening LTV and liquidation LTV as separate, labelled numbers.

### 5.3 Liquidity
The deployer seeds each market's supply side, and the faucet lets demo users become lenders too. The Lend screen shows supply APY and utilisation.

### 5.4 Market-hours restriction: demo position
**Decision:** the demo uses standard Morpho Blue markets. The borrowing restriction during US market closures is enforced **only by the Parallel Markets interface and router**, and the UI says so plainly ("Borrowing paused while US markets are closed — interface-level control"). Anyone calling Morpho directly can still borrow. It is never presented as protocol-level protection.

Why not enforce it in the oracle: an oracle that reverts while closed would also block liquidations and collateral withdrawals. A production version needs a lending implementation (or market wrapper with exclusive access) that enforces the restriction for borrows only.

### 5.5 Liquidations
The keeper monitors positions and calls `Morpho.liquidate`, repaying loan tokens and receiving collateral plus Morpho's liquidation incentive. It holds a mock-stable inventory from the admin. The exit path depends on the collateral:

| Collateral | Exit after seizure | When can cash be recovered | Notes |
|---|---|---|---|
| **Equity token (mSPY)** | Sell via SimExchange | Market open: immediately. Closed: hold until open. | Exposure to the overnight/weekend gap is borne by the liquidator. |
| **Unhedged vault shares** | `redeem` (open) or `requestRedeem` (closed) | Open: immediately, minus exit cost. Closed: at the next open via the queue. | Liquidator carries equity + FX risk while queued. |
| **Hedged vault shares** | Same as unhedged; the vault unwinds equities **and** resizes the hedge on redemption | Same as unhedged. | Exit cost scales with gross equity/NAV after hedge losses; the liquidator carries equity risk only while queued. |

Implications the demo makes visible:
- A liquidator may receive collateral today and recover cash later. Keeper inventory covers that gap.
- The liquidation incentive must exceed the expected exit cost plus queue-period risk. This is part of why vault-share LLTVs are illustrative.
- Bad debt (collateral worth less than the debt) is socialised to suppliers by Morpho. The demo can trigger it with an extreme shock and shows it explicitly.

---

## 6. Keeper bot (`/keeper`, TypeScript + viem)

| Job | Cadence |
|---|---|
| Push Pyth price updates (Hermes → `updatePriceFeeds`) | every 60 s when market open, 10 min when closed |
| `vault.rebalance()` where drift exceeds threshold | every 5 min |
| Settle deposit/redeem queues | at market open, then every 5 min |
| Hedge roll (`HedgeBook.settle`) | monthly, plus a manual admin trigger |
| Liquidation scan | every 30 s |
| NAV snapshot poke | every 15 min |

- Hosting: Railway/Render or a small VPS. The key is in env vars, using a dedicated testnet-only keeper wallet.
- Logs and a `/health` endpoint feed the admin dashboard.

---

## 7. Indexer (`/indexer`, Ponder)
Indexes `NavSnapshot`, deposits/redeems, queue events, hedge adjustments and Morpho events for Parallel Markets markets. It exposes GraphQL for portfolio history, NAV charts and the activity feed.

---

## 8. Frontend (`/web`)

**Stack:** Next.js (App Router), TypeScript, wagmi + viem, **Privy** (email login plus external wallets), **Coinbase Developer Platform paymaster** for gas sponsorship (users never need test ETH), Tailwind + shadcn/ui, Recharts.

**Persistent banner:** "Testnet demo · mock assets · not a live financial product."

### Screens

1. **Landing:** the proposition in one line, a 3-step explainer and a "Try it" CTA.
2. **Onboarding:** sign in, pick a home currency (AUD/EUR/INR) and claim faucet tokens in one click. Home currency sets display defaults everywhere.
3. **Vaults:** cards for the 4 vaults in the user's currency: Index/Basket × Hedged/Unhedged. Each shows NAV per share, return since launch in local currency (history before launch is **labelled simulated**), hedge ratio, fee and a mini chart. There's a toggle to see other currencies.
4. **Vault detail:** holdings and weights, NAV chart with an equity-vs-FX contribution breakdown, hedge panel (notional, MTM, carry), deposit/redeem with a token selector (AUDD/AUDM/AUDC), a preview (shares, spread, fees) and queue status when the market is closed.
5. **Portfolio:** total value in local currency, positions, P&L split into **equity return / FX effect / hedge P&L / fees**, and an activity feed.
6. **Borrow:** choose collateral (mSPY or vault shares), see max borrow, LTV slider, health factor, liquidation price and APR. Includes the one-click "Deposit to vault & borrow" flow.
7. **Lend:** supply local stables to markets and see APY and utilisation.
8. **Scenario simulator:** offchain sliders for "AUD/USD ±X%" and "S&P ±Y%" with a horizon and hedge carry. Shows hedged vs unhedged outcomes and the borrow health impact. Runs even without a wallet. This is the most important pitch screen.
9. **Admin (gated by address):** price shock buttons (−10%, −20%, +10% per feed), market open/closed override, trigger rebalance/settle/roll, keeper health, and protocol TVL per vault and market. **TVL counts underlying assets once:** vault shares posted as Morpho collateral are not added on top of the vault's NAV.

### UX principles
- Everything is denominated in the user's home currency first, with USD secondary.
- Scenario outputs, generated histories and demo personas are always labelled **simulated**.
- Each value has an explainer tooltip ("Why did my value change?" → equity vs FX vs hedge).
- Every transaction completes in one signature where possible (permit + multicall + paymaster).

---

## 9. Repository layout

```
parallel-markets/
├─ contracts/        Foundry: src/, test/, script/ (Deploy.s.sol, Seed.s.sol)
├─ keeper/           TS service
├─ indexer/          Ponder
├─ web/              Next.js app
├─ packages/shared/  ABIs, addresses (per chain), currency + feed config, maths utils
├─ SPEC.md
└─ README.md
```
pnpm workspaces. Addresses are written to `packages/shared/deployments/base-sepolia.json` by the deploy script.

---

## 10. Build phases and acceptance criteria

### Phase 1: Core contracts (built in chat) — DONE
Status: implemented in `contracts/`, 66 tests passing (unit + fuzz), ~91% line coverage on core contracts.
- Mock tokens, Faucet, OracleHub (with a Pyth mock for tests), SimExchange, HedgeBook, ParallelVault, VaultFactory.
- **Accept:**
  - Fuzz tests show NAV maths correct within 1 wei-scale tolerance.
  - Hedge MTM matches the closed-form formula.
  - A hedged vault's local-currency NAV change under a +10% FX move with flat equities is within 0.5% of zero (continuous rebalance).
  - The unhedged vault loses about 9.09%.
  - Deposit/redeem round-trip loses only spread and fees.
  - Queued flows settle correctly.

### Phase 2: Lending integration
- Vault hardening: tracked internal balances for cash and equities (ignore donations).
- Oracle adapters, Morpho deployment/config script, IRM, ParallelRouter with borrow gate.
- **Accept:** a fork/integration test runs deposit → borrow → price shock → liquidate end to end. With tracked internal balances in place, a direct token donation to the vault does not move the vault-share oracle price.

### Phase 3: Deploy and seed on Base Sepolia
- Deploy script, 12 vaults, 5 Morpho markets, seeded liquidity, verified contracts on Basescan.
- **Accept:** all addresses are in `deployments/base-sepolia.json`, and a smoke-test script passes against the live testnet.

### Phase 4: Keeper and indexer
- **Accept:** NAV snapshots appear every 15 min, an admin shock produces a liquidation within 1 minute, and queues settle at a forced market open.

### Phase 5: Frontend
- Screens 1–9 in priority order: Simulator → Onboarding → Vaults → Vault detail → Portfolio → Borrow → Lend → Admin → Landing.
- **Accept:** a new user with only an email can sign in, claim, invest, borrow and see the P&L breakdown in under 3 minutes, without ever touching test ETH.

### Phase 6: Demo polish
- A scripted 5-minute demo path (§11), seeded "demo personas" with history, mobile responsive layout, and a short walkthrough video.

---

## 11. Demo script (5 minutes)

1. **Simulator.** "AUD rises 10%: the unhedged investor loses ~9% with flat stocks, the hedged one doesn't."
2. Sign in with email, choose AUD and claim. "No crypto knowledge, no gas."
3. Deposit 5,000 AUDM into **AUD Hedged S&P 500**, and show the AUDM → AUDD conversion happening automatically.
4. Portfolio: "Everything in AUD, with return broken into equity, FX and hedge."
5. Borrow AUDD against the vault shares (opening LTV up to 55%, liquidation at 77%, both labelled illustrative). "Your investment is now your credit line."
6. Admin: shock S&P by −20%, show health factor dropping, and the keeper liquidating a seeded risky position.
7. Force market closed and show borrowing restricted and deposits queuing. "We designed for the hard part."
8. Switch home currency to EUR or INR. "Same protocol, any local stablecoin."

---

## 12. Open items to verify before Phase 3

1. Pyth feed IDs and availability on Base Sepolia for SPY, AAPL, MSFT, NVDA, AMZN, GOOGL, AUD/USD, EUR/USD and USD/INR (Appendix A).
2. Whether Morpho Blue is deployed on Base Sepolia, plus the licence terms for a self-deployment.
3. Privy free-tier limits, and CDP paymaster setup and allowlisting for our contracts.
4. **mAUDC:** AUDC Pty Ltd is the name of the AUDD issuer, so a token called mAUDC could imply issuer endorsement. Either drop it or keep it only as a clearly fictional third AUD coin. **Decision pending.**
5. Default hedge carry per currency, using current AUD, EUR and INR versus USD short-rate differentials, for realistic simulator figures.

## 13. Revision log

**v0.2:** addresses the external spec review.
1. Hedge adjustments: a single settle-and-reopen rule; roll keeps the vault hedged; labelled as a spot-based simulation (§4.5).
2. Hedge losses beyond the cash buffer: equities are sold to fund settlement; no settlement while closed (§4.5).
3. Trading costs: explicit entry/exit costs borne by the transacting user; previews match execution (§4.6).
4. Fees: dilution only, with no NAV deduction; pending fee shares included in pricing (§4.6).
5. Market hours: interface-only restriction, disclosed as such (§5.4).
6. LLTV: separate opening LTV, liquidation LTV, all illustrative (§5.2).
7. Liquidation exit paths for equity, unhedged and hedged vault-share collateral (§5.5).
8. Oracle claims narrowed; Morpho scaling formula made explicit (§4.9).
9. Queue: excluded escrow, ownership, cancellation, limits, refunds, push settlement; not ERC-7540 compliant (§4.6).
10. Oracle status view, fail-closed staleness, confidence check, override recovery, clone pattern, conditional single-signature flows, TVL de-duplication, simulated labels, mAUDC flagged (§4.3, §4.7, §4.8, §8, §12).

**v0.3:** implementation decisions made while building Phases 2–6.
1. **Tracked internal balances** in the vault: donations no longer move NAV or the vault-share oracle; `skim` sweeps them to the treasury.
2. **Vault-share oracle uses realisable value** (`previewRedeem` of one share, net of exit cost), not NAV.
3. **DemoPyth (default):** the keeper pushes simulated prices with a mean-reverting random walk, so the demo works 24/7 and without a paid Pyth API key (Pyth Core now requires one). Real Pyth is a deploy-time option. The market is forced open by default for the same reason.
4. **No Ponder indexer.** The web app reads `NavSnapshot` and request events directly from the chain (chunked `getLogs`). This is enough for a demo; add an indexer if history grows.
5. **Gas sponsorship via a relayer route** (`/api/onboard`): sends a small amount of test ETH plus a sponsored faucet claim. Works with any wallet, including Privy embedded wallets, without paymaster setup.
6. **Access:** injected wallets, Coinbase Smart Wallet (passkey) and, when `NEXT_PUBLIC_PRIVY_APP_ID` is set, Privy email sign-in.
7. **Keeper lanes:** prices and liquidations run in a fast lane, separate from queue settlement, rebalancing, rolls and pokes (nonce manager). Locally, a shock led to a liquidation in about 7 seconds.
8. **Router drops queued-deposit helper:** queued deposits call the vault directly so the user owns (and can cancel) the request.

**v0.4:** product direction agreed with Akash on 4 Nov 2026. **Design only: none of this is built yet.** Details in §14.
1. Two products with plain names: `pSPY` (S&P 500) and `pUSTech` (5-stock basket). Hedged only; the unhedged option leaves the product and stays as a simulator comparison.
2. Vault count drops from 12 to 6 (3 currencies × 2 strategies).
3. Exits execute at the onchain (DEX) price, 24/7, with tiered deviation warnings. The queue stays as the "wait until the market opens" path.
4. Share price and loan collateral value come from the reference index price; the DEX price is only a guard.
5. Lending: same-currency loans only, a separate market per collateral, rate rising with usage, warnings then liquidation. Cross-currency borrowing is deferred.
6. LTVs to be back-tested before they are fixed (Morpho LLTV is immutable once a market exists).

## 14. v0.4 product direction (contracts built 5 Nov 2026; web app and keeper config still v0.3)

Where this differs from §0–§13, **this section wins**. The contracts now implement this section (see 14.7); the web app still has the v0.3 screens.

### 14.1 Product 1: Invest
**Journey:** the user deposits AUD, EUR or INR stablecoin, chooses the S&P 500 (`pSPY`) or US tech (`pUSTech`), and enters an amount. The app buys the exposure onchain and issues a share token (ERC-20, delivered through the ERC-4626 vault). The user can redeem for their own currency at any time.

- **Hedged only.** Every product carries the FX hedge (still a simulation, §0). Unhedged is shown only as a comparison in the simulator, not as something to buy.
- **Six real tokens, two products in the UI.** One vault per currency and strategy (for example `pSPY-AUD`), shown to users as "pSPY" with the currency picked at deposit. Token symbols in the code (`pmAUD-SPY-H` and so on) will be renamed to match.
- **Fees:** annual management fee on the shares (dilution, as built) plus entry and exit trading cost.

### 14.2 Exits, pricing and warnings
- **Execution.** A redemption sells the vault's tokenized SPY on a DEX at the onchain price, 24/7. There is no queue and no cash buffer to run dry.
- **Pricing source.** The share price (NAV) and loan collateral value use the **reference index price**. The DEX price is a guard only, so a thin pool cannot move NAV or trigger liquidations.
- **Deviation warnings (DEX below index):** under 1% is normal. From 1% to 3% shows an amber warning with a "wait until the market opens" option. Above 3% is red and requires an explicit confirm. At large deviations, risky actions (borrowing, liquidation) pause. Thresholds are fixed, not admin-adjustable.
- **Who bears the gap:** the person redeeming gets the actual DEX execution price (existing `min*` limits apply). The vault does not absorb it.
- **"Wait until the market opens"** reuses the existing queue (§4.6).
- **Demo DEX.** There is no real tokenized SPY or DEX liquidity on Base Sepolia. Extend `SimExchange` so its price can drift from the index, and add a Demo controls slider to show the warning live.

### 14.3 Product 2: Borrow and lend
- **Borrow:** deposit `pSPY` or `pUSTech`, borrow the same currency (AUD against AUD tokens, and so on). Interest is charged and the loan can be repaid at any time.
- **Same-currency only for now (6 markets).** Cross-currency borrowing is deferred: it adds hidden FX risk on the loan (the vault hedge covers currency against USD only), needs 18 markets, and fragments lender liquidity. When added: lower limits and a clear "currency risk on your loan" warning.
- **Lend:** deposit AUD, EUR or INR and earn interest from borrowers. A separate Morpho market per collateral. The UI shows "Safer" (lent against `pSPY`) and "Higher yield" (lent against `pUSTech`), with one rate each.
- **Rate:** rises with usage (existing `KinkedIrm`).
- **Liquidation:** safety warnings first as a loan worsens, then standard liquidation by the keeper with the Morpho liquidation bonus (about 14-15%, set by formula, see §14.4).
- **Revenue:** the annual fee on shares plus a slice of borrower interest through Morpho Blue's per-market fee setting (percentage not decided).

### 14.4 LTV (back-tested 5 Nov 2026, proposed final)
Separate limits for index and tech, because tech is far more volatile.

| Collateral | Max opening LTV | Liquidation LTV (LLTV) | Fall needed to liquidate |
|---|---|---|---|
| `pSPY` | 45% | 60% | 25% |
| `pUSTech` | 35% | 50% | 30% |

**Method.** Daily prices from Yahoo Finance, Jan 2000 to Nov 2026, for SPY and an equal-weight basket of AAPL, MSFT, NVDA, AMZN and GOOGL (before 2004 only the names that existed). A borrower opens at the maximum LTV on every possible day, with 8% interest and a one-year hold. Liquidation triggers at the first close above the LLTV and executes 1 to 10 trading days later, with collateral sold at a 0% to 25% DEX discount to the index price. Bad debt means the sale cannot repay the loan.

**Findings.**
- Worst drawdowns: SPY -55% (Mar 2009), tech basket -64% (Nov 2008). Worst 5 days: SPY -19.8%, tech -24.8%. Worst 10 days: SPY -26.8%, tech -34.3%.
- Both proposed pairs survive the worst 5-day fall without liquidation (pSPY loan reaches about 56% LTV, pUSTech about 46.5%).
- No bad debt at any tested LTV with a delay up to 3 days and a DEX discount up to 10%. With a 10-day delay and a 25% discount, the old 50/65 pSPY pair produced bad debt on 0.13% of start dates; 45/60 produced none at a 10-day delay.
- The old provisional pairs (50/65, 40/55) were not unsafe, only liquidated more often (pSPY 17.7% of start dates at 50/65 against 16.0% at 45/60).
- After a trigger, an instant further fall causes bad debt only beyond about 33% at LLTV 60% and 44% at LLTV 50% (10% DEX discount). The deviation guard (§14.2) should therefore pause borrowing and liquidation when the DEX price is more than **10%** below the index.

**Limits of the test.** Daily closes understate intraday and weekend gaps. The tech basket is survivorship-biased. Vault hedge basis, carry and FX moves are not modelled. Borrowers who do not borrow the maximum are liquidated less often than shown.

**Notes.**
- Morpho market parameters, including LLTV, are immutable. The opening LTV is an app-level cap and can be lowered later.
- Morpho sets the liquidation bonus by formula from the LLTV (about 13.6% at 60%, capped at 15% at 50%), so it cannot be tuned.
- The §5.2 figures (45-55% opening, 62.5-77% liquidation) were v0.3 illustrations and are replaced by this table.
- Suggested safety meter: green below 80% of the LLTV, amber from 80% to 92%, red above 92%. Not yet agreed (§14.5).

### 14.5 Still open
- Confirm the proposed LTVs (§14.4) and the 10% deviation pause level; the management-fee and interest-spread percentages.
- `mAUDC` naming (§12 item 4).
- The name "Parallel Markets" overlaps with existing finance companies (see HANDOFF.md).
- A real FX hedge counterparty, which any launch beyond testnet would need.
- Which tokenized SPY, if any, exists on Base with real DEX liquidity.
- Licensing: going live needs a licensed partner (HANDOFF.md).
- UI: a redesign is in progress outside this repo (reference prototype and Claude Design brief); the web app in `web/` still has the v0.3 screens plus an experimental `/try` flow.

### 14.6 User journeys

**0. First visit.** Landing page (one promise plus the currency slider: A$10,000 becomes A$9,091 unprotected vs A$10,000 protected) → "Try the demo" → one-button sign-in (email or passkey, no wallet needed) → test money added automatically → Home with three actions: Invest, Borrow, Earn.

**1. Invest.**
1. Pick the product: S&P 500 (`pSPY`) or US tech (`pUSTech`). Each card shows a one-line description and the benefit as a scenario ("If the A$ rises 10%: A$9,091 without protection vs A$10,000 with it").
2. Currency: defaults to the home currency (AUD, EUR or INR); the user pays with their stablecoin in that currency.
3. Amount: one box in their own currency, quick amounts, a live "You'll own about…" line and the costs.
4. Confirm: you pay, trading cost, annual fee, what you receive; one risk sentence (share prices can fall, currency protection reduces but does not remove currency risk, costs apply).
5. Behind the scenes: the app converts the stablecoin, buys the tokenized equity onchain, sizes the FX hedge and mints `pSPY` / `pUSTech` to the user.
6. Result: "You now own about A$X of the S&P 500, protected from currency swings" → Borrow against it / See portfolio / Invest more.

**2. Hold and track.** Portfolio shows value in the user's own currency, with the gain or loss split into share performance, currency effect, hedge result and fees.

**3. Sell (redeem).**
1. Portfolio → Sell → amount or "all"; paid in the product's currency stablecoin. Shares locked as loan collateral cannot be sold until the loan is repaid.
2. Preview: what the user receives at the onchain (DEX) price, and the gap versus the index price.
3. Normal (gap under 1%): confirm and sell. Amber (1–3%): "The price is X% below the index. Sell now, or wait until US markets open" (waiting uses the queue). Red (over 3%): the user must explicitly confirm they accept receiving about X% less.
4. Result: stablecoin arrives; the position updates.

**4. Borrow.**
1. Pick an investment to borrow against (`pSPY` or `pUSTech`).
2. How much: one slider, in the same currency as the investment (same-currency loans only, §14.3).
3. Shown: the interest rate (variable, rising with usage), the maximum loan, a loan-safety meter, and one plain line on the main risk ("If your shares fall too far, some may be sold to repay the loan").
4. Confirm → the shares go in as collateral and the stablecoin loan is paid out.
5. Result: a loan card with amount borrowed, interest, and safety.

**5. Manage and wind down the loan.** Repay part or all at any time, add collateral, or withdraw collateral while the loan stays safe. Interest accrues continuously. Once repaid, the shares unlock and can be held or sold.

**6. The loan gets risky.** The safety meter turns amber and the app shows warnings as the loan approaches the limit. At the liquidation limit the keeper sells part of the collateral to repay part of the loan (Morpho liquidation bonus to the keeper, §14.4); the user keeps the rest.

**7. Lend (Earn).**
1. Pick a currency, then "Safer" (lent against `pSPY`) or "Higher yield" (lent against `pUSTech`); each shows one variable rate and how much is currently lent out.
2. Enter an amount, with one risk sentence (earnings come from borrower interest; withdrawals depend on available funds; in extreme market falls lenders can lose money).
3. Deposit → balance shown with interest accruing.
4. Withdraw any time up to the funds currently available; if usage is very high the user may have to wait.

**8. Demo-only controls** (for the AUDD / AUDM teams, tucked under "Advanced"): shock prices, open and close the market, the DEX-dislocation slider (§14.2), keeper status, and the currency explorer.

**Edge states to design:** prices still loading or stale (fail closed, "prices are updating"), US market closed, test-money request failed, not enough balance, DEX gap warnings, a repay or sell blocked by an active loan.

**Decided 5 Nov 2026:** new borrowing is allowed 24/7. The DEX deviation guard replaces the v0.3 market-hours rule (§5.4 is superseded). **Open (not decided):** the warning levels for loan safety, and whether users get alerts (email or push) before a liquidation.

### 14.7 What the contracts do now (v0.4, built and tested locally)
- **Six hedged vaults**, one per currency and strategy: `pSPY-AUD`, `pUSTech-AUD`, `pSPY-EUR`, `pUSTech-EUR`, `pSPY-INR`, `pUSTech-INR`. The factory can still create unhedged vaults (tests and simulator), but Deploy does not.
- **Simulated DEX.** `SimExchange.setDrift(bps)` (admin, demo control) moves the DEX price from -50% to +50% of the index. Sells work 24/7; buys still need the market open. NAV and collateral never use the DEX price.
- **Redemptions** (`redeem`) work 24/7 and pay the actual DEX execution price; previews match execution exactly. `redeemQuote(shares)` returns the payout at the DEX, at the index, the gap in bps and the level. A discount is paid by the redeemer, a premium stays with remaining holders. `requestRedeem` is the "wait" option and settles in `processQueue` if `minAssets` is met.
- **Deviation guard, fixed constants** in `SimExchange`: level 0 under 1%, amber 1-3%, red 3-10%, paused at 10% or more (`deviationLevel()`). At level 3 the vault-share oracle adapter reverts (borrowing, liquidation and collateral withdrawal pause; repaying still works) and the router refuses new borrows.
- **Collateral value** is `previewRedeemAtIndex` (index price net of the normal spread, no drift).
- **Six same-currency Morpho markets**, one per vault, with the §14.4 LTVs (LLTV 60% / 50%, router opening cap 45% / 35%) and a 10% Morpho interest fee to the treasury (set only when Deploy deploys Morpho itself).
- **Mirror hedge on gTrade (added 10 Nov 2026).** LP capital cannot be sourced, so the real FX risk is carried on an existing onchain venue instead. `HedgeManager` keeps a position on a venue (`IHedgeVenue`) equal to `HedgeBook.openInterestUsd` per currency; vault NAV is unchanged (oracle maths), so deposits and redeems stay instant. `GTradeVenue` trades gTrade with USDC margin at fixed 5x: EUR = long EUR/USD (pair 21); AUD = long EUR/USD + short EUR/AUD (pair 110), a two-leg approximation of AUD/USD with fees on both legs; INR has no pair and stays simulated. gTrade orders are asynchronous with no callback, so the keeper calls `sync`, waits for the oracle fill, then `confirm`. Base Sepolia has no gTrade, so testnet uses `MockGTrade` (async orders, 0.012% fees, % PnL, no liquidation or funding fees). Checked read-only against the deployed contracts on 10 Nov 2026: `getTrade(address,uint32)` returns the 15-field `Trade` struct on both Base mainnet and Arbitrum Sepolia; Base pair 21 = EUR/USD and pair 110 = EUR/AUD; USDC `collateralIndex` is 1 on Base (3 on Arbitrum Sepolia, set per deploy). Still not verified: that `openTrade` and the size-update calls accept our parameters (needs a funded testnet trade), the minimum position size, and fees on Base. Not built: automatic margin top-up (an unhedged liquidation risk at 5x), the USDC to local-stable conversion of venue P&L (treasury step), real gTrade event watching in the keeper. In this setup the `HedgeBook` pool below is only a timing and working-capital buffer.
- **Onchain FX hedge (added 9 Nov 2026).** `HedgeBook` is now a pool-backed, oracle-priced FX perp venue (the model used by Ostium or gTrade), not a mint/burn simulation. Each hedged vault holds a short-USD/long-local position. The counterparty is a per-currency LP pool funded with real stablecoin: hedge gains are paid out of the pool, hedge losses and carry are paid into it, and nothing is minted or burned. Anyone can `lpDeposit` / `lpWithdraw` (LPs earn carry and lose when the local currency strengthens). Limits: open interest is capped at 5x pool liquidity (the hedge is clamped, not reverted); LPs cannot withdraw below 20% of open interest; a gain larger than the pool is paid only up to what the pool holds (haircut). Deploy seeds A$5m, €5m and ₹400m pools. Still a mock: priced from the oracle (no order book or slippage), no funding-rate skew, no hedger liquidation (the vault settles at every adjust), registered vaults only. Production needs a real venue or counterparty (§14.5).
- **Not yet done:** web screens, LP / pool UI,  demo-controls slider, keeper config for the guard, deviation-level UI states, Base Sepolia deploy.

## Appendix A: Feed config (fill during Phase 3)

| Key | Pyth symbol | Feed ID | Notes |
|---|---|---|---|
| SPY | Equity.US.SPY/USD | TBD | |
| AAPL | Equity.US.AAPL/USD | TBD | |
| MSFT | Equity.US.MSFT/USD | TBD | |
| NVDA | Equity.US.NVDA/USD | TBD | |
| AMZN | Equity.US.AMZN/USD | TBD | |
| GOOGL | Equity.US.GOOGL/USD | TBD | |
| AUD | FX.AUD/USD | TBD | already USD per AUD |
| EUR | FX.EUR/USD | TBD | already USD per EUR |
| INR | FX.USD/INR | TBD | **invert** on ingest |

## Appendix B: Default parameters

| Param | Default |
|---|---|
| SimExchange spread | 10 bps |
| Vault cash buffer | 3% |
| Hedge target / drift trigger | 100% / 3% |
| Basket weights | 20% each, rebalance at ±5% |
| Management fee | 0.50% p.a. |
| Oracle max age (open) | 15 min |
| Max opening LTV: equity / hedged vault / unhedged vault (illustrative) | 45% / 55% / 45% |
| LLTV: equity / hedged vault / unhedged vault (illustrative) | 62.5% / 77% / 62.5% |
| Pyth max confidence | 2% of price |
| Faucet cooldown | 24 h |
