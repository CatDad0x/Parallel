// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IGTrade} from "../interfaces/IGTrade.sol";
import {IOracleHub} from "../interfaces/IOracleHub.sol";

/// @title MockGTrade
/// @notice TESTNET MOCK of the gTrade diamond, for Base Sepolia where no gTrade exists. It copies the
/// shape that matters to the hedge mirror: asynchronous market orders, USDC collateral, fees taken from
/// collateral, % PnL on notional. NOT modelled: liquidation, borrowing/funding fees, price impact,
/// slippage checks, order timeouts (only a refund stub). Anyone may call `fulfil`, playing the oracle.
///
/// Pairs: 21 = EUR/USD, 110 = EUR/AUD. Prices come from the protocol oracle.
contract MockGTrade is IGTrade {
    using SafeERC20 for IERC20;

    enum Kind {
        OPEN,
        CLOSE,
        INCREASE,
        DECREASE
    }

    struct Order {
        Kind kind;
        address user;
        uint32 index;
        uint120 collateral;
        bool exists;
    }

    IERC20 public immutable usdc;
    IOracleHub public immutable oracle;
    bytes32 public immutable EUR;
    bytes32 public immutable AUD;

    /// @notice Open/close fee per million of position size (120 = 0.012%, gTrade Forex Major).
    uint256 public feePpm = 120;

    uint32 public nextOrderId = 1;
    mapping(uint32 => Order) public orders;
    mapping(uint32 => Trade) internal _pendingOpen;
    mapping(address => uint32) public nextTradeIndex;
    mapping(address => mapping(uint32 => Trade)) internal _trades;

    event MarketOrderInitiated(uint32 indexed orderId, address indexed user, Kind kind, uint32 index);
    event MarketExecuted(uint32 indexed orderId, address indexed user, Kind kind, uint32 index, uint256 price);

    constructor(IERC20 usdc_, IOracleHub oracle_, bytes32 eur, bytes32 aud) {
        usdc = usdc_;
        oracle = oracle_;
        EUR = eur;
        AUD = aud;
    }

    // ------------------------------------------------------------------ requests

    function openTrade(Trade calldata t, uint16, address) external {
        require(t.collateralAmount > 0 && t.leverage >= 1_000 && t.tradeType == 0, "bad trade");
        require(t.pairIndex == 21 || t.pairIndex == 110, "pair");
        usdc.safeTransferFrom(msg.sender, address(this), t.collateralAmount);
        uint32 id = nextOrderId++;
        orders[id] = Order(Kind.OPEN, msg.sender, 0, t.collateralAmount, true);
        _pendingOpen[id] = t;
        emit MarketOrderInitiated(id, msg.sender, Kind.OPEN, 0);
    }

    function closeTradeMarket(uint32 index, uint64) external {
        require(_trades[msg.sender][index].isOpen, "no trade");
        _queue(Kind.CLOSE, index, 0);
    }

    function increasePositionSize(uint32 index, uint120 cd, uint24, uint64, uint16) external {
        require(_trades[msg.sender][index].isOpen && cd > 0, "bad");
        usdc.safeTransferFrom(msg.sender, address(this), cd);
        _queue(Kind.INCREASE, index, cd);
    }

    function decreasePositionSize(uint32 index, uint120 cd, uint24, uint64) external {
        Trade storage t = _trades[msg.sender][index];
        require(t.isOpen && cd > 0 && cd < t.collateralAmount, "bad");
        _queue(Kind.DECREASE, index, cd);
    }

    function cancelOrderAfterTimeout(uint32 orderId) external {
        Order memory o = orders[orderId];
        require(o.exists && o.user == msg.sender, "no order");
        delete orders[orderId];
        if (o.kind == Kind.OPEN || o.kind == Kind.INCREASE) usdc.safeTransfer(o.user, o.collateral);
    }

    function getTrade(address trader, uint32 index) external view returns (Trade memory) {
        return _trades[trader][index];
    }

    // ------------------------------------------------------------------ oracle fulfilment

    /// @notice Execute a pending order at the current oracle price. Returns the trade index.
    function fulfil(uint32 orderId) external returns (uint32 index) {
        Order memory o = orders[orderId];
        require(o.exists, "no order");
        delete orders[orderId];
        index = o.index;

        if (o.kind == Kind.OPEN) {
            Trade memory t = _pendingOpen[orderId];
            delete _pendingOpen[orderId];
            uint256 px = _price(t.pairIndex);
            uint256 size = uint256(t.collateralAmount) * t.leverage / 1_000;
            uint256 fee = size * feePpm / 1e6;
            index = nextTradeIndex[o.user]++;
            t.user = o.user;
            t.index = index;
            t.isOpen = true;
            t.openPrice = uint64(px);
            t.collateralAmount = uint120(uint256(t.collateralAmount) - fee);
            _trades[o.user][index] = t;
        } else if (o.kind == Kind.CLOSE) {
            Trade storage t = _trades[o.user][index];
            uint256 size = uint256(t.collateralAmount) * t.leverage / 1_000;
            int256 pnl = _pnl(t, size, _price(t.pairIndex));
            int256 pay = int256(uint256(t.collateralAmount)) + pnl - int256(size * feePpm / 1e6);
            t.isOpen = false;
            t.collateralAmount = 0;
            if (pay > 0) usdc.safeTransfer(o.user, uint256(pay));
        } else if (o.kind == Kind.INCREASE) {
            Trade storage t = _trades[o.user][index];
            uint256 px = _price(t.pairIndex);
            uint256 oldSize = uint256(t.collateralAmount) * t.leverage / 1_000;
            uint256 addSize = uint256(o.collateral) * t.leverage / 1_000;
            uint256 fee = addSize * feePpm / 1e6;
            // volume-weighted open price over token quantity (size / price)
            uint256 tokens = oldSize * 1e30 / t.openPrice + addSize * 1e30 / px;
            uint256 newSize = oldSize + addSize;
            t.openPrice = uint64(newSize * 1e30 / tokens);
            t.collateralAmount = uint120(uint256(t.collateralAmount) + o.collateral - fee);
            t.leverage = uint24(newSize * 1_000 / t.collateralAmount);
        } else {
            Trade storage t = _trades[o.user][index];
            uint256 removeSize = uint256(o.collateral) * t.leverage / 1_000;
            int256 pnl = _pnl(t, removeSize, _price(t.pairIndex));
            int256 pay = int256(uint256(o.collateral)) + pnl - int256(removeSize * feePpm / 1e6);
            t.collateralAmount -= o.collateral;
            if (pay > 0) usdc.safeTransfer(o.user, uint256(pay));
        }
        emit MarketExecuted(orderId, o.user, o.kind, index, 0);
    }

    // ------------------------------------------------------------------ internal

    function _queue(Kind kind, uint32 index, uint120 collateral) internal {
        uint32 id = nextOrderId++;
        orders[id] = Order(kind, msg.sender, index, collateral, true);
        emit MarketOrderInitiated(id, msg.sender, kind, index);
    }

    function _pnl(Trade storage t, uint256 size, uint256 px) internal view returns (int256 pnl) {
        pnl = int256(size) * (int256(px) - int256(uint256(t.openPrice))) / int256(uint256(t.openPrice));
        if (!t.long) pnl = -pnl;
    }

    /// @dev 1e10 precision, from the protocol oracle (USD per local, 18 dp).
    function _price(uint16 pair) internal view returns (uint256) {
        (uint256 eur,) = oracle.usdPerLocal(EUR);
        if (pair == 21) return eur / 1e8;
        (uint256 aud,) = oracle.usdPerLocal(AUD);
        return (eur * 1e18 / aud) / 1e8;
    }
}
