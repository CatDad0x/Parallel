// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {HedgeBook} from "../src/HedgeBook.sol";
import {IMintableToken} from "../src/interfaces/IMintableToken.sol";

contract HedgeBookTest is BaseTest {
    address fakeVault = makeAddr("fakeVault");

    function setUp() public override {
        super.setUp();
        hedgeBook.grantRole(hedgeBook.REGISTRAR_ROLE(), admin);
        hedgeBook.registerVault(fakeVault, AUD, IMintableToken(address(audd)));
        audd.mint(fakeVault, 1_000_000e6);
        vm.prank(fakeVault);
        audd.approve(address(hedgeBook), type(uint256).max);
    }

    function test_mtmZeroAtEntry() public {
        vm.prank(fakeVault);
        hedgeBook.adjust(65_000e18); // short US$65k
        assertEq(hedgeBook.mtmLocal18(fakeVault), 0);
    }

    function test_audStrengthensHedgeGains() public {
        vm.prank(fakeVault);
        hedgeBook.adjust(65_000e18); // = A$100,000 at 0.65
        _move(ID_AUD, 1_000); // AUD +10% -> 0.715
        // N*(1/K - 1/S) = 100,000 - 90,909.09
        assertApproxEqAbs(hedgeBook.mtmLocal18(fakeVault), 9_090.909090909e18, 1e9);
    }

    function test_audWeakensHedgeLoses() public {
        vm.prank(fakeVault);
        hedgeBook.adjust(65_000e18);
        _move(ID_AUD, -1_000); // 0.585
        assertApproxEqAbs(hedgeBook.mtmLocal18(fakeVault), -11_111.111111111e18, 1e9);
    }

    /// Fuzz: MTM matches the closed form N*(1/K - 1/S).
    function testFuzz_mtmClosedForm(uint96 notional, int16 moveBps) public {
        uint256 n = bound(uint256(notional), 1e18, 1e25); // within pool capacity
        int256 m = bound(int256(moveBps), -5_000, 5_000);
        vm.prank(fakeVault);
        hedgeBook.adjust(n);
        _move(ID_AUD, m);
        (uint256 s,) = oracle.usdPerLocal(AUD);
        int256 expected = int256(n * 1e18 / 0.65e18) - int256(n * 1e18 / s);
        assertApproxEqAbs(hedgeBook.mtmLocal18(fakeVault), expected, 2);
    }

    function test_adjustRealisesGainIntoCash() public {
        vm.prank(fakeVault);
        hedgeBook.adjust(65_000e18);
        _move(ID_AUD, 1_000);
        uint256 before = audd.balanceOf(fakeVault);
        vm.prank(fakeVault);
        int256 realised = hedgeBook.adjust(65_000e18);
        assertGt(realised, 0);
        assertEq(audd.balanceOf(fakeVault), before + uint256(realised));
        assertEq(hedgeBook.mtmLocal18(fakeVault), 0); // re-struck at spot
    }

    function test_adjustBurnsLoss() public {
        vm.prank(fakeVault);
        hedgeBook.adjust(65_000e18);
        _move(ID_AUD, -1_000);
        uint256 before = audd.balanceOf(fakeVault);
        vm.prank(fakeVault);
        int256 realised = hedgeBook.adjust(0);
        assertLt(realised, 0);
        assertEq(audd.balanceOf(fakeVault), before - uint256(-realised));
        assertEq(hedgeBook.notionalOf(fakeVault), 0);
    }

    function test_carryCostAccrues() public {
        hedgeBook.setCarry(AUD, 100); // 1% p.a. cost
        vm.prank(fakeVault);
        hedgeBook.adjust(65_000e18); // A$100k
        vm.warp(block.timestamp + 365 days);
        _setDefaultPrices();
        assertApproxEqAbs(hedgeBook.mtmLocal18(fakeVault), -1_000e18, 1e9);
    }

    function test_onlyRegisteredVault() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HedgeBook.NotRegistered.selector, alice));
        hedgeBook.adjust(1e18);
    }

    // ------------------------------------------------------------------ onchain venue (real pool)

    function test_gainIsPaidFromPoolNotMinted() public {
        vm.prank(fakeVault);
        hedgeBook.adjust(65_000e18);
        _move(ID_AUD, 1_000);
        uint256 supply = audd.totalSupply();
        uint256 poolBefore = hedgeBook.poolBalance(AUD);
        vm.prank(fakeVault);
        int256 realised = hedgeBook.adjust(65_000e18);
        assertGt(realised, 0);
        assertEq(audd.totalSupply(), supply); // nothing minted
        assertEq(hedgeBook.poolBalance(AUD), poolBefore - uint256(realised)); // LPs paid
        assertEq(audd.balanceOf(address(hedgeBook)), hedgeBook.poolBalance(AUD)); // tracked == real
    }

    function test_lossIsPaidIntoPoolNotBurned() public {
        vm.prank(fakeVault);
        hedgeBook.adjust(65_000e18);
        _move(ID_AUD, -1_000);
        uint256 supply = audd.totalSupply();
        uint256 poolBefore = hedgeBook.poolBalance(AUD);
        vm.prank(fakeVault);
        int256 realised = hedgeBook.adjust(65_000e18);
        assertLt(realised, 0);
        assertEq(audd.totalSupply(), supply); // nothing burned
        assertEq(hedgeBook.poolBalance(AUD), poolBefore + uint256(-realised));
    }

    function test_lpEarnsWhenHedgerLoses() public {
        uint256 lpBefore = hedgeBook.lpValueOf(AUD, admin);
        vm.prank(fakeVault);
        hedgeBook.adjust(65_000e18);
        _move(ID_AUD, -1_000);
        vm.prank(fakeVault);
        hedgeBook.adjust(65_000e18);
        assertGt(hedgeBook.lpValueOf(AUD, admin), lpBefore);
    }

    function test_gainHaircutWhenPoolTooSmall() public {
        // Drain the pool down to a sliver (no positions open yet, so no reserve is required).
        uint256 sh = hedgeBook.lpShares(AUD, admin);
        hedgeBook.lpWithdraw(AUD, sh - 1_000e6);
        vm.prank(fakeVault);
        hedgeBook.adjust(65_000e18);
        _move(ID_AUD, 5_000); // +50%: gain far above the pool
        uint256 pool = hedgeBook.poolBalance(AUD);
        vm.prank(fakeVault);
        int256 realised = hedgeBook.adjust(0);
        assertEq(uint256(realised), pool); // paid what the pool had, no more
        assertEq(hedgeBook.poolBalance(AUD), 0);
    }

    function test_notionalClampedToPoolCapacity() public {
        // Pool is A$50m, so capacity is 5x = A$250m = US$162.5m at 0.65.
        vm.prank(fakeVault);
        hedgeBook.adjust(1_000_000_000e18); // ask for US$1bn
        uint256 granted = hedgeBook.notionalOf(fakeVault);
        assertApproxEqRel(granted, 162_500_000e18, 0.001e18);
        assertLt(granted, 1_000_000_000e18);
    }

    function test_lpCannotWithdrawBelowReserve() public {
        vm.prank(fakeVault);
        hedgeBook.adjust(65_000_000e18); // A$100m open interest -> reserve A$20m
        uint256 sh = hedgeBook.lpShares(AUD, admin);
        vm.expectRevert(HedgeBook.ReserveBreached.selector);
        hedgeBook.lpWithdraw(AUD, sh - 100e6); // would leave ~nothing
        hedgeBook.lpWithdraw(AUD, sh / 4); // leaves A$37.5m, above reserve
    }

    function test_lpDepositAndWithdrawRoundTrip() public {
        audd.mint(alice, 10_000e6);
        vm.startPrank(alice);
        audd.approve(address(hedgeBook), type(uint256).max);
        uint256 sh = hedgeBook.lpDeposit(AUD, 10_000e6);
        assertApproxEqAbs(hedgeBook.lpValueOf(AUD, alice), 10_000e6, 1);
        hedgeBook.lpWithdraw(AUD, sh);
        vm.stopPrank();
        assertApproxEqAbs(audd.balanceOf(alice), 1_010_000e6, 1);
    }

    function test_poolAssetMismatchReverts() public {
        vm.expectRevert(HedgeBook.AssetMismatch.selector);
        hedgeBook.registerVault(makeAddr("v2"), AUD, IMintableToken(address(audm)));
    }
}
