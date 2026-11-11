// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {HedgeBook} from "../src/HedgeBook.sol";
import {IMintableToken} from "../src/interfaces/IMintableToken.sol";
import {IOracleHub} from "../src/interfaces/IOracleHub.sol";
import {IGTrade} from "../src/interfaces/IGTrade.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockToken} from "../src/tokens/MockToken.sol";
import {MockGTrade} from "../src/testnet/MockGTrade.sol";
import {GTradeVenue} from "../src/hedge/GTradeVenue.sol";
import {HedgeManager} from "../src/hedge/HedgeManager.sol";

/// Mirror hedge: HedgeManager keeps a real (mock) gTrade position in line with HedgeBook open interest.
contract HedgeMirrorTest is BaseTest {
    MockToken usdc;
    MockGTrade gt;
    GTradeVenue venue;
    HedgeManager mgr;
    address audVault = makeAddr("audVault");
    address eurVault = makeAddr("eurVault");

    function setUp() public override {
        super.setUp();
        usdc = new MockToken("Mock USDC", "mUSDC", 6, STABLE, admin);
        usdc.grantRole(usdc.MINTER_ROLE(), admin);
        gt = new MockGTrade(IERC20(address(usdc)), IOracleHub(address(oracle)), EUR, AUD);
        venue = new GTradeVenue(gt, IERC20(address(usdc)), IOracleHub(address(oracle)), admin);
        mgr = new HedgeManager(hedgeBook, venue, admin);
        venue.grantRole(venue.OPERATOR_ROLE(), address(mgr));
        venue.grantRole(venue.OPERATOR_ROLE(), keeper);
        mgr.grantRole(mgr.KEEPER_ROLE(), keeper);

        // EUR = long EUR/USD (pair 21). AUD = long EUR/USD + short EUR/AUD (pair 110).
        GTradeVenue.Leg[] memory eurLegs = new GTradeVenue.Leg[](1);
        eurLegs[0] = GTradeVenue.Leg(21, EUR, bytes32(0), true, 0, false, false);
        venue.setLegs(EUR, eurLegs);
        GTradeVenue.Leg[] memory audLegs = new GTradeVenue.Leg[](2);
        audLegs[0] = GTradeVenue.Leg(21, EUR, bytes32(0), true, 0, false, false);
        audLegs[1] = GTradeVenue.Leg(110, EUR, AUD, false, 0, false, false);
        venue.setLegs(AUD, audLegs);

        usdc.mint(admin, 10_000_000e6);
        usdc.approve(address(venue), type(uint256).max);
        venue.fund(10_000_000e6);

        // Vault-side hedges (registered stand-ins), plus an EUR pool so the capacity cap allows them.
        hedgeBook.grantRole(hedgeBook.REGISTRAR_ROLE(), admin);
        hedgeBook.registerVault(audVault, AUD, IMintableToken(address(audd)));
        hedgeBook.registerVault(eurVault, EUR, IMintableToken(address(eurc)));
        eurc.grantRole(eurc.MINTER_ROLE(), admin);
        eurc.mint(admin, 50_000_000e6);
        eurc.approve(address(hedgeBook), type(uint256).max);
        hedgeBook.lpDeposit(EUR, 50_000_000e6);
    }

    function _runSync(bytes32 ccy) internal {
        vm.prank(keeper);
        assertTrue(mgr.sync(ccy));
        _fulfilAll(ccy);
    }

    /// Plays oracle and keeper: executes every pending order and confirms each leg.
    function _fulfilAll(bytes32 ccy) internal {
        uint256 n = venue.legCount(ccy);
        uint32 firstOrder = gt.nextOrderId() - uint32(n);
        for (uint256 i; i < n; ++i) {
            uint32 idx = gt.fulfil(firstOrder + uint32(i));
            vm.prank(keeper);
            venue.confirm(ccy, i, idx);
        }
    }

    function test_syncOpensEurLeg() public {
        vm.prank(eurVault);
        hedgeBook.adjust(100_000e18); // US$100k short
        _runSync(EUR);
        // 0.012% open fee is taken from collateral, so notional is a hair under target.
        assertApproxEqRel(venue.notionalUsd(EUR), 100_000e18, 0.001e18);
        assertEq(venue.legCount(EUR), 1);
        assertFalse(venue.pending(EUR));
    }

    function test_audUsesTwoLegs() public {
        vm.prank(audVault);
        hedgeBook.adjust(100_000e18);
        _runSync(AUD);
        assertTrue(venue.leg(AUD, 0).open && venue.leg(AUD, 1).open);
        assertApproxEqRel(venue.notionalUsd(AUD), 100_000e18, 0.001e18);
    }

    function test_eurHedgeGainsWhenEurRises() public {
        vm.prank(eurVault);
        hedgeBook.adjust(100_000e18);
        _runSync(EUR);
        int256 e0 = venue.equityUsd(EUR);
        _move(ID_EUR, 1_000); // EUR +10%
        int256 gain = venue.equityUsd(EUR) - e0;
        // Long EUR/USD on ~US$100k: about +US$10k (matches HedgeBook's USD-per-local exposure).
        assertApproxEqRel(uint256(gain), 10_000e18, 0.02e18);
    }

    function test_audTwoLegsTrackAudMove() public {
        vm.prank(audVault);
        hedgeBook.adjust(100_000e18);
        _runSync(AUD);
        int256 e0 = venue.equityUsd(AUD);
        _move(ID_AUD, 1_000); // AUD +10% vs USD, EUR flat
        int256 gain = venue.equityUsd(AUD) - e0;
        // EUR/USD flat; EUR/AUD falls 1/1.1 - 1 = -9.09%, short leg gains about +US$9.1k. Simple
        // returns only approximate the 10% AUD move, which is the documented two-leg basis.
        assertApproxEqRel(uint256(gain), 9_090e18, 0.02e18);
    }

    function test_resizeUpAndDown() public {
        vm.prank(eurVault);
        hedgeBook.adjust(100_000e18);
        _runSync(EUR);
        vm.prank(eurVault);
        hedgeBook.adjust(200_000e18);
        _runSync(EUR); // increase
        assertApproxEqRel(venue.notionalUsd(EUR), 200_000e18, 0.002e18);
        vm.prank(eurVault);
        hedgeBook.adjust(50_000e18);
        _runSync(EUR); // decrease
        assertApproxEqRel(venue.notionalUsd(EUR), 50_000e18, 0.005e18);
    }

    function test_closesWhenHedgeGoesToZero() public {
        vm.prank(eurVault);
        hedgeBook.adjust(100_000e18);
        _runSync(EUR);
        uint256 before = usdc.balanceOf(address(venue));
        vm.prank(eurVault);
        hedgeBook.adjust(0);
        _runSync(EUR);
        assertEq(venue.notionalUsd(EUR), 0);
        assertFalse(venue.leg(EUR, 0).open);
        assertGt(usdc.balanceOf(address(venue)), before); // margin returned
    }

    function test_roundTripCostsAreSmallAndPositive() public {
        uint256 start = usdc.balanceOf(address(venue));
        vm.prank(eurVault);
        hedgeBook.adjust(100_000e18);
        _runSync(EUR);
        vm.prank(eurVault);
        hedgeBook.adjust(0);
        _runSync(EUR);
        uint256 cost = start - usdc.balanceOf(address(venue));
        assertGt(cost, 0); // fees were paid
        assertLt(cost, 50e6); // about 0.024% of US$100k = US$24
    }

    function test_pendingBlocksSync() public {
        vm.prank(eurVault);
        hedgeBook.adjust(100_000e18);
        vm.prank(keeper);
        assertTrue(mgr.sync(EUR));
        assertTrue(venue.pending(EUR));
        vm.prank(eurVault);
        hedgeBook.adjust(300_000e18);
        vm.prank(keeper);
        assertFalse(mgr.sync(EUR)); // waits for the first order to settle
    }

    function test_withinToleranceDoesNothing() public {
        vm.prank(eurVault);
        hedgeBook.adjust(100_000e18);
        _runSync(EUR);
        vm.prank(eurVault);
        hedgeBook.adjust(101_000e18); // 1% drift, tolerance is 3%
        vm.prank(keeper);
        assertFalse(mgr.sync(EUR));
    }

    function test_unsupportedCurrencyIsSkipped() public {
        vm.prank(keeper);
        assertFalse(mgr.sync(INR));
        assertFalse(venue.isSupported(INR));
    }

    function test_onlyKeeperSyncs() public {
        vm.prank(alice);
        vm.expectRevert();
        mgr.sync(EUR);
    }

    function test_statusReportsDrift() public {
        vm.prank(eurVault);
        hedgeBook.adjust(100_000e18);
        HedgeManager.Status memory s = mgr.status(EUR);
        assertEq(s.targetUsd, 100_000e18);
        assertEq(s.venueNotionalUsd, 0);
        assertEq(s.driftBps, 10_000);
        assertTrue(mgr.needsSync(EUR));
    }

    function test_confirmRejectsWrongTrade() public {
        vm.prank(eurVault);
        hedgeBook.adjust(100_000e18);
        vm.prank(keeper);
        mgr.sync(EUR);
        gt.fulfil(gt.nextOrderId() - 1);
        // Leg 0 of AUD expects pair 21 long; a short pair-110 trade must not be accepted as that.
        vm.prank(audVault);
        hedgeBook.adjust(100_000e18);
        vm.prank(keeper);
        mgr.sync(AUD);
        uint32 o1 = gt.nextOrderId() - 2;
        uint32 o2 = gt.nextOrderId() - 1;
        gt.fulfil(o1);
        uint32 shortIdx = gt.fulfil(o2);
        vm.prank(keeper);
        vm.expectRevert(GTradeVenue.BadTrade.selector);
        venue.confirm(AUD, 0, shortIdx);
    }
}
