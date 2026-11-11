// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IOracleHub} from "./interfaces/IOracleHub.sol";
import {IMintableToken} from "./interfaces/IMintableToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title HedgeBook (onchain FX perp venue, testnet)
/// @notice An onchain, oracle-priced FX perpetual venue with a real liquidity pool. Each hedged vault
/// holds one position: SHORT USD / LONG local. The other side of every trade is a per-currency LP pool
/// funded by real stablecoin deposits. Nothing is minted or burned: hedge gains are paid out of the pool
/// and hedge losses (and carry) are paid into it. Anyone can supply liquidity and earn the carry, and
/// carries the risk that hedgers win. This mirrors how oracle-priced FX perp DEXs work (for example
/// Ostium or gTrade), but it is a mock for testnet, not a connection to a real venue.
///
///   mtmLocal = N * (1/K - 1/S_t) - carry
///
/// where N = USD notional, K = strike (USD per local at entry), S_t = current USD per local.
/// When the local currency strengthens (S rises) the hedge gains, offsetting the fall in the
/// local value of USD-priced equities.
///
/// Carry models the interest-rate differential embedded in forward points: positive
/// `carryBpsPerYear` is a cost to the hedger, negative is a benefit.
///
/// Every `adjust` realises the full MTM into the vault's cash (mint on gain, burn on loss) and
/// re-strikes the whole position at spot. This is economically equivalent to a rolling forward
/// and keeps accounting simple. In production this book would be an institutional FX counterparty.
contract HedgeBook is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    uint256 public constant BPS = 10_000;
    uint256 public constant YEAR = 365 days;

    struct Position {
        bytes32 currency;
        IMintableToken asset; // local stable the vault accounts in
        uint256 notionalUsd; // 18 dp
        uint256 strike; // USD per local, 18 dp
        uint64 lastAccrual;
        bool registered;
    }

    /// @notice Max open interest per currency as a multiple of pool liquidity (bps). 5x = 50_000.
    uint256 public constant MAX_OI_BPS = 50_000;
    /// @notice LPs cannot withdraw below this fraction of open interest (bps of OI value).
    uint256 public constant LP_RESERVE_BPS = 2_000;
    uint256 private constant DEAD_SHARES = 1_000;

    IOracleHub public immutable oracle;

    /// @notice Stablecoin that settles each currency's pool (set by the first vault registered).
    mapping(bytes32 => IMintableToken) public poolAsset;
    /// @notice Tracked pool liquidity per currency, in token units (never raw balanceOf).
    mapping(bytes32 => uint256) public poolBalance;
    mapping(bytes32 => uint256) public totalLpShares;
    mapping(bytes32 => mapping(address => uint256)) public lpShares;
    /// @notice Total hedged USD notional (18 dp) per currency.
    mapping(bytes32 => uint256) public openInterestUsd;

    mapping(address => Position) public positions;
    mapping(bytes32 => int256) public carryBpsPerYear; // per currency

    event VaultRegistered(address indexed vault, bytes32 currency, address asset);
    event HedgeAdjusted(
        address indexed vault, uint256 oldNotional, uint256 newNotional, uint256 strike, int256 realisedLocal
    );
    event CarrySet(bytes32 indexed currency, int256 bpsPerYear);

    event LpDeposit(bytes32 indexed currency, address indexed lp, uint256 assets, uint256 shares);
    event LpWithdraw(bytes32 indexed currency, address indexed lp, uint256 assets, uint256 shares);
    event Settled(address indexed vault, int256 owed, int256 paid);
    event CapacityClamped(address indexed vault, uint256 requestedUsd, uint256 grantedUsd);

    error NotRegistered(address vault);
    error AssetMismatch();
    error NoPool();
    error ReserveBreached();
    error ZeroAmount();

    constructor(IOracleHub oracle_, address admin) {
        oracle = oracle_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ admin

    function registerVault(address vault, bytes32 currency, IMintableToken asset) external onlyRole(REGISTRAR_ROLE) {
        IMintableToken existing = poolAsset[currency];
        if (address(existing) == address(0)) poolAsset[currency] = asset;
        else if (existing != asset) revert AssetMismatch();
        Position storage p = positions[vault];
        p.currency = currency;
        p.asset = asset;
        p.registered = true;
        p.lastAccrual = uint64(block.timestamp);
        emit VaultRegistered(vault, currency, address(asset));
    }

    function setCarry(bytes32 currency, int256 bpsPerYear) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(bpsPerYear > -2_000 && bpsPerYear < 2_000, "carry out of range");
        carryBpsPerYear[currency] = bpsPerYear;
        emit CarrySet(currency, bpsPerYear);
    }

    // ------------------------------------------------------------------ views

    /// @notice Signed mark-to-market in local currency, 18 dp.
    function mtmLocal18(address vault) public view returns (int256) {
        Position memory p = positions[vault];
        if (p.notionalUsd == 0) return 0;
        (uint256 s,) = oracle.usdPerLocal(p.currency);
        int256 atStrike = int256(p.notionalUsd * 1e18 / p.strike);
        int256 atSpot = int256(p.notionalUsd * 1e18 / s);
        return atStrike - atSpot - _pendingCarry(p);
    }

    /// @notice Signed mark-to-market in the vault's asset units (token decimals).
    function mtmAssets(address vault) external view returns (int256) {
        int256 m = mtmLocal18(vault);
        uint256 scale = 10 ** (18 - positions[vault].asset.decimals());
        return m / int256(scale);
    }

    function notionalOf(address vault) external view returns (uint256) {
        return positions[vault].notionalUsd;
    }

    // ------------------------------------------------------------------ vault actions

    /// @notice Realise all P&L against the LP pool and re-strike at spot for `newNotionalUsd`.
    /// Gains are paid from the pool (capped at what the pool holds); losses are pulled from the vault,
    /// which must hold enough local stable. Returns the amount actually settled (+ received, - paid).
    /// The new notional is clamped to pool capacity rather than reverting, so vault operations never
    /// brick; the vault then simply runs under-hedged until liquidity returns.
    function adjust(uint256 newNotionalUsd) external nonReentrant returns (int256 realised) {
        Position storage p = positions[msg.sender];
        if (!p.registered) revert NotRegistered(msg.sender);
        bytes32 ccy = p.currency;

        int256 pnl18 = mtmLocal18(msg.sender);
        uint256 scale = 10 ** (18 - p.asset.decimals());
        int256 owed = pnl18 / int256(scale);

        IERC20 token = IERC20(address(p.asset));
        if (owed > 0) {
            uint256 pay = uint256(owed);
            if (pay > poolBalance[ccy]) pay = poolBalance[ccy]; // pool cannot pay more than it has
            poolBalance[ccy] -= pay;
            if (pay > 0) token.safeTransfer(msg.sender, pay);
            realised = int256(pay);
        } else if (owed < 0) {
            uint256 loss = uint256(-owed);
            poolBalance[ccy] += loss;
            token.safeTransferFrom(msg.sender, address(this), loss);
            realised = owed;
        }
        emit Settled(msg.sender, owed, realised);

        (uint256 s,) = oracle.usdPerLocal(ccy);
        uint256 old = p.notionalUsd;

        // Clamp to pool capacity: OI value (local) <= poolBalance * MAX_OI_BPS / BPS.
        uint256 granted = newNotionalUsd;
        if (newNotionalUsd > old) {
            uint256 otherUsd = openInterestUsd[ccy] - old;
            uint256 capUsd = (poolBalance[ccy] * scale) * MAX_OI_BPS / BPS * s / 1e18;
            uint256 room = capUsd > otherUsd ? capUsd - otherUsd : 0;
            if (granted > room) {
                granted = room < old ? old : room; // never force a reduction here
                emit CapacityClamped(msg.sender, newNotionalUsd, granted);
            }
        }
        openInterestUsd[ccy] = openInterestUsd[ccy] - old + granted;
        p.notionalUsd = granted;
        p.strike = s;
        p.lastAccrual = uint64(block.timestamp);

        emit HedgeAdjusted(msg.sender, old, granted, s, realised);
    }

    // ------------------------------------------------------------------ liquidity providers

    /// @notice Supply stablecoin liquidity to a currency's pool. LPs take the other side of hedgers:
    /// they earn carry and trading flow, and lose when the local currency strengthens against USD.
    function lpDeposit(bytes32 ccy, uint256 assets) external nonReentrant returns (uint256 shares) {
        IMintableToken a = poolAsset[ccy];
        if (address(a) == address(0)) revert NoPool();
        if (assets == 0) revert ZeroAmount();
        uint256 value = poolValue(ccy);
        uint256 supply = totalLpShares[ccy];
        if (supply == 0) {
            shares = assets;
            // Lock a small amount so the share price cannot be inflated by the first depositor.
            totalLpShares[ccy] = DEAD_SHARES;
            shares -= DEAD_SHARES;
        } else {
            shares = assets * supply / value;
        }
        if (shares == 0) revert ZeroAmount();
        IERC20(address(a)).safeTransferFrom(msg.sender, address(this), assets);
        poolBalance[ccy] += assets;
        totalLpShares[ccy] += shares;
        lpShares[ccy][msg.sender] += shares;
        emit LpDeposit(ccy, msg.sender, assets, shares);
    }

    /// @notice Withdraw liquidity, as long as the pool keeps a reserve against open positions.
    function lpWithdraw(bytes32 ccy, uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        assets = shares * poolValue(ccy) / totalLpShares[ccy];
        lpShares[ccy][msg.sender] -= shares;
        totalLpShares[ccy] -= shares;
        poolBalance[ccy] -= assets;
        if (poolBalance[ccy] < reserveRequired(ccy)) revert ReserveBreached();
        IERC20(address(poolAsset[ccy])).safeTransfer(msg.sender, assets);
        emit LpWithdraw(ccy, msg.sender, assets, shares);
    }

    // ------------------------------------------------------------------ pool views

    /// @notice Pool value in token units. Open positions settle at their next adjust, so this is the
    /// tracked liquidity (an unrealised hedger gain is a claim that has not been paid yet).
    function poolValue(bytes32 ccy) public view returns (uint256) {
        return poolBalance[ccy];
    }

    /// @notice An LP's claim on the pool, in token units.
    function lpValueOf(bytes32 ccy, address lp) external view returns (uint256) {
        uint256 supply = totalLpShares[ccy];
        return supply == 0 ? 0 : lpShares[ccy][lp] * poolBalance[ccy] / supply;
    }

    /// @notice Open interest valued in local token units at the current oracle price.
    function openInterestAssets(bytes32 ccy) public view returns (uint256) {
        IMintableToken a = poolAsset[ccy];
        if (address(a) == address(0) || openInterestUsd[ccy] == 0) return 0;
        (uint256 s,) = oracle.usdPerLocal(ccy);
        return openInterestUsd[ccy] * 1e18 / s / (10 ** (18 - a.decimals()));
    }

    function reserveRequired(bytes32 ccy) public view returns (uint256) {
        return openInterestAssets(ccy) * LP_RESERVE_BPS / BPS;
    }

    /// @notice Open interest as a share of the capacity (bps; 10_000 = full).
    function utilizationBps(bytes32 ccy) external view returns (uint256) {
        uint256 cap = poolBalance[ccy] * MAX_OI_BPS / BPS;
        return cap == 0 ? 0 : openInterestAssets(ccy) * BPS / cap;
    }

    // ------------------------------------------------------------------ internal

    function _pendingCarry(Position memory p) internal view returns (int256) {
        int256 bps = carryBpsPerYear[p.currency];
        if (bps == 0 || p.notionalUsd == 0) return 0;
        int256 localNotional = int256(p.notionalUsd * 1e18 / p.strike);
        int256 dt = int256(block.timestamp - p.lastAccrual);
        return localNotional * bps * dt / int256(BPS * YEAR);
    }
}
