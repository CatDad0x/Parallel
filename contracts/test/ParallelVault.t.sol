// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {ParallelVault} from "../src/ParallelVault.sol";
import {OracleHub} from "../src/OracleHub.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ParallelVaultTest is BaseTest {
    uint256 constant DEP = 10_000e6; // A$10,000

    // ------------------------------------------------------------------ basics

    function test_depositInvestsAndHedges() public {
        uint256 shares = _deposit(audHedgedIndex, alice, DEP);
        assertGt(shares, 0);
        assertEq(audHedgedIndex.decimals(), 18);

        // ~97% invested, ~3% cash
        uint256 eq = audHedgedIndex.equityValue();
        uint256 c = audHedgedIndex.cash();
        assertApproxEqRel(c, DEP * 300 / 10_000, 0.001e18);
        assertApproxEqRel(eq, DEP * 9_700 / 10_000, 0.002e18); // minus spread

        // hedge notional == equity USD value
        assertEq(hedgeBook.notionalOf(address(audHedgedIndex)), audHedgedIndex.equityValueUsd());

        // depositor pays the entry cost; NAV per user ~ deposit - cost
        uint256 cost = DEP * 97 / 100_000; // 10 bps spread on the 97% invested
        assertApproxEqRel(_assetValue(audHedgedIndex, alice), DEP - cost, 0.0005e18);
    }

    function test_unhedgedHasNoHedge() public {
        _deposit(audUnhedgedIndex, alice, DEP);
        assertEq(hedgeBook.notionalOf(address(audUnhedgedIndex)), 0);
        assertEq(audUnhedgedIndex.hedgeMtm(), 0);
    }

    // ------------------------------------------------------------------ headline scenarios

    /// AUD +10%, S&P flat: hedged vault holds value (within 0.5%), unhedged loses ~9.09%.
    function test_scenario_audUp10_equitiesFlat() public {
        _deposit(audHedgedIndex, alice, DEP);
        _deposit(audUnhedgedIndex, bob, DEP);
        uint256 h0 = _assetValue(audHedgedIndex, alice);
        uint256 u0 = _assetValue(audUnhedgedIndex, bob);

        _move(ID_AUD, 1_000);

        uint256 h1 = _assetValue(audHedgedIndex, alice);
        uint256 u1 = _assetValue(audUnhedgedIndex, bob);

        assertApproxEqRel(h1, h0, 0.005e18, "hedged should hold value");
        // unhedged: 97% equities lose 1/1.1, 3% cash unaffected -> -8.82%
        uint256 expectedU = u0 - (u0 * 9_700 / 10_000) * 909_091 / 10_000_000;
        assertApproxEqRel(u1, expectedU, 0.002e18, "unhedged loses ~9.09% on equity sleeve");
    }

    /// Fully invested sleeve: unhedged equity value in AUD falls exactly 1/1.1.
    function test_scenario_unhedgedEquitySleeveLoses9_09pct() public {
        _deposit(audUnhedgedIndex, bob, DEP);
        uint256 e0 = audUnhedgedIndex.equityValue();
        _move(ID_AUD, 1_000);
        uint256 e1 = audUnhedgedIndex.equityValue();
        assertApproxEqRel(e1, e0 * 10_000 / 11_000, 0.0001e18);
    }

    /// AUD +10% and S&P +10%. With a static hedge the result is ~+9.1% (not +10%);
    /// after a keeper rebalance mid-move the hedge tracks the larger portfolio.
    function test_scenario_audUp10_equitiesUp10_staticVsRebalanced() public {
        _deposit(audHedgedIndex, alice, DEP);
        uint256 v0 = _assetValue(audHedgedIndex, alice);

        // static: both move at once, no rebalance
        _move(ID_SPY, 1_000);
        _move(ID_AUD, 1_000);
        uint256 vStatic = _assetValue(audHedgedIndex, alice);
        // equity sleeve 0.97 * (1.1/1.1 - 1) = 0; hedge +9.09% of 0.97 -> ~+8.8% total
        assertApproxEqRel(vStatic, v0 * 10_882 / 10_000, 0.003e18);
    }

    function test_scenario_rebalancedHedgeTracksEquityGains() public {
        _deposit(audHedgedIndex, alice, DEP);
        uint256 v0 = _assetValue(audHedgedIndex, alice);

        _move(ID_SPY, 1_000); // equities up first
        vm.prank(keeper);
        audHedgedIndex.rebalance(); // hedge drift 10% > 3% -> resize
        assertApproxEqRel(hedgeBook.notionalOf(address(audHedgedIndex)), audHedgedIndex.equityValueUsd(), 0.0001e18);

        _move(ID_AUD, 1_000); // then AUD up
        uint256 v1 = _assetValue(audHedgedIndex, alice);
        // ~+9.7% (equity sleeve +10%, FX neutralised, cash flat)
        assertApproxEqRel(v1, v0 * 10_970 / 10_000, 0.003e18);
    }

    /// AUD -10%: unhedged investor gains from the weaker AUD, hedged gives that up.
    function test_scenario_audDown10() public {
        _deposit(audHedgedIndex, alice, DEP);
        _deposit(audUnhedgedIndex, bob, DEP);
        uint256 h0 = _assetValue(audHedgedIndex, alice);
        uint256 u0 = _assetValue(audUnhedgedIndex, bob);
        _move(ID_AUD, -1_000);
        assertApproxEqRel(_assetValue(audHedgedIndex, alice), h0, 0.005e18);
        assertGt(_assetValue(audUnhedgedIndex, bob), u0 * 110 / 100);
    }

    // ------------------------------------------------------------------ costs and fairness

    function test_roundTripCostsOnlySpread() public {
        _deposit(audHedgedIndex, alice, DEP);
        uint256 back = _redeemAll(audHedgedIndex, alice);
        // 2 x 9.7 bps
        assertApproxEqRel(back, DEP * (100_000 - 194) / 100_000, 0.00005e18);
        assertEq(audHedgedIndex.balanceOf(alice), 0);
    }

    function test_existingHolderNotDilutedByFlows() public {
        _deposit(audHedgedIndex, alice, DEP);
        uint256 a0 = _assetValue(audHedgedIndex, alice);

        _deposit(audHedgedIndex, bob, 250_000e6);
        _redeemAll(audHedgedIndex, bob);

        // alice is not hurt by bob's trading costs (she may gain a dust amount from rounding)
        assertGe(_assetValue(audHedgedIndex, alice), a0 - 1);
    }

    function test_managementFeeAccrues() public {
        _deposit(audHedgedIndex, alice, DEP);
        uint256 supply0 = audHedgedIndex.totalSupply();
        vm.warp(block.timestamp + 365 days);
        _setDefaultPrices();
        audHedgedIndex.poke();
        assertApproxEqRel(audHedgedIndex.balanceOf(treasury), supply0 * 50 / 10_000, 0.001e18);
    }

    // ------------------------------------------------------------------ hedge mechanics

    function test_hedgeLossRealisedWithoutBreakingRedemptions() public {
        _deposit(audHedgedIndex, alice, DEP);
        _move(ID_AUD, -3_000); // AUD -30%: hedge loss far exceeds the 3% cash buffer
        assertLt(audHedgedIndex.hedgeMtm(), 0);
        uint256 expected = audHedgedIndex.previewRedeem(audHedgedIndex.balanceOf(alice));
        uint256 back = _redeemAll(audHedgedIndex, alice);
        assertEq(back, expected);
        assertApproxEqRel(back, DEP, 0.01e18); // hedged: value roughly preserved
    }

    function test_rollHedgeRealisesPnl() public {
        _deposit(audHedgedIndex, alice, DEP);
        _move(ID_AUD, 1_000);
        int256 m = audHedgedIndex.hedgeMtm();
        uint256 cash0 = audHedgedIndex.cash();
        uint256 nav0 = audHedgedIndex.totalAssets();
        vm.prank(keeper);
        audHedgedIndex.rollHedge();
        assertEq(audHedgedIndex.hedgeMtm(), 0);
        assertApproxEqAbs(audHedgedIndex.cash(), cash0 + uint256(m), 1);
        assertApproxEqAbs(audHedgedIndex.totalAssets(), nav0, 2);
    }

    function test_rebalanceRestoresCashBuffer() public {
        _deposit(audHedgedIndex, alice, DEP);
        _move(ID_AUD, 1_000);
        vm.prank(keeper);
        audHedgedIndex.rollHedge(); // hedge gain lands in cash -> cash well above 3%
        assertGt(audHedgedIndex.cash(), audHedgedIndex.totalAssets() * 400 / 10_000);
        vm.prank(keeper);
        audHedgedIndex.rebalance();
        assertApproxEqRel(audHedgedIndex.cash(), audHedgedIndex.totalAssets() * 300 / 10_000, 0.01e18);
    }

    // ------------------------------------------------------------------ basket

    function test_basketSplitsByWeight() public {
        _deposit(audHedgedBasket, alice, DEP);
        address[] memory eq = audHedgedBasket.equities();
        uint256 total = audHedgedBasket.equityValueUsd();
        for (uint256 i; i < eq.length; ++i) {
            (uint256 px,) = oracle.equityPriceUsd(eq[i]);
            uint256 v = IERC20(eq[i]).balanceOf(address(audHedgedBasket)) * px / 1e18;
            assertApproxEqRel(v, total / 5, 0.0001e18);
        }
    }

    function test_basketRebalanceRestoresWeights() public {
        _deposit(audHedgedBasket, alice, DEP);
        _move(ID_NVDA, 5_000); // NVDA +50% -> ~27% weight
        vm.prank(keeper);
        audHedgedBasket.rebalance();

        address[] memory eq = audHedgedBasket.equities();
        uint256 total = audHedgedBasket.equityValueUsd();
        for (uint256 i; i < eq.length; ++i) {
            (uint256 px,) = oracle.equityPriceUsd(eq[i]);
            uint256 v = IERC20(eq[i]).balanceOf(address(audHedgedBasket)) * px / 1e18;
            assertApproxEqRel(v, total / 5, 0.01e18);
        }
    }

    // ------------------------------------------------------------------ market closed queue

    function test_closedMarketBlocksInstantFlows() public {
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_CLOSED);
        vm.startPrank(alice);
        audd.approve(address(audHedgedIndex), DEP);
        vm.expectRevert(ParallelVault.MarketClosed.selector);
        audHedgedIndex.deposit(DEP, alice);
        vm.stopPrank();
        assertEq(audHedgedIndex.maxDeposit(alice), 0);
    }

    function test_queuedDepositSettlesAtNextOpen() public {
        _deposit(audHedgedIndex, bob, DEP); // existing holder
        uint256 navBefore = audHedgedIndex.totalAssets();

        oracle.setMarketMode(OracleHub.MarketMode.FORCE_CLOSED);
        vm.startPrank(alice);
        audd.approve(address(audHedgedIndex), DEP);
        audHedgedIndex.requestDeposit(DEP, alice, 0);
        vm.stopPrank();

        // escrow does not inflate NAV
        assertEq(audHedgedIndex.totalAssets(), navBefore);
        assertEq(audHedgedIndex.balanceOf(alice), 0);
        (uint256 d,) = audHedgedIndex.queueLengths();
        assertEq(d, 1);

        // keeper cannot settle while closed
        vm.prank(keeper);
        vm.expectRevert(ParallelVault.MarketClosed.selector);
        audHedgedIndex.processQueue(10);

        oracle.setMarketMode(OracleHub.MarketMode.FORCE_OPEN);
        vm.prank(keeper);
        audHedgedIndex.processQueue(10);

        assertGt(audHedgedIndex.balanceOf(alice), 0);
        assertEq(audHedgedIndex.pendingDepositAssets(), 0);
        uint256 cost = DEP * 97 / 100_000; // 10 bps spread on the 97% invested
        assertApproxEqRel(_assetValue(audHedgedIndex, alice), DEP - cost, 0.0005e18);
    }

    function test_queuedRedeemSettlesAtNextOpen() public {
        _deposit(audHedgedIndex, alice, DEP);
        uint256 shares = audHedgedIndex.balanceOf(alice);

        oracle.setMarketMode(OracleHub.MarketMode.FORCE_CLOSED);
        vm.prank(alice);
        audHedgedIndex.requestRedeem(shares, alice, 0);
        assertEq(audHedgedIndex.balanceOf(alice), 0);

        oracle.setMarketMode(OracleHub.MarketMode.FORCE_OPEN);
        _setDefaultPrices();
        uint256 bal0 = audd.balanceOf(alice);
        vm.prank(keeper);
        audHedgedIndex.processQueue(10);
        assertApproxEqRel(audd.balanceOf(alice) - bal0, DEP * (100_000 - 194) / 100_000, 0.00005e18);
        assertEq(audHedgedIndex.pendingRedeemShares(), 0);
    }

    function test_cancelQueuedDeposit() public {
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_CLOSED);
        uint256 bal0 = audd.balanceOf(alice);
        vm.startPrank(alice);
        audd.approve(address(audHedgedIndex), DEP);
        uint256 id = audHedgedIndex.requestDeposit(DEP, alice, 0);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(ParallelVault.NotRequestOwner.selector);
        audHedgedIndex.cancelDeposit(id);

        vm.prank(alice);
        audHedgedIndex.cancelDeposit(id);
        assertEq(audd.balanceOf(alice), bal0);
        assertEq(audHedgedIndex.pendingDepositAssets(), 0);

        vm.prank(alice);
        vm.expectRevert(ParallelVault.RequestClosed.selector);
        audHedgedIndex.cancelDeposit(id);

        // keeper skips the cancelled slot
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_OPEN);
        vm.prank(keeper);
        audHedgedIndex.processQueue(10);
        assertEq(audHedgedIndex.balanceOf(alice), 0);
    }

    function test_cancelQueuedRedeem() public {
        _deposit(audHedgedIndex, alice, DEP);
        uint256 shares = audHedgedIndex.balanceOf(alice);
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_CLOSED);
        vm.startPrank(alice);
        uint256 id = audHedgedIndex.requestRedeem(shares, alice, 0);
        audHedgedIndex.cancelRedeem(id);
        vm.stopPrank();
        assertEq(audHedgedIndex.balanceOf(alice), shares);
        assertEq(audHedgedIndex.pendingRedeemShares(), 0);
    }

    function test_queuedDepositRefundedWhenLimitMissed() public {
        _deposit(audHedgedIndex, bob, DEP);
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_CLOSED);
        uint256 expected = audHedgedIndex.previewDeposit(DEP);
        uint256 bal0 = audd.balanceOf(alice);
        vm.startPrank(alice);
        audd.approve(address(audHedgedIndex), DEP);
        audHedgedIndex.requestDeposit(DEP, alice, expected);
        vm.stopPrank();

        // S&P rallies over the weekend -> fewer shares per AUD -> limit missed -> refund
        _move(ID_SPY, 1_000);
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_OPEN);
        vm.prank(keeper);
        audHedgedIndex.processQueue(10);
        assertEq(audHedgedIndex.balanceOf(alice), 0);
        assertEq(audd.balanceOf(alice), bal0);
        assertEq(audHedgedIndex.pendingDepositAssets(), 0);
    }

    function test_queuedRedeemRefundedWhenLimitMissed() public {
        _deposit(audHedgedIndex, alice, DEP);
        uint256 shares = audHedgedIndex.balanceOf(alice);
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_CLOSED);
        uint256 limit = audHedgedIndex.previewRedeem(shares);
        vm.prank(alice);
        audHedgedIndex.requestRedeem(shares, alice, limit);

        _move(ID_SPY, -1_000);
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_OPEN);
        vm.prank(keeper);
        audHedgedIndex.processQueue(10);
        assertEq(audHedgedIndex.balanceOf(alice), shares); // shares returned
    }

    function test_previewsIncludePendingFees() public {
        _deposit(audHedgedIndex, alice, DEP);
        vm.warp(block.timestamp + 180 days);
        _setDefaultPrices();
        assertGt(audHedgedIndex.pendingFeeShares(), 0);

        uint256 shares = audHedgedIndex.balanceOf(alice);
        uint256 expectedOut = audHedgedIndex.previewRedeem(shares);
        uint256 out = _redeemAll(audHedgedIndex, alice);
        assertEq(out, expectedOut, "redeem preview must match execution after fee accrual");

        uint256 expectedShares = audHedgedIndex.previewDeposit(DEP);
        assertEq(_deposit(audHedgedIndex, bob, DEP), expectedShares);
    }

    function test_requestRevertsWhenOpen() public {
        vm.prank(alice);
        vm.expectRevert(ParallelVault.MarketOpenUseInstant.selector);
        audHedgedIndex.requestDeposit(DEP, alice, 0);
    }

    // ------------------------------------------------------------------ access + unsupported paths

    function test_onlyKeeperRebalances() public {
        vm.prank(alice);
        vm.expectRevert();
        audHedgedIndex.rebalance();
    }

    function test_mintAndWithdrawUnsupported() public {
        vm.expectRevert(ParallelVault.Unsupported.selector);
        audHedgedIndex.mint(1, alice);
        vm.expectRevert(ParallelVault.Unsupported.selector);
        audHedgedIndex.withdraw(1, alice, alice);
        assertEq(audHedgedIndex.maxMint(alice), 0);
    }

    function test_redeemOnBehalfNeedsAllowance() public {
        _deposit(audHedgedIndex, alice, DEP);
        uint256 s = audHedgedIndex.balanceOf(alice);
        vm.prank(bob);
        vm.expectRevert();
        audHedgedIndex.redeem(s, bob, alice);
    }

    // ------------------------------------------------------------------ donations

    function test_donationDoesNotMoveSharePrice() public {
        _deposit(audHedgedIndex, alice, DEP);
        uint256 nav0 = audHedgedIndex.navPerShare();
        audd.mint(address(audHedgedIndex), 1_000_000e6); // stray stable
        spy.grantRole(spy.MINTER_ROLE(), admin);
        spy.mint(address(audHedgedIndex), 100e18); // stray equity
        assertEq(audHedgedIndex.navPerShare(), nav0);

        uint256 t0 = audd.balanceOf(treasury);
        audHedgedIndex.skim(address(audd));
        audHedgedIndex.skim(address(spy));
        assertEq(audd.balanceOf(treasury) - t0, 1_000_000e6);
        assertEq(spy.balanceOf(treasury), 100e18);
        assertEq(audHedgedIndex.navPerShare(), nav0);
    }

    function test_skimKeepsQueuedEscrow() public {
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_CLOSED);
        vm.startPrank(alice);
        audd.approve(address(audHedgedIndex), DEP);
        audHedgedIndex.requestDeposit(DEP, alice, 0);
        vm.stopPrank();
        audHedgedIndex.skim(address(audd));
        assertEq(audd.balanceOf(address(audHedgedIndex)), DEP);
    }

    // ------------------------------------------------------------------ fuzz

    /// NAV equals equities (mid, in AUD) + cash + hedge MTM after arbitrary price moves.
    function testFuzz_navIdentity(uint64 amount, int16 spyBps, int16 audBps) public {
        uint256 dep = bound(uint256(amount), 10e6, 500_000e6);
        _deposit(audHedgedIndex, alice, dep);
        _move(ID_SPY, bound(int256(spyBps), -5_000, 5_000));
        _move(ID_AUD, bound(int256(audBps), -3_000, 3_000));

        (uint256 spx,) = oracle.equityPriceUsd(address(spy));
        (uint256 fx,) = oracle.usdPerLocal(AUD);
        uint256 eqLocal = spy.balanceOf(address(audHedgedIndex)) * spx / 1e18 * 1e18 / fx / 1e12;
        int256 expected = int256(eqLocal) + int256(audHedgedIndex.cash()) + hedgeBook.mtmAssets(address(audHedgedIndex));
        assertApproxEqAbs(int256(audHedgedIndex.totalAssets()), expected, 2);
    }

    /// Hedged vault value is insensitive to FX moves when equities are flat.
    function testFuzz_hedgeNeutralisesFx(uint64 amount, int16 audBps) public {
        uint256 dep = bound(uint256(amount), 100e6, 500_000e6);
        _deposit(audHedgedIndex, alice, dep);
        uint256 v0 = _assetValue(audHedgedIndex, alice);
        _move(ID_AUD, bound(int256(audBps), -2_500, 2_500));
        assertApproxEqRel(_assetValue(audHedgedIndex, alice), v0, 0.001e18);
    }

    /// After arbitrary equity + FX moves, every holder can fully exit and the vault stays solvent.
    function testFuzz_everyoneCanExit(uint64 a, uint64 b, int16 spyBps, int16 audBps, bool hedgedVault) public {
        ParallelVault v = hedgedVault ? audHedgedIndex : audUnhedgedIndex;
        _deposit(v, alice, bound(uint256(a), 1e6, 500_000e6));
        _deposit(v, bob, bound(uint256(b), 1e6, 500_000e6));
        _move(ID_SPY, bound(int256(spyBps), -6_000, 6_000));
        _move(ID_AUD, bound(int256(audBps), -3_500, 3_500));

        uint256 expA = v.previewRedeem(v.balanceOf(alice));
        assertEq(_redeemAll(v, alice), expA);
        uint256 expB = v.previewRedeem(v.balanceOf(bob));
        assertEq(_redeemAll(v, bob), expB);
        assertEq(v.totalSupply(), 0);
    }

    /// Deposit/redeem round trip never returns more than was put in.
    function testFuzz_noFreeLunch(uint64 amount) public {
        uint256 dep = bound(uint256(amount), 1e6, 500_000e6);
        _deposit(audHedgedIndex, bob, 50_000e6);
        uint256 bal0 = audd.balanceOf(alice);
        _deposit(audHedgedIndex, alice, dep);
        _redeemAll(audHedgedIndex, alice);
        assertLe(audd.balanceOf(alice), bal0);
    }
}
