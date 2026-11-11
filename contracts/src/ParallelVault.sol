// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IOracleHub} from "./interfaces/IOracleHub.sol";
import {SimExchange} from "./SimExchange.sol";
import {HedgeBook} from "./HedgeBook.sol";

/// @title ParallelVault
/// @notice ERC-4626 vault denominated in a local-currency stablecoin (e.g. AUDD) that holds
/// USD-priced tokenized equities, optionally with an FX hedge (short USD / long local).
///
///   NAV (local) = equities valued in local + cash + hedge MTM
///
/// - Deposits execute instantly while the US market is open; while closed, users queue them
///   (`requestDeposit`) and the keeper settles them at the next open NAV via `processQueue`.
/// - v0.4: redemptions execute instantly 24/7 by selling equities on the (simulated) DEX. The
///   redeemer receives the actual DEX execution price; NAV and loan collateral use the index
///   price. `requestRedeem` remains as a "wait" option and settles via `processQueue`.
/// - Entry/exit cost equal to the expected execution spread is charged to the transacting user,
///   so existing holders are not diluted by trading costs.
/// - Management fee accrues by minting shares to the treasury.
contract ParallelVault is Initializable, ERC4626Upgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    uint256 public constant BPS = 10_000;
    uint256 public constant YEAR = 365 days;
    uint256 public constant BASKET_DRIFT_BPS = 500;

    struct Config {
        bytes32 currency; // "AUD" | "EUR" | "INR"
        address[] equities;
        uint16[] weightsBps; // sum = 10_000
        bool hedged;
        uint16 targetHedgeBps; // 10_000 = fully hedged
        uint16 hedgeDriftBps; // rebalance trigger
        uint16 cashBufferBps;
        uint16 mgmtFeeBps; // annual
    }

    struct Deps {
        IOracleHub oracle;
        SimExchange exchange;
        HedgeBook hedgeBook;
        address treasury;
    }

    /// @dev Custom async queue (inspired by ERC-7540, not compliant with it). All-or-nothing:
    /// a request settles in full at the next open NAV, or is refunded if its limit is not met.
    struct DepositRequest {
        address owner; // may cancel; receives the refund if the request fails
        address receiver; // receives shares
        uint256 assets; // escrowed, excluded from NAV until settled
        uint256 minShares; // slippage limit at settlement
    }

    struct RedeemRequest {
        address owner;
        address receiver; // receives assets
        uint256 shares; // escrowed in the vault
        uint256 minAssets;
    }

    // ------------------------------------------------------------------ storage

    bytes32 public currency;
    address[] internal _equities;
    uint16[] internal _weights;
    bool public hedged;
    uint16 public targetHedgeBps;
    uint16 public hedgeDriftBps;
    uint16 public cashBufferBps;
    uint16 public mgmtFeeBps;

    IOracleHub public oracle;
    SimExchange public exchange;
    HedgeBook public hedgeBook;
    address public treasury;

    uint64 public lastFeeAccrual;

    uint256 public pendingDepositAssets;
    uint256 public pendingRedeemShares;
    DepositRequest[] public depositQueue;
    RedeemRequest[] public redeemQueue;
    uint256 public depositHead;
    uint256 public redeemHead;

    /// @dev Tracked (managed) balances. NAV uses these, never raw balanceOf, so tokens sent
    /// directly to the vault do not move share price. Surplus can be swept with `skim`.
    uint256 internal _cash;
    mapping(address => uint256) public held;

    // ------------------------------------------------------------------ events / errors

    event NavSnapshot(
        uint256 nav,
        uint256 navPerShare,
        uint256 equityValue,
        int256 hedgeMtm,
        uint256 cash,
        uint256 usdPerLocal,
        uint256 timestamp
    );
    event DepositRequested(uint256 indexed id, address indexed sender, address indexed receiver, uint256 assets);
    event RedeemRequested(uint256 indexed id, address indexed owner, address indexed receiver, uint256 shares);
    event DepositSettled(uint256 indexed id, address indexed receiver, uint256 assets, uint256 shares);
    event RedeemSettled(uint256 indexed id, address indexed receiver, uint256 shares, uint256 assets);
    event DepositRefunded(uint256 indexed id, address indexed owner, uint256 assets, bool cancelled);
    event RedeemRefunded(uint256 indexed id, address indexed owner, uint256 shares, bool cancelled);
    event Rebalanced(uint256 navBefore, uint256 navAfter);
    event FeeAccrued(uint256 shares);

    error MarketClosed();
    error MarketOpenUseInstant();
    error Unsupported();
    error ZeroAmount();
    error BadConfig();
    error NotRequestOwner();
    error RequestClosed();

    // ------------------------------------------------------------------ init

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        Config memory cfg,
        Deps memory deps,
        address admin,
        address keeper
    ) external initializer {
        __ERC20_init(name_, symbol_);
        __ERC4626_init(asset_);
        __AccessControl_init();
        __ReentrancyGuard_init();

        uint256 n = cfg.equities.length;
        if (n == 0 || n != cfg.weightsBps.length) revert BadConfig();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            sum += cfg.weightsBps[i];
        }
        if (sum != BPS) revert BadConfig();
        if (cfg.cashBufferBps >= BPS || cfg.targetHedgeBps > BPS || cfg.mgmtFeeBps > 500) revert BadConfig();

        currency = cfg.currency;
        _equities = cfg.equities;
        _weights = cfg.weightsBps;
        hedged = cfg.hedged;
        targetHedgeBps = cfg.hedged ? cfg.targetHedgeBps : 0;
        hedgeDriftBps = cfg.hedgeDriftBps;
        cashBufferBps = cfg.cashBufferBps;
        mgmtFeeBps = cfg.mgmtFeeBps;

        oracle = deps.oracle;
        exchange = deps.exchange;
        hedgeBook = deps.hedgeBook;
        // The onchain FX venue pulls hedge losses from the vault with transferFrom.
        if (cfg.hedged) IERC20(address(asset_)).forceApprove(address(deps.hedgeBook), type(uint256).max);
        treasury = deps.treasury;
        lastFeeAccrual = uint64(block.timestamp);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, keeper);
    }

    // ------------------------------------------------------------------ views

    function equities() external view returns (address[] memory) {
        return _equities;
    }

    function weights() external view returns (uint16[] memory) {
        return _weights;
    }

    /// @notice Total USD value (18 dp) of equities held.
    function equityValueUsd() public view returns (uint256 usd) {
        for (uint256 i; i < _equities.length; ++i) {
            uint256 bal = held[_equities[i]];
            if (bal == 0) continue;
            (uint256 px,) = oracle.equityPriceUsd(_equities[i]);
            usd += bal * px / 1e18;
        }
    }

    /// @notice Equity value in asset units (local currency, token decimals), mid price.
    function equityValue() public view returns (uint256) {
        uint256 usd = equityValueUsd();
        return usd == 0 ? 0 : exchange.usdToLocal(asset(), usd);
    }

    /// @notice Tracked local-stable cash (excludes queued-deposit escrow and stray donations).
    function cash() public view returns (uint256) {
        return _cash;
    }

    function hedgeMtm() public view returns (int256) {
        return hedged ? hedgeBook.mtmAssets(address(this)) : int256(0);
    }

    /// @notice NAV in asset units.
    function totalAssets() public view override returns (uint256) {
        int256 nav = int256(equityValue()) + int256(cash()) + hedgeMtm();
        return nav > 0 ? uint256(nav) : 0;
    }

    /// @notice Asset value of one whole share (10**decimals()).
    function navPerShare() public view returns (uint256) {
        return convertToAssets(10 ** decimals());
    }

    /// @notice Expected execution cost on entry/exit, in bps of the transacted amount (rounded up).
    /// Exact cost = spreadBps * investedFraction; see `_cost`.
    function tradingCostBps() public view returns (uint256) {
        uint256 f = exchange.buyFactorWad();
        uint256 premium = f > 1e18 ? f - 1e18 : 0;
        return Math.ceilDiv(premium * (BPS - cashBufferBps), 1e18);
    }

    function queueLengths() external view returns (uint256 deposits, uint256 redeems) {
        return (depositQueue.length - depositHead, redeemQueue.length - redeemHead);
    }

    // ------------------------------------------------------------------ ERC-4626 overrides

    function _decimalsOffset() internal pure override returns (uint8) {
        return 12;
    }

    function decimals() public view override(ERC4626Upgradeable) returns (uint8) {
        return super.decimals();
    }

    function previewDeposit(uint256 assets) public view override returns (uint256) {
        return _convertToShares(assets - _entryCost(assets), Math.Rounding.Floor);
    }

    /// @notice What a redemption pays: index NAV minus the actual DEX execution cost (spread and drift).
    function previewRedeem(uint256 shares) public view override returns (uint256) {
        uint256 assets = _convertToAssets(shares, Math.Rounding.Floor);
        return assets - _exitCost(assets, exchange.sellFactorWad());
    }

    /// @notice Value of `shares` at the index price net of the normal spread only (no DEX drift).
    /// Used as loan-collateral value so a thin pool cannot move collateral or liquidations.
    function previewRedeemAtIndex(uint256 shares) public view returns (uint256) {
        uint256 assets = _convertToAssets(shares, Math.Rounding.Floor);
        return assets - _exitCost(assets, (BPS - exchange.spreadBps()) * 1e14);
    }

    /// @notice Redemption quote for the UI: payout at the DEX, payout at the index (spread only),
    /// and the gap between them in bps (0 when the DEX is not worse).
    function redeemQuote(uint256 shares)
        external
        view
        returns (uint256 atDex, uint256 atIndex, uint256 gapBps, uint8 level)
    {
        atDex = previewRedeem(shares);
        atIndex = previewRedeemAtIndex(shares);
        gapBps = atIndex > atDex && atIndex > 0 ? (atIndex - atDex) * BPS / atIndex : 0;
        level = exchange.deviationLevel();
    }

    function maxDeposit(address) public view override returns (uint256) {
        return oracle.isMarketOpen() ? type(uint256).max : 0;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return balanceOf(owner);
    }

    function maxMint(address) public pure override returns (uint256) {
        return 0;
    }

    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }

    function previewMint(uint256) public pure override returns (uint256) {
        revert Unsupported();
    }

    function previewWithdraw(uint256) public pure override returns (uint256) {
        revert Unsupported();
    }

    function mint(uint256, address) public pure override returns (uint256) {
        revert Unsupported();
    }

    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert Unsupported();
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256 shares) {
        if (!oracle.isMarketOpen()) revert MarketClosed();
        if (assets == 0) revert ZeroAmount();
        _accrueFee();
        shares = previewDeposit(assets);
        if (shares == 0) revert ZeroAmount();
        _deposit(_msgSender(), receiver, assets, shares);
        _snapshot();
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        if (shares > balanceOf(owner)) revert ERC4626ExceededMaxRedeem(owner, shares, balanceOf(owner));
        _accrueFee();
        assets = previewRedeem(shares);
        _withdraw(_msgSender(), receiver, owner, assets, shares);
        _snapshot();
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        _cash += assets;
        _invest(assets);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        _prepareRedeem(shares, assets);
        _cash -= assets;
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    // ------------------------------------------------------------------ queue (market closed)

    /// @notice Queue a deposit while the US market is closed. Assets are escrowed in the vault but
    /// excluded from NAV. Settles at the next open NAV if at least `minShares` would be minted,
    /// otherwise the assets are refunded to the caller.
    function requestDeposit(uint256 assets, address receiver, uint256 minShares)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (oracle.isMarketOpen()) revert MarketOpenUseInstant();
        if (assets == 0) revert ZeroAmount();
        IERC20(asset()).safeTransferFrom(_msgSender(), address(this), assets);
        pendingDepositAssets += assets;
        id = depositQueue.length;
        depositQueue.push(DepositRequest(_msgSender(), receiver, assets, minShares));
        emit DepositRequested(id, _msgSender(), receiver, assets);
    }

    /// @notice Queue a redemption ("wait until the market opens"). Shares are escrowed in the vault
    /// and settle in `processQueue` once the market is open, if at least `minAssets` is payable.
    function requestRedeem(uint256 shares, address receiver, uint256 minAssets)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (shares == 0) revert ZeroAmount();
        _transfer(_msgSender(), address(this), shares);
        pendingRedeemShares += shares;
        id = redeemQueue.length;
        redeemQueue.push(RedeemRequest(_msgSender(), receiver, shares, minAssets));
        emit RedeemRequested(id, _msgSender(), receiver, shares);
    }

    /// @notice Cancel a pending deposit request and get the escrowed assets back.
    function cancelDeposit(uint256 id) external nonReentrant {
        DepositRequest memory r = depositQueue[id];
        if (r.assets == 0) revert RequestClosed();
        if (r.owner != _msgSender()) revert NotRequestOwner();
        _refundDeposit(id, r, true);
    }

    /// @notice Cancel a pending redeem request and get the escrowed shares back.
    function cancelRedeem(uint256 id) external nonReentrant {
        RedeemRequest memory r = redeemQueue[id];
        if (r.shares == 0) revert RequestClosed();
        if (r.owner != _msgSender()) revert NotRequestOwner();
        _refundRedeem(id, r, true);
    }

    /// @notice Settle up to `maxItems` queued requests at current NAV. Market must be open.
    /// Requests whose slippage limit is not met are refunded instead of settled.
    function processQueue(uint256 maxItems) external nonReentrant onlyRole(KEEPER_ROLE) {
        if (!oracle.isMarketOpen()) revert MarketClosed();
        _accrueFee();

        uint256 done;
        while (depositHead < depositQueue.length && done < maxItems) {
            uint256 id = depositHead++;
            ++done;
            DepositRequest memory r = depositQueue[id];
            if (r.assets == 0) continue; // cancelled
            uint256 shares = previewDeposit(r.assets); // NAV excludes pending escrow
            if (shares == 0 || shares < r.minShares) {
                _refundDeposit(id, r, false);
                continue;
            }
            delete depositQueue[id];
            pendingDepositAssets -= r.assets;
            _cash += r.assets;
            _mint(r.receiver, shares);
            _invest(r.assets);
            emit DepositSettled(id, r.receiver, r.assets, shares);
        }
        while (redeemHead < redeemQueue.length && done < maxItems) {
            uint256 id = redeemHead++;
            ++done;
            RedeemRequest memory r = redeemQueue[id];
            if (r.shares == 0) continue; // cancelled
            uint256 assets = previewRedeem(r.shares);
            if (assets < r.minAssets) {
                _refundRedeem(id, r, false);
                continue;
            }
            delete redeemQueue[id];
            _prepareRedeem(r.shares, assets);
            pendingRedeemShares -= r.shares;
            _burn(address(this), r.shares);
            _cash -= assets;
            IERC20(asset()).safeTransfer(r.receiver, assets);
            emit RedeemSettled(id, r.receiver, r.shares, assets);
        }
        _snapshot();
    }

    function _refundDeposit(uint256 id, DepositRequest memory r, bool cancelled) internal {
        delete depositQueue[id];
        pendingDepositAssets -= r.assets;
        IERC20(asset()).safeTransfer(r.owner, r.assets);
        emit DepositRefunded(id, r.owner, r.assets, cancelled);
    }

    function _refundRedeem(uint256 id, RedeemRequest memory r, bool cancelled) internal {
        delete redeemQueue[id];
        pendingRedeemShares -= r.shares;
        _transfer(address(this), r.owner, r.shares);
        emit RedeemRefunded(id, r.owner, r.shares, cancelled);
    }

    // ------------------------------------------------------------------ keeper

    /// @notice Restore cash buffer, basket weights and hedge ratio.
    function rebalance() external nonReentrant onlyRole(KEEPER_ROLE) {
        if (!oracle.isMarketOpen()) revert MarketClosed();
        _accrueFee();
        uint256 navBefore = totalAssets();

        // 1. Basket weights
        if (_equities.length > 1) _rebalanceBasket();

        // 2. Cash buffer
        uint256 nav = totalAssets();
        uint256 targetCash = nav * cashBufferBps / BPS;
        uint256 c = cash();
        if (c > targetCash + nav / 100) {
            _buyByWeight(c - targetCash);
        } else if (c < targetCash / 2) {
            _ensureCash(targetCash);
        }

        // 3. Hedge ratio
        if (hedged && _hedgeDrifted()) _syncHedge();

        emit Rebalanced(navBefore, totalAssets());
        _snapshot();
    }

    /// @notice Roll the hedge: realise P&L into cash and re-strike at spot.
    function rollHedge() external nonReentrant onlyRole(KEEPER_ROLE) {
        if (!oracle.isMarketOpen()) revert MarketClosed();
        if (hedged) _syncHedge();
        _snapshot();
    }

    /// @notice Sweep tokens sent directly to the vault (not part of tracked balances) to the treasury.
    function skim(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 tracked = token == asset() ? _cash + pendingDepositAssets : held[token];
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > tracked) IERC20(token).safeTransfer(treasury, bal - tracked);
    }

    /// @notice Accrue fees and emit a NAV snapshot (for charts). Anyone may call.
    function poke() external {
        _accrueFee();
        _snapshot();
    }

    // ------------------------------------------------------------------ internal: portfolio

    function _invest(uint256 assets) internal {
        uint256 investable = assets * (BPS - cashBufferBps) / BPS;
        _buyByWeight(investable);
        if (hedged) _syncHedge();
    }

    function _buyByWeight(uint256 amount) internal {
        address a = asset();
        for (uint256 i; i < _equities.length; ++i) {
            uint256 amt = amount * _weights[i] / BPS;
            if (amt > 0) _buy(a, _equities[i], amt);
        }
    }

    /// @dev Sell `shares / totalSupply` of every equity, realign the hedge, and make sure
    /// `assetsOut` of cash is available.
    function _prepareRedeem(uint256 shares, uint256 assetsOut) internal {
        uint256 supply = totalSupply();
        address a = asset();
        // Realise accrued hedge P&L BEFORE the pro-rata sale, so a hedge loss is funded by all
        // holders' equity (as NAV already assumes) and not left to whoever remains after the exit.
        if (hedged) _syncHedge();
        for (uint256 i; i < _equities.length; ++i) {
            uint256 bal = held[_equities[i]];
            uint256 qty = bal.mulDiv(shares, supply);
            if (qty > 0) _sell(a, _equities[i], qty);
        }
        if (hedged) _syncHedge();
        _ensureCash(assetsOut);
    }

    /// @dev Sell equities pro-rata until cash >= `need`.
    function _ensureCash(uint256 need) internal {
        uint256 c = cash();
        if (c >= need) return;
        uint256 eq = equityValue();
        if (eq == 0) return;
        // gross up for spread, plus 1 bp safety margin
        uint256 shortfall = (need - c) * 1e18 / exchange.sellFactorWad() * (BPS + 1) / BPS;
        uint256 fracWad = shortfall >= eq ? 1e18 : shortfall.mulDiv(1e18, eq, Math.Rounding.Ceil);
        address a = asset();
        for (uint256 i; i < _equities.length; ++i) {
            uint256 bal = held[_equities[i]];
            uint256 qty = Math.min(bal, bal.mulDiv(fracWad, 1e18, Math.Rounding.Ceil));
            if (qty > 0) _sell(a, _equities[i], qty);
        }
    }

    function _rebalanceBasket() internal {
        uint256 n = _equities.length;
        uint256[] memory vals = new uint256[](n);
        uint256[] memory pxs = new uint256[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            (pxs[i],) = oracle.equityPriceUsd(_equities[i]);
            vals[i] = held[_equities[i]] * pxs[i] / 1e18;
            total += vals[i];
        }
        if (total == 0) return;

        bool drifted;
        for (uint256 i; i < n; ++i) {
            uint256 w = vals[i] * BPS / total;
            uint256 t = _weights[i];
            if ((w > t ? w - t : t - w) > BASKET_DRIFT_BPS) {
                drifted = true;
                break;
            }
        }
        if (!drifted) return;

        address a = asset();
        uint256 cashBefore = cash();
        // sell overweights
        for (uint256 i; i < n; ++i) {
            uint256 target = total * _weights[i] / BPS;
            if (vals[i] > target) {
                uint256 qty = (vals[i] - target) * 1e18 / pxs[i];
                _sell(a, _equities[i], qty);
            }
        }
        uint256 raised = cash() - cashBefore;
        // buy underweights with the proceeds, pro-rata to their deficit
        uint256 deficitTotal;
        for (uint256 i; i < n; ++i) {
            uint256 target = total * _weights[i] / BPS;
            if (vals[i] < target) deficitTotal += target - vals[i];
        }
        if (deficitTotal == 0) return;
        for (uint256 i; i < n; ++i) {
            uint256 target = total * _weights[i] / BPS;
            if (vals[i] < target) {
                uint256 amt = raised.mulDiv(target - vals[i], deficitTotal);
                if (amt > 0) _buy(a, _equities[i], amt);
            }
        }
    }

    function _buy(address a, address equity, uint256 amt) internal {
        uint256 out = exchange.buyEquity(a, equity, amt, 0, address(this));
        _cash -= amt;
        held[equity] += out;
    }

    function _sell(address a, address equity, uint256 qty) internal {
        uint256 out = exchange.sellEquity(equity, a, qty, 0, address(this));
        held[equity] -= qty;
        _cash += out;
    }

    // ------------------------------------------------------------------ internal: hedge

    function _targetNotional() internal view returns (uint256) {
        return equityValueUsd() * targetHedgeBps / BPS;
    }

    function _hedgeDrifted() internal view returns (bool) {
        uint256 target = _targetNotional();
        uint256 cur = hedgeBook.notionalOf(address(this));
        if (target == 0) return cur != 0;
        uint256 diff = cur > target ? cur - target : target - cur;
        return diff * BPS > target * hedgeDriftBps;
    }

    /// @dev Realise hedge P&L into cash and re-strike at the target notional.
    function _syncHedge() internal {
        int256 m = hedgeBook.mtmAssets(address(this));
        if (m < 0) _ensureCash(uint256(-m));
        int256 realised = hedgeBook.adjust(_targetNotional());
        if (realised > 0) _cash += uint256(realised);
        else if (realised < 0) _cash -= uint256(-realised);
    }

    // ------------------------------------------------------------------ internal: fees / events

    /// @notice Fee shares accrued since the last accrual but not yet minted.
    function pendingFeeShares() public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0 || mgmtFeeBps == 0 || treasury == address(0)) return 0;
        return supply * mgmtFeeBps * (block.timestamp - lastFeeAccrual) / (BPS * YEAR);
    }

    /// @dev Management fee is charged ONLY by dilution (minting shares to the treasury). NAV has
    /// no fee deduction. Pricing uses supply + pending fee shares so previews match execution.
    function _accrueFee() internal {
        uint256 feeShares = pendingFeeShares();
        lastFeeAccrual = uint64(block.timestamp);
        if (feeShares > 0) {
            _mint(treasury, feeShares);
            emit FeeAccrued(feeShares);
        }
    }

    function _effectiveSupply() internal view returns (uint256) {
        return totalSupply() + pendingFeeShares();
    }

    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        return assets.mulDiv(_effectiveSupply() + 10 ** _decimalsOffset(), totalAssets() + 1, rounding);
    }

    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        return shares.mulDiv(totalAssets() + 1, _effectiveSupply() + 10 ** _decimalsOffset(), rounding);
    }

    /// @dev Entry charge = assets * (ask premium over index) * investedFraction, rounded up (+1 wei
    /// for exchange rounding), because exactly that share of a deposit is bought at the ask. With
    /// no drift the premium is the spread; a cheaper DEX is not passed on to the depositor.
    function _entryCost(uint256 assets) internal view returns (uint256 c) {
        uint256 f = exchange.buyFactorWad();
        uint256 premium = f > 1e18 ? f - 1e18 : 0;
        c = assets.mulDiv(premium * (BPS - cashBufferBps), BPS * 1e18, Math.Rounding.Ceil);
        if (assets > c) c += 1;
    }

    /// @dev Exit charge = assets * spread * (equityValue / NAV). A redeemer's pro-rata slice of the
    /// equities is sold at the bid; when hedge losses make gross equity exceed NAV, the charge
    /// scales up accordingly so remaining holders never fund an exit.
    /// `sellFactor` is the executed bid as a WAD fraction of the index price; a bid above the
    /// index is not paid out to the redeemer (the surplus stays with remaining holders).
    function _exitCost(uint256 assets, uint256 sellFactor) internal view returns (uint256 c) {
        uint256 nav = totalAssets();
        if (nav == 0) return 0;
        uint256 eq = equityValue();
        uint256 loss = sellFactor >= 1e18 ? 0 : 1e18 - sellFactor;
        c = assets.mulDiv(eq * loss, nav * 1e18, Math.Rounding.Ceil);
        c = Math.min(c + 1, assets);
    }

    function _snapshot() internal {
        (uint256 fx,) = oracle.usdPerLocal(currency);
        emit NavSnapshot(totalAssets(), navPerShare(), equityValue(), hedgeMtm(), cash(), fx, block.timestamp);
    }

    // ------------------------------------------------------------------ interface resolution

    function supportsInterface(bytes4 id) public view override(AccessControlUpgradeable) returns (bool) {
        return super.supportsInterface(id);
    }
}
