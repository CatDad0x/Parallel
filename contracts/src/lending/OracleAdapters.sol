// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IOracleHub} from "../interfaces/IOracleHub.sol";

interface IParallelVaultView {
    function previewRedeem(uint256 shares) external view returns (uint256);
    function asset() external view returns (address);
    function decimals() external view returns (uint8);
}

/// @title EquityOracleAdapter
/// @notice Morpho oracle for (collateral = equity token, loan = local stablecoin).
/// Morpho expects the price of 1 whole collateral token in whole loan tokens, scaled by
/// 10^(36 + loanDecimals - collateralDecimals).
///
///   wholePrice = equityUsd / usdPerLocal          (local currency per equity token)
///   price()    = wholePrice * 10^(36 + dLoan - dCollateral)
///
/// Inherits OracleHub behaviour: reverts on stale data while the US market is open (which pauses
/// borrows AND liquidations until the keeper pushes fresh prices), returns last close when closed.
contract EquityOracleAdapter is IOracle {
    IOracleHub public immutable hub;
    address public immutable equity;
    bytes32 public immutable currency;
    uint256 internal immutable _scale; // 10^(36 + dLoan - dColl - 18), applied to an 18-dp price

    constructor(IOracleHub hub_, address equity_, bytes32 currency_, address loanToken) {
        hub = hub_;
        equity = equity_;
        currency = currency_;
        uint256 exp = 36 + IERC20Metadata(loanToken).decimals() - IERC20Metadata(equity_).decimals() - 18;
        _scale = 10 ** exp;
    }

    function price() external view returns (uint256) {
        (uint256 eqUsd,) = hub.equityPriceUsd(equity);
        (uint256 fx,) = hub.usdPerLocal(currency);
        uint256 local18 = eqUsd * 1e18 / fx; // local per whole token, 18 dp
        return local18 * _scale;
    }
}

/// @title VaultShareOracleAdapter
/// @notice Morpho oracle for (collateral = Parallel Markets vault shares, loan = the vault's own asset).
/// Values one whole share at its **realisable** value, `previewRedeem(1 share)`, i.e. NAV per
/// share net of the exit cost a liquidator would pay. NAV uses tracked balances, so direct token
/// donations to the vault do not move this price. It still depends on equity prices, FX, hedge
/// MTM and fees; it is not manipulation-proof against a compromised feed or admin.
contract VaultShareOracleAdapter is IOracle {
    IParallelVaultView public immutable vault;
    uint256 internal immutable _oneShare;
    uint256 internal immutable _scale; // 10^(36 + dLoan - dShares - dAsset)

    constructor(IParallelVaultView vault_) {
        vault = vault_;
        uint8 dShares = vault_.decimals();
        uint8 dAsset = IERC20Metadata(vault_.asset()).decimals();
        _oneShare = 10 ** dShares;
        // loan token == vault asset, so dLoan == dAsset and the exponent is 36 - dShares
        _scale = 10 ** (36 - uint256(dShares));
        dAsset; // documented above
    }

    function price() external view returns (uint256) {
        return vault.previewRedeem(_oneShare) * _scale;
    }
}
