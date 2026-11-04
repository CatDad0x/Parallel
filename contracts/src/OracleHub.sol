// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IPyth} from "./interfaces/IPyth.sol";
import {IOracleHub} from "./interfaces/IOracleHub.sol";

/// @title OracleHub
/// @notice Single source of truth for Parallel Markets prices.
///  - Equity prices: USD per token (18 dp).
///  - FX: USD per 1 unit of local currency (18 dp). Inverted feeds (e.g. USD/INR) are flipped on read.
///  - Admin overrides for staged demo price shocks (auto-expiring).
///  - Market-hours policy: AUTO (NYSE weekday schedule) or forced open/closed for demos.
contract OracleHub is IOracleHub, AccessControl {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    enum MarketMode {
        AUTO,
        FORCE_OPEN,
        FORCE_CLOSED
    }

    struct Feed {
        bytes32 pythId;
        bool invert; // true when the Pyth feed is quoted as USD/LOCAL (e.g. USD/INR)
        bool exists;
    }

    struct Override {
        uint256 price; // 18 dp, already in Parallel Markets convention
        uint64 expiry;
    }

    IPyth public immutable pyth;

    /// @dev key = bytes32(uint256(uint160(token))) for equities, bytes32("AUD") etc. for currencies
    mapping(bytes32 => Feed) public feeds;
    mapping(bytes32 => Override) public overrides;

    uint256 public maxAge = 15 minutes;
    /// @dev Reject Pyth prices whose confidence interval exceeds this share of the price.
    uint256 public maxConfBps = 200;
    MarketMode public marketMode = MarketMode.AUTO;

    /// @dev Offset from UTC to US Eastern time, in seconds (negative). Admin flips for DST.
    int256 public etOffset = -5 hours;
    uint256 public sessionOpen = 9 hours + 30 minutes; // seconds after ET midnight
    uint256 public sessionClose = 16 hours;
    mapping(uint256 => bool) public holiday; // ET day number (ET timestamp / 1 days)

    event FeedSet(bytes32 indexed key, bytes32 pythId, bool invert);
    event OverrideSet(bytes32 indexed key, uint256 price, uint64 expiry);
    event OverrideCleared(bytes32 indexed key);
    event MarketModeSet(MarketMode mode);
    event MaxAgeSet(uint256 maxAge);

    error UnknownFeed(bytes32 key);
    error InvalidPrice(bytes32 key);
    error WideConfidence(bytes32 key);

    constructor(IPyth pyth_, address admin) {
        pyth = pyth_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ keys

    function equityKey(address token) public pure returns (bytes32) {
        return bytes32(uint256(uint160(token)));
    }

    // ------------------------------------------------------------------ reads

    function equityPriceUsd(address token) external view returns (uint256, uint256) {
        return price(equityKey(token));
    }

    function usdPerLocal(bytes32 currency) external view returns (uint256, uint256) {
        return price(currency);
    }

    /// @notice Price for a key in Parallel Markets convention (18 dp). Override wins while active.
    /// When the market is open, Pyth data older than `maxAge` reverts. When closed, the last
    /// published price is returned (the "last close").
    function price(bytes32 key) public view returns (uint256 p, uint256 updatedAt) {
        Override memory o = overrides[key];
        if (o.expiry > block.timestamp) return (o.price, block.timestamp);
        return livePrice(key);
    }

    /// @notice Pyth-only price, ignoring overrides.
    function livePrice(bytes32 key) public view returns (uint256 p, uint256 updatedAt) {
        Feed memory f = feeds[key];
        if (!f.exists) revert UnknownFeed(key);

        IPyth.Price memory raw =
            isMarketOpen() ? pyth.getPriceNoOlderThan(f.pythId, maxAge) : pyth.getPriceUnsafe(f.pythId);
        if (raw.price <= 0) revert InvalidPrice(key);
        if (uint256(raw.conf) * 10_000 > uint256(uint64(raw.price)) * maxConfBps) revert WideConfidence(key);

        p = _scale(uint256(uint64(raw.price)), raw.expo);
        if (f.invert) p = 1e36 / p;
        updatedAt = raw.publishTime;
    }

    /// @notice Price plus status flags, for frontends and keepers.
    /// @return p Price (18 dp).
    /// @return updatedAt Publish time, or now if overridden.
    /// @return marketOpen Whether the US session is open.
    /// @return overridden Whether an admin override is active.
    function priceStatus(bytes32 key)
        external
        view
        returns (uint256 p, uint256 updatedAt, bool marketOpen, bool overridden)
    {
        (p, updatedAt) = price(key);
        marketOpen = isMarketOpen();
        overridden = overrides[key].expiry > block.timestamp;
    }

    function isMarketOpen() public view returns (bool) {
        if (marketMode == MarketMode.FORCE_OPEN) return true;
        if (marketMode == MarketMode.FORCE_CLOSED) return false;

        uint256 et = uint256(int256(block.timestamp) + etOffset);
        uint256 day = et / 1 days;
        uint256 dow = (day + 4) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
        if (dow == 0 || dow == 6) return false;
        if (holiday[day]) return false;
        uint256 secs = et % 1 days;
        return secs >= sessionOpen && secs < sessionClose;
    }

    // ------------------------------------------------------------------ admin

    function setFeed(bytes32 key, bytes32 pythId, bool invert) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeds[key] = Feed(pythId, invert, true);
        emit FeedSet(key, pythId, invert);
    }

    function setOverride(bytes32 key, uint256 p, uint64 expiry) public onlyRole(DEFAULT_ADMIN_ROLE) {
        if (p == 0) revert InvalidPrice(key);
        overrides[key] = Override(p, expiry);
        emit OverrideSet(key, p, expiry);
    }

    /// @notice Shock a price by `bps` (signed) relative to the current price, for `duration` seconds.
    /// e.g. shock(SPY, -2000, 1 hours) = S&P down 20% for an hour.
    function shock(bytes32 key, int256 bps, uint64 duration) external onlyRole(DEFAULT_ADMIN_ROLE) {
        (uint256 p,) = price(key);
        int256 next = int256(p) * (10_000 + bps) / 10_000;
        if (next <= 0) revert InvalidPrice(key);
        setOverride(key, uint256(next), uint64(block.timestamp) + duration);
    }

    function clearOverride(bytes32 key) external onlyRole(DEFAULT_ADMIN_ROLE) {
        delete overrides[key];
        emit OverrideCleared(key);
    }

    function setMarketMode(MarketMode mode) external onlyRole(DEFAULT_ADMIN_ROLE) {
        marketMode = mode;
        emit MarketModeSet(mode);
    }

    function setMaxConfBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxConfBps = bps;
    }

    function setMaxAge(uint256 maxAge_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxAge = maxAge_;
        emit MaxAgeSet(maxAge_);
    }

    function setSchedule(int256 etOffset_, uint256 open_, uint256 close_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        etOffset = etOffset_;
        sessionOpen = open_;
        sessionClose = close_;
    }

    function setHoliday(uint256 etDay, bool isHoliday) external onlyRole(DEFAULT_ADMIN_ROLE) {
        holiday[etDay] = isHoliday;
    }

    /// @notice Forwards Pyth update data (keeper pushes Hermes updates). Excess ETH is refunded.
    function updatePrices(bytes[] calldata updateData) external payable {
        uint256 fee = pyth.getUpdateFee(updateData);
        pyth.updatePriceFeeds{value: fee}(updateData);
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            require(ok, "refund failed");
        }
    }

    // ------------------------------------------------------------------ internal

    function _scale(uint256 v, int32 expo) internal pure returns (uint256) {
        int256 e = int256(expo) + 18;
        if (e >= 0) return v * 10 ** uint256(e);
        return v / 10 ** uint256(-e);
    }
}
