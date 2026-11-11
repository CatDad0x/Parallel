// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IMorpho, MarketParams, Id, Position, Market} from "morpho-blue/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {SharesMathLib} from "morpho-blue/libraries/SharesMathLib.sol";

import {ParallelVault} from "./ParallelVault.sol";
import {SimExchange} from "./SimExchange.sol";
import {IOracleHub} from "./interfaces/IOracleHub.sol";

/// @title ParallelRouter
/// @notice Single entry point for the Parallel Markets UI.
///  - Deposit with any stablecoin of the vault's currency group (e.g. mAUDM -> mAUDD at par).
///  - Redeem to any stablecoin of the group.
///  - One-click "deposit and borrow", "supply collateral and borrow", "repay and withdraw".
///  - Queued (market-closed) deposits go directly to `vault.requestDeposit` so the user owns the
///    request; to pay with another group stable, call `SimExchange.swapStable` first.
///
/// INTERFACE-LEVEL CONTROL ONLY: the router caps borrows at an opening LTV below each market's
/// liquidation LTV. Morpho Blue itself does not know this rule, so anyone calling Morpho directly
/// bypasses it. Borrowing is allowed 24/7; the DEX deviation guard (see SimExchange) pauses it, in
/// the router and in the vault-share oracle adapter, when the DEX is 10% or more below the index.
///
/// Morpho actions taken on a user's behalf require `morpho.setAuthorization(router, true)`.
/// Vault redemptions through the router require a share allowance to the router.
contract ParallelRouter is AccessControl, Multicall {
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;
    using SharesMathLib for uint256;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant ORACLE_PRICE_SCALE = 1e36;

    IMorpho public immutable morpho;
    SimExchange public immutable exchange;
    IOracleHub public immutable oracle;

    /// @notice Max opening LTV per Morpho market (WAD). Zero = borrowing disabled via the router.
    mapping(Id => uint256) public maxOpenLtv;

    event MaxOpenLtvSet(Id indexed id, uint256 ltv);
    event DepositedWith(address indexed user, address indexed vault, address token, uint256 amount, uint256 shares);
    event RedeemedTo(address indexed user, address indexed vault, uint256 shares, address token, uint256 amountOut);
    event Borrowed(address indexed user, Id indexed id, uint256 assets);

    error DexDislocated();
    error OpeningLtvExceeded(uint256 ltv, uint256 max);
    error BorrowingDisabled();
    error Slippage();

    constructor(IMorpho morpho_, SimExchange exchange_, IOracleHub oracle_, address admin) {
        morpho = morpho_;
        exchange = exchange_;
        oracle = oracle_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setMaxOpenLtv(MarketParams calldata mp, uint256 ltv) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(ltv < mp.lltv, "must be below LLTV");
        maxOpenLtv[mp.id()] = ltv;
        emit MaxOpenLtvSet(mp.id(), ltv);
    }

    // ------------------------------------------------------------------ vault flows

    /// @notice Deposit `amount` of `token` (any stable in the vault's currency group) into `vault`.
    function depositWith(ParallelVault vault, address token, uint256 amount, uint256 minShares)
        external
        returns (uint256 shares)
    {
        uint256 assets = _pullAsAsset(vault, token, amount);
        IERC20(vault.asset()).forceApprove(address(vault), assets);
        shares = vault.deposit(assets, msg.sender);
        if (shares < minShares) revert Slippage();
        emit DepositedWith(msg.sender, address(vault), token, amount, shares);
    }

    /// @notice Redeem `shares` and receive `outToken` (any stable in the vault's currency group).
    function redeemTo(ParallelVault vault, uint256 shares, address outToken, uint256 minOut)
        external
        returns (uint256 out)
    {
        uint256 assets = vault.redeem(shares, address(this), msg.sender);
        out = _payOut(vault.asset(), outToken, assets, msg.sender);
        if (out < minOut) revert Slippage();
        emit RedeemedTo(msg.sender, address(vault), shares, outToken, out);
    }

    // ------------------------------------------------------------------ lending flows

    /// @notice Supply collateral (pulled from the user) and optionally borrow in one transaction.
    function supplyCollateralAndBorrow(MarketParams calldata mp, uint256 collateral, uint256 borrowAssets) external {
        if (collateral > 0) {
            IERC20(mp.collateralToken).safeTransferFrom(msg.sender, address(this), collateral);
            _supplyCollateral(mp, collateral, msg.sender);
        }
        if (borrowAssets > 0) _borrow(mp, borrowAssets, msg.sender);
    }

    /// @notice Deposit into an Parallel Markets vault, post the shares as collateral and borrow, in one transaction.
    function depositToVaultAndBorrow(
        ParallelVault vault,
        address token,
        uint256 amount,
        uint256 minShares,
        MarketParams calldata mp,
        uint256 borrowAssets
    ) external returns (uint256 shares) {
        require(mp.collateralToken == address(vault), "market collateral != vault");
        uint256 assets = _pullAsAsset(vault, token, amount);
        IERC20(vault.asset()).forceApprove(address(vault), assets);
        shares = vault.deposit(assets, address(this));
        if (shares < minShares) revert Slippage();
        _supplyCollateral(mp, shares, msg.sender);
        if (borrowAssets > 0) _borrow(mp, borrowAssets, msg.sender);
        emit DepositedWith(msg.sender, address(vault), token, amount, shares);
    }

    /// @notice Repay debt and/or withdraw collateral. Always allowed, even while the market is closed.
    /// @param repayAll repay the full debt (ignores `repayAssets`)
    function repayAndWithdraw(MarketParams calldata mp, uint256 repayAssets, bool repayAll, uint256 withdrawCollateral)
        external
    {
        if (repayAll || repayAssets > 0) {
            Id id = mp.id();
            if (repayAll) {
                morpho.accrueInterest(mp);
                Position memory p = morpho.position(id, msg.sender);
                Market memory m = morpho.market(id);
                uint256 owed = uint256(p.borrowShares).toAssetsUp(m.totalBorrowAssets, m.totalBorrowShares);
                IERC20(mp.loanToken).safeTransferFrom(msg.sender, address(this), owed);
                IERC20(mp.loanToken).forceApprove(address(morpho), owed);
                morpho.repay(mp, 0, p.borrowShares, msg.sender, "");
            } else {
                IERC20(mp.loanToken).safeTransferFrom(msg.sender, address(this), repayAssets);
                IERC20(mp.loanToken).forceApprove(address(morpho), repayAssets);
                morpho.repay(mp, repayAssets, 0, msg.sender, "");
            }
        }
        if (withdrawCollateral > 0) morpho.withdrawCollateral(mp, withdrawCollateral, msg.sender, msg.sender);
    }

    // ------------------------------------------------------------------ views

    /// @notice Current LTV (WAD) of `user` in market `mp`. Zero if no debt.
    function ltvOf(MarketParams calldata mp, address user) public view returns (uint256) {
        uint256 debt = morpho.expectedBorrowAssets(mp, user);
        if (debt == 0) return 0;
        uint256 collValue = _collateralValue(mp, morpho.position(mp.id(), user).collateral);
        return collValue == 0 ? type(uint256).max : Math.mulDiv(debt, WAD, collValue, Math.Rounding.Ceil);
    }

    /// @notice Health factor (WAD): LLTV-adjusted collateral / debt. < 1e18 = liquidatable.
    function healthFactor(MarketParams calldata mp, address user) external view returns (uint256) {
        uint256 debt = morpho.expectedBorrowAssets(mp, user);
        if (debt == 0) return type(uint256).max;
        uint256 collValue = _collateralValue(mp, morpho.position(mp.id(), user).collateral);
        return Math.mulDiv(collValue, mp.lltv, debt);
    }

    /// @notice Max additional borrow (loan units) under the router's opening-LTV cap.
    function maxBorrow(MarketParams calldata mp, address user) external view returns (uint256) {
        uint256 cap = maxOpenLtv[mp.id()];
        uint256 limit = Math.mulDiv(_collateralValue(mp, morpho.position(mp.id(), user).collateral), cap, WAD);
        uint256 debt = morpho.expectedBorrowAssets(mp, user);
        return limit > debt ? limit - debt : 0;
    }

    // ------------------------------------------------------------------ internal

    function _borrow(MarketParams calldata mp, uint256 assets, address user) internal {
        if (exchange.deviationLevel() >= 3) revert DexDislocated();
        uint256 cap = maxOpenLtv[mp.id()];
        if (cap == 0) revert BorrowingDisabled();
        morpho.borrow(mp, assets, 0, user, user);
        uint256 ltv = ltvOf(mp, user);
        if (ltv > cap) revert OpeningLtvExceeded(ltv, cap);
        emit Borrowed(user, mp.id(), assets);
    }

    function _supplyCollateral(MarketParams calldata mp, uint256 amount, address onBehalf) internal {
        IERC20(mp.collateralToken).forceApprove(address(morpho), amount);
        morpho.supplyCollateral(mp, amount, onBehalf, "");
    }

    function _collateralValue(MarketParams calldata mp, uint256 collateral) internal view returns (uint256) {
        if (collateral == 0) return 0;
        return Math.mulDiv(collateral, IOracle(mp.oracle).price(), ORACLE_PRICE_SCALE);
    }

    /// @dev Pull `amount` of `token` from the sender and convert to the vault's asset if needed.
    function _pullAsAsset(ParallelVault vault, address token, uint256 amount) internal returns (uint256) {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        address a = vault.asset();
        if (token == a) return amount;
        return exchange.swapStable(token, a, amount, address(this));
    }

    function _payOut(address asset, address outToken, uint256 assets, address to) internal returns (uint256 out) {
        if (outToken == asset) {
            IERC20(asset).safeTransfer(to, assets);
            return assets;
        }
        return exchange.swapStable(asset, outToken, assets, to);
    }
}
