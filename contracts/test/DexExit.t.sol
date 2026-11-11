// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {OracleHub} from "../src/OracleHub.sol";
import {SimExchange} from "../src/SimExchange.sol";

/// v0.4: DEX-priced 24/7 exits, index-priced NAV, and the deviation guard levels.
contract DexExitTest is BaseTest {
    uint256 constant DEP = 10_000e6;

    function test_sellsWorkWhileMarketClosedButBuysDoNot() public {
        vm.prank(alice);
        uint256 q = exchange.buyEquity(address(audd), address(spy), 1_000e6, 0, alice);
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_CLOSED);
        vm.startPrank(alice);
        assertGt(exchange.sellEquity(address(spy), address(audd), q, 0, alice), 0);
        vm.expectRevert(SimExchange.MarketClosed.selector);
        exchange.buyEquity(address(audd), address(spy), 1e6, 0, alice);
        vm.stopPrank();
    }

    function test_driftMovesExecutionPriceOnly() public {
        uint256 sell0 = exchange.quoteSell(address(spy), address(audd), 1e18);
        uint256 buy0 = exchange.quoteBuy(address(audd), address(spy), 1_000e6);
        vm.prank(admin);
        exchange.setDrift(-200); // DEX 2% below index
        (uint256 idx,) = oracle.equityPriceUsd(address(spy));
        assertEq(idx, 600e18, "index price untouched");
        assertApproxEqRel(exchange.quoteSell(address(spy), address(audd), 1e18), sell0 * 98 / 100, 0.0001e18);
        assertGt(exchange.quoteBuy(address(audd), address(spy), 1_000e6), buy0, "cheaper DEX gives more per AUD");
    }

    function test_deviationLevelsAreFixedThresholds() public {
        vm.startPrank(admin);
        exchange.setDrift(-99);
        assertEq(exchange.deviationLevel(), 0);
        exchange.setDrift(-100);
        assertEq(exchange.deviationLevel(), 1);
        exchange.setDrift(-299);
        assertEq(exchange.deviationLevel(), 1);
        exchange.setDrift(-300);
        assertEq(exchange.deviationLevel(), 2);
        exchange.setDrift(-999);
        assertEq(exchange.deviationLevel(), 2);
        exchange.setDrift(-1_000);
        assertEq(exchange.deviationLevel(), 3);
        exchange.setDrift(500); // premium is not a "discount": no warning
        assertEq(exchange.deviationLevel(), 0);
        vm.expectRevert("drift too large");
        exchange.setDrift(-5_001);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert();
        exchange.setDrift(-100);
    }

    function test_navAndIndexValueIgnoreDrift_redeemerBearsGap() public {
        _deposit(audHedgedIndex, alice, DEP);
        uint256 shares = audHedgedIndex.balanceOf(alice);
        uint256 nav0 = audHedgedIndex.totalAssets();
        uint256 idx0 = audHedgedIndex.previewRedeemAtIndex(shares);
        uint256 dex0 = audHedgedIndex.previewRedeem(shares);

        vm.prank(admin);
        exchange.setDrift(-500); // DEX 5% below index
        assertEq(audHedgedIndex.totalAssets(), nav0, "NAV must use the index price");
        assertEq(audHedgedIndex.previewRedeemAtIndex(shares), idx0, "collateral value must use the index price");
        uint256 dex1 = audHedgedIndex.previewRedeem(shares);
        assertLt(dex1, dex0);
        // ~5% of the equity sleeve (97% of NAV) comes off the payout
        assertApproxEqRel(dex0 - dex1, nav0 * 97 / 100 * 5 / 100, 0.02e18);

        (uint256 atDex, uint256 atIndex, uint256 gap, uint8 level) = audHedgedIndex.redeemQuote(shares);
        assertEq(atDex, dex1);
        assertEq(atIndex, idx0);
        assertApproxEqRel(gap, 485, 0.05e18); // about 4.85%
        assertEq(level, 2);
    }

    function test_redeemWorksWhileClosed_previewMatchesExecution() public {
        _deposit(audHedgedIndex, alice, DEP);
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_CLOSED);
        vm.prank(admin);
        exchange.setDrift(-250);

        uint256 shares = audHedgedIndex.balanceOf(alice);
        assertEq(audHedgedIndex.maxRedeem(alice), shares);
        uint256 expected = audHedgedIndex.previewRedeem(shares);
        uint256 bal0 = audd.balanceOf(alice);
        vm.prank(alice);
        uint256 got = audHedgedIndex.redeem(shares, alice, alice);
        assertEq(got, expected, "preview must equal execution");
        assertEq(audd.balanceOf(alice) - bal0, expected);
    }

    function test_remainingHoldersNotHurtByDiscountedExit() public {
        _deposit(audHedgedIndex, alice, DEP);
        _deposit(audHedgedIndex, bob, DEP);
        uint256 aliceValue0 = _assetValue(audHedgedIndex, alice);

        vm.prank(admin);
        exchange.setDrift(-800); // thin pool, 8% below
        uint256 bobShares = audHedgedIndex.balanceOf(bob);
        vm.prank(bob);
        audHedgedIndex.redeem(bobShares, bob, bob);

        assertGe(_assetValue(audHedgedIndex, alice) + 2, aliceValue0, "bob's discount must not be paid by alice");
    }

    function test_largeDiscountRedeemStillFundedWithBufferShortfall() public {
        _deposit(audHedgedIndex, alice, DEP);
        vm.prank(admin);
        exchange.setDrift(-3_000); // extreme: 30% below
        uint256 shares = audHedgedIndex.balanceOf(alice);
        uint256 expected = audHedgedIndex.previewRedeem(shares);
        vm.prank(alice);
        assertEq(audHedgedIndex.redeem(shares, alice, alice), expected);
        assertLt(expected, DEP * 75 / 100);
    }

    function test_partialRedeemUnderDiscountMatchesPreview() public {
        _deposit(audHedgedIndex, alice, DEP);
        vm.prank(admin);
        exchange.setDrift(-400);
        uint256 shares = audHedgedIndex.balanceOf(alice) / 3;
        uint256 expected = audHedgedIndex.previewRedeem(shares);
        vm.prank(alice);
        assertEq(audHedgedIndex.redeem(shares, alice, alice), expected);
    }

    function test_premiumDriftChargesDepositorNotHolders() public {
        _deposit(audHedgedIndex, bob, DEP);
        uint256 bobValue0 = _assetValue(audHedgedIndex, bob);
        vm.prank(admin);
        exchange.setDrift(300); // DEX 3% above index: buying costs more
        uint256 expected = audHedgedIndex.previewDeposit(DEP);
        assertEq(_deposit(audHedgedIndex, alice, DEP), expected, "deposit preview must match");
        assertGe(_assetValue(audHedgedIndex, bob) + 2, bobValue0, "existing holder not diluted by a pricier DEX");
    }

    function test_queuedRedeemWaitsAndRespectsMinAssets() public {
        _deposit(audHedgedIndex, alice, DEP);
        uint256 shares = audHedgedIndex.balanceOf(alice);
        uint256 limit = audHedgedIndex.previewRedeem(shares);

        vm.prank(admin);
        exchange.setDrift(-200);
        // user chooses to wait; limit was set at the undiscounted quote
        vm.prank(alice);
        audHedgedIndex.requestRedeem(shares, alice, limit);
        vm.prank(keeper);
        audHedgedIndex.processQueue(10);
        assertEq(audHedgedIndex.balanceOf(alice), shares, "refunded while the gap persists");

        vm.prank(admin);
        exchange.setDrift(0);
        vm.prank(alice);
        audHedgedIndex.requestRedeem(shares, alice, limit);
        uint256 bal0 = audd.balanceOf(alice);
        vm.prank(keeper);
        audHedgedIndex.processQueue(10);
        assertApproxEqRel(audd.balanceOf(alice) - bal0, limit, 0.0001e18);
    }
}
