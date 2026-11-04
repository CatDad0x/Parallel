# Parallel Markets

**Invest in US shares with your own currency's stablecoin, hedged or unhedged, then borrow against your position.**

> ⚠️ Testnet demo with mock assets. Not a live financial product. Not affiliated with or endorsed by any stablecoin issuer.

Deposit AUD, EUR or INR stablecoins. Invest in an S&P 500 index or a US tech basket, either unhedged or hedged against the US dollar. Every value is shown in your own currency, and you can borrow against your vault shares.

## What's in the repo

```
parallel-markets/
├─ contracts/        Solidity (Foundry): vaults, oracle, hedge book, exchange, router, deploy script
├─ keeper/           Bot: prices, queue settlement, rebalancing, hedge rolls, liquidations
├─ web/              Next.js app: simulator, onboarding, vaults, portfolio, borrow, lend, demo controls
├─ packages/shared/  ABIs, deployment addresses, scenario maths
├─ SPEC.md           Design spec and revision log
└─ CLAUDE.md         Working notes for Claude Code
```

| Part | Status |
|---|---|
| Core contracts | ✅ 83 unit, fuzz and end-to-end tests |
| Lending (Morpho Blue + router) | ✅ Liquidation paths for equity, vault-share and queued collateral |
| Deploy script | ✅ Deploys and seeds everything; tested on a local chain |
| Keeper | ✅ Liquidates about 7 seconds after a price shock (local test) |
| Website | ✅ Full journey tested in a browser: sign in, faucet, deposit, borrow, portfolio, closed-market queue |
| Base Sepolia deployment | ⏳ Needs your keys. See below. |

---

## Launch on Base Sepolia (about 30 minutes)

You need three accounts: a wallet, an RPC provider, and somewhere to host the site and bot. Only the deploy step and the hosting need you. Everything else is already built.

### 1. Create two fresh testnet wallets
Make one **deployer** (admin) wallet and one **keeper** wallet in MetaMask or with `cast wallet new`. Use these for testnet only and never reuse them for real funds.

Fund both from a Base Sepolia faucet. The deployer needs about 0.05 ETH; the keeper about 0.05 ETH.

### 2. Deploy the contracts
```bash
# prerequisites: Foundry (https://getfoundry.sh), Node 20+, pnpm
git clone https://github.com/CatDad0x/Equora && cd Equora
pnpm install
cp contracts/.env.example contracts/.env      # fill PRIVATE_KEY, KEEPER_ADDRESS, BASESCAN_API_KEY
pnpm build:contracts
pnpm deploy:base-sepolia
git add packages/shared && git commit -m "Base Sepolia deployment" && git push
```
This deploys the tokens, oracle, 12 vaults, Morpho Blue, 5 lending markets, router and faucet. It also seeds vault and lender liquidity, verifies the contracts on Basescan and writes `packages/shared/deployments/84532.json`. Commit that file, because the website and keeper read their addresses from it.

Note the block number in the output and use it as the keeper's `DEPLOY_BLOCK`.

### 3. Run the keeper
Host it on Railway, Render or any small server, running 24/7.
- Root directory: repository root. Start command: `pnpm --filter @parallel/keeper start`
- Env: copy `keeper/.env.example` (`CHAIN_ID=84532`, `RPC_URL`, `KEEPER_PRIVATE_KEY`, `DEPLOY_BLOCK`)
- It serves health JSON on `HEALTH_PORT`. Expose it so the Demo controls page can show keeper status.

### 4. Host the website on Vercel
- Import the GitHub repo and set **Root directory** to `web`.
- Env vars (see `web/.env.example`):
  - `NEXT_PUBLIC_CHAIN_ID=84532`
  - `NEXT_PUBLIC_RPC_URL`: a reliable Base Sepolia RPC (Alchemy, QuickNode)
  - `NEXT_PUBLIC_KEEPER_URL`: the keeper's public health URL
  - `RELAYER_PRIVATE_KEY`: a funded testnet wallet that pays gas and faucet claims for new users, so visitors never need test ETH
  - `NEXT_PUBLIC_PRIVY_APP_ID` (optional): enables email sign-in with an embedded wallet. Create a free app at privy.io and add your Vercel domain to its allowed origins.

### 5. Run the demo
Open the site, connect the **deployer** wallet, and use **Demo controls** to shock prices, close or open the market, and trigger vault operations. The 5-minute script is in SPEC.md §11.

---

## Run everything locally
```bash
anvil                                  # terminal 1: local chain
pnpm deploy:local                      # uses anvil key #0 as admin (set PRIVATE_KEY in contracts/.env)
pnpm keeper                            # terminal 2
cp web/.env.example web/.env.local && pnpm web   # terminal 3 → http://localhost:3000
```
Locally, the Connect menu includes a **Local test account** option (a funded anvil account) so you can click through without a wallet.

## Design choices worth knowing

- **Simulated prices by default.** The keeper drives prices with a realistic random walk, so the demo works at any hour (Brisbane business hours are US night). You can switch to real Pyth feeds with `PYTH_ADDRESS` and `FEED_*` env vars plus a Pyth API key.
- **Market forced open by default**, for the same reason. Use Demo controls to show the closed-market behaviour.
- **The FX hedge is a simulation** marked against live FX with an illustrative carry. In production it would be an institutional FX forward.
- **Market-hours borrowing limits and opening-LTV caps are enforced by the app and router only.** Morpho Blue itself does not enforce them, and the UI says so.
- **LTVs, rates and carry are illustrative**, pending risk calibration.
