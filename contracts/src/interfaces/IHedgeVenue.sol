// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice An external venue where the protocol mirrors its aggregate FX hedge (short USD / long
/// local) per currency. Venue operations can be asynchronous, so callers must check `pending`.
interface IHedgeVenue {
    /// @notice Whether the venue can hedge this currency.
    function isSupported(bytes32 currency) external view returns (bool);

    /// @notice Live hedged notional in USD (18 dp). Zero until an order has been confirmed.
    function notionalUsd(bytes32 currency) external view returns (uint256);

    /// @notice Margin plus unrealised profit or loss in USD (18 dp), across all legs.
    function equityUsd(bytes32 currency) external view returns (int256);

    /// @notice True while an order for this currency awaits execution.
    function pending(bytes32 currency) external view returns (bool);

    /// @notice Ask the venue to move the hedge to `targetUsd` (18 dp). Asynchronous.
    function setTarget(bytes32 currency, uint256 targetUsd) external;
}
