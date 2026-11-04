// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IPyth} from "../interfaces/IPyth.sol";

/// @title DemoPyth
/// @notice TESTNET ONLY. A Pyth-compatible price store whose prices are pushed by the Parallel Markets
/// keeper (simulated live prices). Used when the demo runs outside US market hours or without a
/// Pyth API key, so the full journey works 24/7. The UI labels these prices as simulated.
contract DemoPyth is IPyth, AccessControl {
    bytes32 public constant UPDATER_ROLE = keccak256("UPDATER_ROLE");

    mapping(bytes32 => Price) internal _prices;

    event PriceSet(bytes32 indexed id, int64 price, int32 expo, uint256 publishTime);

    error StalePrice();
    error PriceFeedNotFound();

    constructor(address admin, address updater) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPDATER_ROLE, admin);
        _grantRole(UPDATER_ROLE, updater);
    }

    function setPrices(bytes32[] calldata ids, int64[] calldata prices, int32 expo) external onlyRole(UPDATER_ROLE) {
        require(ids.length == prices.length, "length");
        for (uint256 i; i < ids.length; ++i) {
            require(prices[i] > 0, "price");
            _prices[ids[i]] = Price(prices[i], 0, expo, block.timestamp);
            emit PriceSet(ids[i], prices[i], expo, block.timestamp);
        }
    }

    function getPriceUnsafe(bytes32 id) public view returns (Price memory p) {
        p = _prices[id];
        if (p.publishTime == 0) revert PriceFeedNotFound();
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory p) {
        p = getPriceUnsafe(id);
        if (block.timestamp > p.publishTime + age) revert StalePrice();
    }

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    function updatePriceFeeds(bytes[] calldata) external payable {}
}
