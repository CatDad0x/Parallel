// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IGTrade} from "../interfaces/IGTrade.sol";
import {IHedgeVenue} from "../interfaces/IHedgeVenue.sol";
import {IOracleHub} from "../interfaces/IOracleHub.sol";

/// @title GTradeVenue
/// @notice Mirrors the protocol's aggregate FX hedge on gTrade, using USDC margin held here.
///
/// Each currency maps to one or two gTrade legs, each sized to the same USD notional:
///   EUR: long EUR/USD
///   AUD: long EUR/USD + short EUR/AUD   (AUD/USD = EUR/USD / EUR/AUD, so the legs net to long AUD)
/// Simple returns of the legs only approximate the AUD/USD return, and costs are paid on both legs.
/// INR has no gTrade pair, so it is unsupported here.
///
/// gTrade execution is oracle-fulfilled in a second transaction and gives no callback, so the keeper
/// calls `confirm` after each order to record the resulting trade. Margin is fixed at notional /
/// leverage and is NOT topped up automatically: watch `equityUsd` against the notional.
contract GTradeVenue is IHedgeVenue, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    struct Leg {
        uint16 pairIndex;
        bytes32 base; // currency whose USD price starts the pair price
        bytes32 quote; // bytes32(0) means USD
        bool long;
        uint32 index; // gTrade trade index, valid while `open`
        bool open;
        bool pending;
    }

    IGTrade public immutable gtrade;
    IERC20 public immutable usdc; // 6 dp
    IOracleHub public immutable oracle;

    uint24 public leverageX1000 = 5_000; // 5x
    uint16 public maxSlippageP = 1_000; // gTrade 1e3 precision (1%). Unverified unit.
    /// @dev USDC index on gTrade differs per chain: 1 on Base mainnet, 3 on Arbitrum Sepolia (read
    /// from the contracts 10 Nov 2026). Set it per deployment with `setParams`.
    uint8 public collateralIndex = 1;

    mapping(bytes32 => Leg[]) internal _legs;

    event LegConfigured(bytes32 indexed currency, uint16 pairIndex, bool long);
    event OrderRequested(bytes32 indexed currency, uint256 legId, string action, uint256 collateral);
    event OrderConfirmed(bytes32 indexed currency, uint256 legId, bool open, uint32 index);
    event Withdrawn(address indexed to, uint256 amount);

    error Unsupported(bytes32 currency);
    error Pending(bytes32 currency);
    error BadTrade();

    constructor(IGTrade gtrade_, IERC20 usdc_, IOracleHub oracle_, address admin) {
        gtrade = gtrade_;
        usdc = usdc_;
        oracle = oracle_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        usdc_.forceApprove(address(gtrade_), type(uint256).max);
    }

    // ------------------------------------------------------------------ admin

    function setLegs(bytes32 currency, Leg[] calldata legs_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Leg[] storage ls = _legs[currency];
        for (uint256 i; i < ls.length; ++i) {
            if (ls[i].open || ls[i].pending) revert Pending(currency);
        }
        delete _legs[currency];
        for (uint256 i; i < legs_.length; ++i) {
            _legs[currency].push(
                Leg(legs_[i].pairIndex, legs_[i].base, legs_[i].quote, legs_[i].long, 0, false, false)
            );
            emit LegConfigured(currency, legs_[i].pairIndex, legs_[i].long);
        }
    }

    function setParams(uint24 leverageX1000_, uint16 maxSlippageP_, uint8 collateralIndex_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(leverageX1000_ >= 1_000 && leverageX1000_ <= 20_000, "leverage 1-20x");
        leverageX1000 = leverageX1000_;
        maxSlippageP = maxSlippageP_;
        collateralIndex = collateralIndex_;
    }

    /// @notice Anyone can add USDC margin (treasury funds the venue this way).
    function fund(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Admin withdraws idle USDC (profit sweep). Margin inside gTrade is not touched.
    function withdraw(uint256 amount, address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        usdc.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // ------------------------------------------------------------------ views

    function legCount(bytes32 currency) external view returns (uint256) {
        return _legs[currency].length;
    }

    function leg(bytes32 currency, uint256 id) external view returns (Leg memory) {
        return _legs[currency][id];
    }

    function isSupported(bytes32 currency) public view returns (bool) {
        return _legs[currency].length != 0;
    }

    function pending(bytes32 currency) public view returns (bool) {
        Leg[] storage ls = _legs[currency];
        for (uint256 i; i < ls.length; ++i) {
            if (ls[i].pending) return true;
        }
        return false;
    }

    function notionalUsd(bytes32 currency) external view returns (uint256) {
        Leg[] storage ls = _legs[currency];
        return ls.length == 0 ? 0 : _legNotional(ls[0]);
    }

    function equityUsd(bytes32 currency) external view returns (int256 eq) {
        Leg[] storage ls = _legs[currency];
        for (uint256 i; i < ls.length; ++i) {
            Leg storage l = ls[i];
            if (!l.open) continue;
            IGTrade.Trade memory t = gtrade.getTrade(address(this), l.index);
            if (!t.isOpen) continue;
            int256 size = int256(uint256(t.collateralAmount) * t.leverage / 1_000 * 1e12);
            int256 open18 = int256(uint256(t.openPrice) * 1e8);
            int256 px = int256(_price(l));
            int256 pnl = size * (px - open18) / open18;
            if (!l.long) pnl = -pnl;
            eq += int256(uint256(t.collateralAmount) * 1e12) + pnl;
        }
    }

    // ------------------------------------------------------------------ operator actions

    function setTarget(bytes32 currency, uint256 targetUsd) external onlyRole(OPERATOR_ROLE) {
        Leg[] storage ls = _legs[currency];
        if (ls.length == 0) revert Unsupported(currency);
        if (pending(currency)) revert Pending(currency);
        for (uint256 i; i < ls.length; ++i) {
            _resize(currency, i, ls[i], targetUsd);
        }
    }

    /// @notice Record the outcome of an executed order: read the trade back from gTrade and clear
    /// `pending`. Pass the trade index (from the MarketExecuted event for a new trade).
    function confirm(bytes32 currency, uint256 legId, uint32 index) external onlyRole(OPERATOR_ROLE) {
        Leg storage l = _legs[currency][legId];
        IGTrade.Trade memory t = gtrade.getTrade(address(this), index);
        if (t.isOpen) {
            if (t.pairIndex != l.pairIndex || t.long != l.long) revert BadTrade();
            l.index = index;
            l.open = true;
        } else {
            l.open = false;
        }
        l.pending = false;
        emit OrderConfirmed(currency, legId, l.open, index);
    }

    /// @notice Reclaim an order that gTrade failed to execute within its timeout, then re-confirm.
    function cancelTimeout(bytes32 currency, uint256 legId, uint32 orderIndex) external onlyRole(OPERATOR_ROLE) {
        gtrade.cancelOrderAfterTimeout(orderIndex);
        _legs[currency][legId].pending = false;
    }

    // ------------------------------------------------------------------ internal

    function _legNotional(Leg storage l) internal view returns (uint256) {
        if (!l.open) return 0;
        IGTrade.Trade memory t = gtrade.getTrade(address(this), l.index);
        if (!t.isOpen) return 0;
        return uint256(t.collateralAmount) * t.leverage / 1_000 * 1e12;
    }

    /// @dev Pair price in 18 dp from the protocol oracle. Used for the equity view and for the
    /// expected price passed to gTrade (1e10).
    function _price(Leg storage l) internal view returns (uint256) {
        (uint256 b,) = oracle.usdPerLocal(l.base);
        if (l.quote == bytes32(0)) return b;
        (uint256 q,) = oracle.usdPerLocal(l.quote);
        return b * 1e18 / q;
    }

    function _resize(bytes32 currency, uint256 id, Leg storage l, uint256 targetUsd) internal {
        uint256 cur = _legNotional(l);
        if (cur == targetUsd) return;
        uint64 expected = uint64(_price(l) / 1e8);

        if (!l.open) {
            uint256 col = targetUsd * 1_000 / leverageX1000 / 1e12;
            IGTrade.Trade memory t;
            t.user = address(this);
            t.pairIndex = l.pairIndex;
            t.leverage = leverageX1000;
            t.long = l.long;
            t.collateralIndex = collateralIndex;
            t.collateralAmount = uint120(col);
            t.openPrice = expected;
            gtrade.openTrade(t, maxSlippageP, address(0));
            emit OrderRequested(currency, id, "open", col);
        } else if (targetUsd == 0) {
            gtrade.closeTradeMarket(l.index, expected);
            emit OrderRequested(currency, id, "close", 0);
        } else if (targetUsd > cur) {
            uint256 d = (targetUsd - cur) * 1_000 / leverageX1000 / 1e12;
            gtrade.increasePositionSize(l.index, uint120(d), 0, expected, maxSlippageP);
            emit OrderRequested(currency, id, "increase", d);
        } else {
            uint256 d = (cur - targetUsd) * 1_000 / leverageX1000 / 1e12;
            gtrade.decreasePositionSize(l.index, uint120(d), 0, expected);
            emit OrderRequested(currency, id, "decrease", d);
        }
        l.pending = true;
    }
}
