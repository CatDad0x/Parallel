# Parallel Markets — notes for Claude Code

Parallel Markets is a **testnet demo** protocol on Base Sepolia. Users deposit local-currency stablecoins (AUD, EUR, INR) into ERC-4626 vaults that hold tokenized US equities, optionally FX-hedged, and borrow against positions via Morpho Blue. All assets are mock tokens. The goal is a working demo for the AUDD / AUDM teams.

Read `HANDOFF.md` first (context from the planning chat), then `SPEC.md` for the design (v0.3; §13 is the revision log) and `README.md` for deployment.

## Status
**v0.4 product direction was agreed on 4 Nov 2026 (SPEC.md §14): hedged-only `pSPY`/`pUSTech`, 6 vaults, DEX-priced exits with deviation warnings, same-currency lending. It is design only; the code below is still v0.3.** Read §14 before changing contracts or UI.

All build phases are done and tested locally (contracts, lending, deploy script, keeper, web). Remaining: deploy to Base Sepolia with the owner's keys, host the keeper and web app, and record the demo walkthrough.

## Commands
```bash
pnpm test                    # forge tests (from repo root)
pnpm build:contracts         # forge build + export ABIs to packages/shared/src/abis.ts
pnpm deploy:local            # needs anvil + contracts/.env
pnpm keeper                  # keeper (reads CHAIN_ID / RPC_URL)
pnpm web                     # Next.js dev server on :3000
cd web && npx tsc --noEmit   # typecheck web
```
After changing any contract ABI, re-run `pnpm build:contracts`.

## Layout
| Path | Role |
|---|---|
| `contracts/src/ParallelVault.sol` | ERC-4626 vault: tracked balances, NAV, entry/exit costs, async queue, rebalance, hedge sync, dilution fees, `skim` |
| `contracts/src/OracleHub.sol` | Pyth reads, 18-dp normalisation, inverted FX, confidence check, overrides/shocks, market-hours modes |
| `contracts/src/HedgeBook.sol` | Spot-based hedge simulation: short USD / long local, with carry |
| `contracts/src/SimExchange.sol` | Oracle-priced venue with a spread; equity trades revert when the market is closed |
| `contracts/src/ParallelRouter.sol` | Group-stable deposits/redeems, deposit-and-borrow, repay-all, interface-level borrow gate and opening-LTV cap |
| `contracts/src/lending/` | Morpho oracle adapters (equity, vault share = previewRedeem) and `KinkedIrm` |
| `contracts/src/testnet/DemoPyth.sol` | Keeper-pushed simulated prices (default deployment mode) |
| `contracts/script/Deploy.s.sol` | Full deploy + seed; writes `packages/shared/deployments/<chainId>.json` |
| `keeper/src/index.ts` | Fast lane (prices, liquidations) + slow lane (queues, rebalance, roll, poke); `/health` |
| `web/` | Next.js App Router, wagmi, optional Privy, `/api/onboard` sponsored gas + faucet |

## Design rules (do not regress)
- **Price convention:** FX = USD per 1 local (18 dp). Equity = USD per token (18 dp). Stables 6 dp, equities and shares 18 dp.
- **Tracked balances:** NAV never uses raw `balanceOf`. Every trade goes through `_buy`/`_sell`, and every cash movement updates `_cash`.
- **Hedge rule:** `HedgeBook.adjust` settles the full MTM into cash, then reopens at the new notional and spot strike. A roll keeps the vault hedged.
- **Hedge losses:** the vault sells equities (`_ensureCash`) before a loss is burned.
- **Costs:** entry = spread × invested fraction; exit = spread × equity/NAV. Previews must match execution exactly.
- **Fees:** dilution only, with pending fee shares in `_effectiveSupply()`. No fee deduction in `totalAssets`.
- **Queue:** escrow excluded from NAV; owner cancel; `min*` limits refund on miss. Not ERC-7540 compliant.
- **Fail-closed** on stale prices while the market is open.
- **Market-hours and opening-LTV limits are interface-level only.** Always disclose that.
- **UI compares cooldowns against chain time** (`useBlock`), not the browser clock.

## Open decisions
- **Name:** "Parallel Markets" overlaps with existing finance companies (HANDOFF.md). Akash chose to proceed for the testnet demo.
- **LTVs, fees, borrowing while US is closed, and loan-safety alerts:** see SPEC.md §14.4–14.6.
- **mAUDC:** AUDC is the AUDD issuer's company name. The token is deployed as "Mock AUDC (testnet)". Ask Akash whether to rename or drop it before presenting to the AUDD team.

## Toolchain notes
Foundry auto-detects solc 0.8.26 (Parallel Markets) and 0.8.19 (Morpho Blue core). `via_ir = true` is required. Libraries are vendored in `contracts/lib/`.
