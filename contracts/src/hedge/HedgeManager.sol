// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {HedgeBook} from "../HedgeBook.sol";
import {IHedgeVenue} from "../interfaces/IHedgeVenue.sol";

/// @title HedgeManager
/// @notice Keeps a real position on an external venue (for example gTrade) in line with the
/// protocol's aggregate hedge. Vault NAV still comes from `HedgeBook` and the oracle, so deposits and
/// redeems stay instant; this contract mirrors the exposure asynchronously. In that setup the
/// `HedgeBook` LP pool is only a working-capital and timing buffer, not market-making capital.
///
/// What is mirrored per currency is `HedgeBook.openInterestUsd`: the total USD short across vaults.
contract HedgeManager is AccessControl {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    uint256 public constant BPS = 10_000;

    HedgeBook public immutable book;
    IHedgeVenue public immutable venue;
    /// @notice Drift between target and venue notional that triggers a resize.
    uint16 public toleranceBps = 300;

    struct Status {
        bool supported;
        bool pending;
        uint256 targetUsd;
        uint256 venueNotionalUsd;
        uint256 driftBps;
        int256 venueEquityUsd;
    }

    event Synced(bytes32 indexed currency, uint256 fromUsd, uint256 toUsd);
    event ToleranceSet(uint16 bps);

    constructor(HedgeBook book_, IHedgeVenue venue_, address admin) {
        book = book_;
        venue = venue_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setTolerance(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(bps <= 2_000, "too loose");
        toleranceBps = bps;
        emit ToleranceSet(bps);
    }

    function status(bytes32 currency) public view returns (Status memory s) {
        s.supported = venue.isSupported(currency);
        s.pending = s.supported && venue.pending(currency);
        s.targetUsd = book.openInterestUsd(currency);
        if (!s.supported) return s;
        s.venueNotionalUsd = venue.notionalUsd(currency);
        s.venueEquityUsd = venue.equityUsd(currency);
        uint256 hi = s.targetUsd > s.venueNotionalUsd ? s.targetUsd : s.venueNotionalUsd;
        uint256 lo = s.targetUsd > s.venueNotionalUsd ? s.venueNotionalUsd : s.targetUsd;
        s.driftBps = hi == 0 ? 0 : (hi - lo) * BPS / hi;
    }

    function needsSync(bytes32 currency) public view returns (bool) {
        Status memory s = status(currency);
        if (!s.supported || s.pending) return false;
        if (s.targetUsd == 0) return s.venueNotionalUsd != 0;
        return s.driftBps > toleranceBps;
    }

    /// @notice Move the venue position to the current aggregate hedge. Returns false (and does
    /// nothing) when unsupported, pending or already within tolerance.
    function sync(bytes32 currency) external onlyRole(KEEPER_ROLE) returns (bool) {
        if (!needsSync(currency)) return false;
        uint256 target = book.openInterestUsd(currency);
        uint256 from = venue.notionalUsd(currency);
        venue.setTarget(currency, target);
        emit Synced(currency, from, target);
        return true;
    }
}
