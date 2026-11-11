# Handoff from the claude.ai chat (3 Nov 2026)

This summarises the planning conversation that produced this repo, so work can continue in Claude Code. Read it together with `CLAUDE.md`, `SPEC.md` and `README.md`.

## Who and why
- Owner: Akash (Brisbane). Prefers direct answers and working solutions over long technical explanations. Not a full-time Solidity dev, so explain steps plainly and do the work.
- Goal: a working **testnet demo** (not a deck) to show the **AUDD and AUDM** stablecoin teams. The pitch is "let's build this together". The demo must be usable by non-crypto people.
- Product: deposit a local-currency stablecoin (AUD, EUR, INR; deliberately no USD), invest in US equities (S&P 500 or a 5-stock US tech basket), hedged or unhedged against USD, and borrow against the position.

## Decisions made (with the reasons)
- **Name: Parallel Markets** (renamed from an earlier working name on 3 Nov 2026 in Claude Code). Akash disliked the old name and his friends found it confusing, so he chose Parallel Markets for being plain English. **Known risk:** the earlier chat had rejected this name because Parallel Markets, Parallel Protocol and Parallel Finance already exist. Akash chose to proceed anyway for the testnet demo, with the overlap not re-checked. Revisit before anything public or commercial. Code names: `ParallelVault`, `ParallelRouter`, `@parallel/*` packages, vault symbols `pmAUD-SPY` etc. The GitHub repo and local folder are still called Equora.
- **Testnet only (Base Sepolia).** A live product with real money would be a managed investment scheme and lending would need an AFSL in Australia, so going live waits for a licensed partner.
- **Chain: Base.** Akash chose it.
- **12 vaults** = 3 currencies × (index, basket) × (hedged, unhedged), from one factory.
- **AUD deposit tokens:** mAUDD, mAUDM, mAUDC all feed the AUD vaults (converted at par to mAUDD).
- **Lending: Morpho Blue** (unmodified, self-deployed because there is no Base Sepolia deployment).
- **Prices:** keeper-simulated by default (DemoPyth), because Brisbane business hours = US night and Pyth Core now requires an API key. Real Pyth is a deploy-time option.
- **Access:** email login (Privy, optional) plus wallet connect, plus sponsored gas through the `/api/onboard` relayer.
- **Hedging is honest about its limits:** it is a simulation marked against live FX; in production it would be an institutional FX forward. The UI says so.

## External spec review (all addressed, see SPEC.md §13)
A reviewer flagged 10 issues: hedge P&L could be erased on adjust, a 3% cash buffer can't fund hedge losses, deposit/redeem costs were socialised, fees were double counted, the market-hours gate is bypassable, the 77% LLTV needed a different explanation, vault-share liquidations needed their own exit path, the oracle manipulation claims were too strong, the queue was underspecified, plus assorted inconsistencies. Every point is fixed in code or disclosed in the spec and UI.

## Pitch notes from the chat
- Lead the demo with the **hedged vault and simulator**, not lending. Lending is the "and then you can borrow against it" moment.
- The differentiator vs an ASX-listed hedged S&P ETF (e.g. IHVV): onchain, 24/7, settles in local stablecoin, and **vault shares work as loan collateral**.
- Be upfront that market-hours borrowing limits and opening-LTV caps are app-level only, and that all LTVs, rates and carry are illustrative.
- The 5-minute demo script is in SPEC.md §11.

## Where things stand
- Built and tested locally: contracts (83 tests), lending, deploy script, keeper (liquidates about 7 seconds after a shock), and the full web app (browser-tested end to end, including the closed-market queue).
- **Next:** deploy to Base Sepolia (README "Launch on Base Sepolia"), host the keeper (Railway/Render) and web app (Vercel), then rehearse the demo.
- **Open decision:** mAUDC shares a name with AUDC (the AUDD issuer). Ask Akash whether to rename or remove it before presenting to AUDD.

## Rules for working with Akash's keys
Never ask him to paste a private key into chat. Keys go in `contracts/.env`, `keeper/.env` and Vercel env vars, all gitignored. Stop and ask before any step that spends testnet funds or deploys.

## Update, 4 Nov 2026 (Claude Code session)
- **Renamed** the project to Parallel Markets in code, docs and UI (see Decisions). Local folder is now `Parallel`; the GitHub repo is renamed separately. Nothing is committed yet.
- **Product direction changed.** Akash defined two products: `pSPY` / `pUSTech` invest (hedged only) and borrow/lend against them. All decisions, the full user journeys and what is still open are in **SPEC.md §14**. The code still implements v0.3 (12 vaults, queue-based closed-market exits) and has not been updated.
- **UI:** the v0.3 web app and an experimental `/try` flow (`web/app/try/page.tsx`) were judged too complicated. Akash prototyped a nicer look in ChatGPT (`~/Downloads/parallel-markets-ui/`: static HTML, fake data, not wired to contracts) and is taking a design brief to Claude Design. That prototype still has too many steps and too much text, and leads with invented "+12.84% return" figures; the agreed fix is product-first Invest cards with a currency-protection scenario instead.
- **Local dev notes:** `pnpm` is installed at `~/.npm-global/bin` (add it and `~/.foundry/bin` to `PATH`). `web/.env.local` was created with anvil's public test keys for local use only. Local run: anvil, deploy with `KEEPER_ADDRESS` set to anvil account #1 (the keeper's default key), then the keeper and web app.
- **Next:** back-test LTVs, then build the v0.4 contract changes (6 vaults, simulated DEX with adjustable drift, deviation guard, new markets), wire the new UI, then deploy to Base Sepolia. The wallet and funding steps for deployment are still pending.


## Update, 5 Nov 2026 (Claude Code session)
- **LTVs back-tested** (Yahoo daily data 2000-2026) and recorded in SPEC.md §14.4: pSPY 45% open / 60% liquidation, pUSTech 35% / 50%. Still marked "proposed".
- **v0.4 contracts built and tested locally** (94 forge tests). See SPEC.md §14.7. Decisions made: borrowing allowed 24/7, Morpho interest fee 10%, guard pauses at a 10% DEX discount.
- **Not done:** web app (still v0.3; unhedged `/try` option will break against v0.4 deployments), demo-controls slider, deploy to Base Sepolia (needs your wallet steps).
- `packages/shared/deployments/31337.json` is still the old v0.3 local deployment; re-run the local deploy before using the web app with v0.4.

## Update, 9 Nov 2026 (Claude Code session)
- **Onchain FX hedge built.** `HedgeBook` is now a pool-backed FX perp venue. Vault hedges settle against per-currency LP pools funded with real mock stablecoin (no mint/burn). `lpDeposit` / `lpWithdraw`, a 5x open-interest cap, a 20% LP reserve and a gain haircut are in. See SPEC.md §14.7. 102 forge tests pass; local deploy verified (pools seeded, hedges open). `pnpm deploy:local` now needs `--gas-estimate-multiplier 300` (already in package.json).
- **Not done:** web UI for LPs, keeper handling of pool capacity, deploying to Base Sepolia. A real mainnet hedge still needs a licensed counterparty or a live FX perp venue on Base.

## Update, 10 Nov 2026 (Claude Code session)
- **LP capital can't be sourced**, so the hedge is now mirrored on an existing onchain venue. Built: `IHedgeVenue`, `GTradeVenue` (gTrade adapter, USDC margin, EUR one leg, AUD two legs), `HedgeManager` (keeper-driven sync), `MockGTrade` (testnet stand-in, Base Sepolia has no gTrade), Deploy wiring, keeper `mirrorHedge` job. 115 forge tests expected (13 new in `HedgeMirror.t.sol`). Verified on a fresh local anvil deploy by driving sync, fulfil and confirm with `cast`.
- **Not verified:** the keeper job end to end (local runs hit confirmation timeouts and stale prices), and every gTrade ABI detail (see SPEC §14.7). **Not built:** margin top-up, USDC to local-stable settlement, real gTrade event watching. Next real step: verify against gTrade's Arbitrum Sepolia testnet or a Base mainnet fork.
- **Verified read-only (10 Nov 2026):** against gTrade on Base mainnet and Arbitrum Sepolia, `getTrade` returns the 15-field struct we use, Base pairs 21 (EUR/USD) and 110 (EUR/AUD) exist, and the USDC collateral index is 1 on Base (default fixed from 3). **Still unverified:** order placement itself (needs a funded testnet wallet: ask Akash first), minimum position size, fees on Base.

## 11 Nov 2026: UI wired, keeper verified, research
- **Web app rebuilt to the Claude Design canvas** ("Parallel markets redesign"): landing, Home, Invest, Portfolio (with Sell and the DEX-gap warnings), Borrow (with loan management), Earn, Advanced (price-gap slider, hedge status). New theme in `web/app/pm.css`, shell in `web/components/Shell.tsx`, shared hooks in `web/lib/pm.tsx`. Old v0.3 screens (`/try`, `/start`, `/vaults`, `/lend`, Header) are archived in `_archive/web-v03/`. Browser-tested locally on a v0.4 deploy: sign-in and test money, invest A$1,000, borrow A$300, lend A$500, amber sell warning at a 2% gap.
- **Edge states built (11 Nov, later):** prices loading or stale (banner, grey placeholders, disabled "Waiting for prices" on Invest, Borrow and Sell; recovers by itself), test money failed (card with Try again), not enough balance ("Use A$X" and "Add test money"), US market closed (shows the next open in the viewer's time), repay-to-unlock hint on Sell, phone top bar. Browser-tested by forcing each state on the local chain.
- **Not yet in the UI:** the design's currency-protection toggle (SPEC says hedged only, so it was left out); the Landing slider uses a simple 1/(1+x) estimate; the next-open time ignores holidays.
- **Local login note:** the mock account does not survive a full page reload; navigate with the sidebar, or sign in again.
- **Keeper verified end to end** on a fresh local anvil (`--block-time 1`): every job ran, `mirrorHedge` synced AUD and EUR to within 6 bps of target, INR skipped (no pair), zero errors.
- **Research:** Morpho Blue exists at the canonical `0xBBBB…FFCb` on Base Sepolia (set `MORPHO_ADDRESS` in the deploy). Base has live tokenised stocks (Coinbase Tokenized Stocks, Ondo, xStocks) trading on Aerodrome and Uniswap, but no SPY token with verified deep liquidity yet. Lenders for our markets would come from a curated Morpho vault (Vault V2) or incentives.

## 11 Nov 2026 (later): fork rehearsal, UI port, rename
- **Base Sepolia fork rehearsal passed.** Anvil fork of Base Sepolia, own Morpho copy, keeper running continuously. Borrowed A$880 against A$2,000 of S&P 500, shocked SPY down 30%: the keeper liquidated within about a minute (hf 0.966, about 705 shares seized, debt halved). Keeper health stayed OK and prices did not go stale. New-user onboarding via the relayer also worked.
- **Morpho correction:** canonical Morpho cannot host our LLTVs or IRM (see SPEC section 5). Earlier statement that we would reuse it was wrong for these parameters.
- **UI:** Home liquidation notice built (`web/lib/liquidations.ts`). Home dashboard (chart, activity log, sparklines) and Portfolio chart/columns ported from the redesign PRs (now closed) into the current app. `NEXT_PUBLIC_DEPLOY_BLOCK` bounds event scans. Local fork needs `NEXT_PUBLIC_CHAIN_ID=84532 NEXT_PUBLIC_MOCK_WALLET=1 NEXT_PUBLIC_DEPLOY_BLOCK=<block>`.
- **Open:** warm "Paper Trade" restyle via Claude Design (brief in the session folder); safety meter says "Comfortable" at the maximum opening LTV and thresholds are still not agreed; Privy email login untested (needs an app ID); real Base Sepolia deploy needs a fresh test-only wallet, ETH and hosting.
- Folder renamed to `Parallel`; GitHub repo renamed to `Parallel`.
