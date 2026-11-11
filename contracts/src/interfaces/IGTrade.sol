// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The subset of gTrade (Gains Network) `GNSMultiCollatDiamond` used by the hedge mirror.
/// Signatures and the Trade struct follow docs.gains.trade (trading-contracts, ITradingStorage), read
/// on 9 Nov 2026. VERIFY against the deployed ABI before any mainnet use: two doc pages describe the
/// Trade struct differently, and `getTrade` is not confirmed on the docs pages we read.
/// Market orders are asynchronous: a request transaction, then an oracle-fulfilled execution.
interface IGTrade {
    struct Trade {
        address user;
        uint32 index;
        uint16 pairIndex;
        uint24 leverage; // 1e3 precision
        bool long;
        bool isOpen;
        uint8 collateralIndex;
        uint8 tradeType; // 0 = market
        uint120 collateralAmount; // collateral precision (USDC: 6 dp)
        uint64 openPrice; // 1e10
        uint64 tp;
        uint64 sl;
        bool isCounterTrade;
        uint160 positionSizeToken;
        uint24 __placeholder;
    }

    function openTrade(Trade calldata trade, uint16 maxSlippageP, address referrer) external;

    function closeTradeMarket(uint32 index, uint64 expectedPrice) external;

    function increasePositionSize(
        uint32 index,
        uint120 collateralDelta,
        uint24 leverageDelta,
        uint64 expectedPrice,
        uint16 maxSlippageP
    ) external;

    function decreasePositionSize(uint32 index, uint120 collateralDelta, uint24 leverageDelta, uint64 expectedPrice)
        external;

    function cancelOrderAfterTimeout(uint32 orderIndex) external;

    /// @dev UNVERIFIED getter, assumed (trader, index) -> Trade.
    function getTrade(address trader, uint32 index) external view returns (Trade memory);
}
