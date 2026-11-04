# Handoff from the claude.ai chat (3 Nov 2026)

This summarises the planning conversation that produced this repo, so work can continue in Claude Code. Read it together with `CLAUDE.md`, `SPEC.md` and `README.md`.

## Who and why
- Owner: Akash (Brisbane). Prefers direct answers and working solutions over long technical explanations. Not a full-time Solidity dev, so explain steps plainly and do the work.
- Goal: a working **testnet demo** (not a deck) to show the **AUDD and AUDM** stablecoin teams. The pitch is "let's build this together". The demo must be usable by non-crypto people.
- Product: deposit a local-currency stablecoin (AUD, EUR, INR; deliberately no USD), invest in US equities (S&P 500 or a 5-stock US tech basket), hedged or unhedged against USD, and borrow against the position.

## Decisions made (with the reasons)
- **Name: Parallel Markets** (renamed from "Equora" on 3 Nov 2026 in Claude Code). Akash disliked "Equora" and his friends found it confusing, so he chose Parallel Markets for being plain English. **Known risk:** the earlier chat had rejected this name because Parallel Markets, Parallel Protocol and Parallel Finance already exist. Akash chose to proceed anyway for the testnet demo, with the overlap not re-checked. Revisit before anything public or commercial. Code names: `ParallelVault`, `ParallelRouter`, `@parallel/*` packages, vault symbols `pmAUD-SPY` etc. The GitHub repo and local folder are still called Equora.
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
- **Renamed** the project to Parallel Markets in code, docs and UI (see Decisions). Local folder and GitHub repo are still `Equora`. Nothing is committed yet.
- **Product direction changed.** Akash defined two products: `pSPY` / `pUSTech` invest (hedged only) and borrow/lend against them. All decisions, the full user journeys and what is still open are in **SPEC.md §14**. The code still implements v0.3 (12 vaults, queue-based closed-market exits) and has not been updated.
- **UI:** the v0.3 web app and an experimental `/try` flow (`web/app/try/page.tsx`) were judged too complicated. Akash prototyped a nicer look in ChatGPT (`~/Downloads/parallel-markets-ui/`: static HTML, fake data, not wired to contracts) and is taking a design brief to Claude Design. That prototype still has too many steps and too much text, and leads with invented "+12.84% return" figures; the agreed fix is product-first Invest cards with a currency-protection scenario instead.
- **Local dev notes:** `pnpm` is installed at `~/.npm-global/bin` (add it and `~/.foundry/bin` to `PATH`). `web/.env.local` was created with anvil's public test keys for local use only. Local run: anvil, deploy with `KEEPER_ADDRESS` set to anvil account #1 (the keeper's default key), then the keeper and web app.
- **Next:** back-test LTVs, then build the v0.4 contract changes (6 vaults, simulated DEX with adjustable drift, deviation guard, new markets), wire the new UI, then deploy to Base Sepolia. The wallet and funding steps for deployment are still pending.

