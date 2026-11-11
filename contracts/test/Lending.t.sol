// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";

import {ParallelRouter} from "../src/ParallelRouter.sol";
import {ParallelVault} from "../src/ParallelVault.sol";
import {OracleHub} from "../src/OracleHub.sol";
import {KinkedIrm} from "../src/lending/KinkedIrm.sol";
import {EquityOracleAdapter, VaultShareOracleAdapter, IParallelVaultView} from "../src/lending/OracleAdapters.sol";
import {IOracleHub} from "../src/interfaces/IOracleHub.sol";

contract LendingTest is BaseTest {
    using MarketParamsLib for MarketParams;

    uint256 constant LLTV_EQ = 0.625e18;
    uint256 constant LLTV_HEDGED = 0.77e18;
    uint256 constant OPEN_EQ = 0.45e18;
    uint256 constant OPEN_HEDGED = 0.55e18;

    IMorpho morpho;
    KinkedIrm irm;
    ParallelRouter router;
    MarketParams spyMarket;
    MarketParams hedgedMarket;
    MarketParams unhedgedMarket;
    address liquidator = makeAddr("liquidator");

    function setUp() public override {
        super.setUp();
        morpho = IMorpho(deployCode("out/Morpho.sol/Morpho.json", abi.encode(admin)));
        irm = new KinkedIrm(0.02e18, 0.08e18, 0.6e18, 0.8e18);
        morpho.enableIrm(address(irm));
        morpho.enableLltv(LLTV_EQ);
        morpho.enableLltv(LLTV_HEDGED);

        router = new ParallelRouter(morpho, exchange, IOracleHub(address(oracle)), admin);

        spyMarket = MarketParams({
            loanToken: address(audd),
            collateralToken: address(spy),
            oracle: address(new EquityOracleAdapter(IOracleHub(address(oracle)), address(spy), AUD, address(audd))),
            irm: address(irm),
            lltv: LLTV_EQ
        });
        hedgedMarket = MarketParams({
            loanToken: address(audd),
            collateralToken: address(audHedgedIndex),
            oracle: address(new VaultShareOracleAdapter(IParallelVaultView(address(audHedgedIndex)))),
            irm: address(irm),
            lltv: LLTV_HEDGED
        });
        unhedgedMarket = MarketParams({
            loanToken: address(audd),
            collateralToken: address(audUnhedgedIndex),
            oracle: address(new VaultShareOracleAdapter(IParallelVaultView(address(audUnhedgedIndex)))),
            irm: address(irm),
            lltv: LLTV_EQ
        });
        MarketParams[3] memory mps = [spyMarket, hedgedMarket, unhedgedMarket];
        for (uint256 i; i < 3; ++i) {
            morpho.createMarket(mps[i]);
        }
        router.setMaxOpenLtv(spyMarket, OPEN_EQ);
        router.setMaxOpenLtv(hedgedMarket, OPEN_HEDGED);
        router.setMaxOpenLtv(unhedgedMarket, OPEN_EQ);

        // lender liquidity
        address lender = makeAddr("lender");
        audd.mint(lender, 3_000_000e6);
        vm.startPrank(lender);
        audd.approve(address(morpho), type(uint256).max);
        for (uint256 i; i < 3; ++i) {
            morpho.supply(mps[i], 1_000_000e6, 0, lender, "");
        }
        vm.stopPrank();

        // liquidator inventory
        audd.mint(liquidator, 1_000_000e6);

        vm.prank(alice);
        morpho.setAuthorization(address(router), true);
    }

    // ------------------------------------------------------------------ oracle adapters

    function test_equityAdapterScaling() public view {
        // 1 SPY = $600 = A$923.0769...; Morpho price = A$/SPY * 10^(36 + 6 - 18)
        uint256 p = EquityOracleAdapter(spyMarket.oracle).price();
        assertApproxEqRel(p, uint256(600e18) * 1e18 / 0.65e18 * 1e6, 1e6);
        // 1 whole SPY (1e18 units) is worth ~923.08e6 AUDD units
        assertApproxEqAbs(1e18 * p / 1e36, 923_076_923, 1);
    }

    function test_vaultAdapterIsRealisableValue() public {
        _deposit(audHedgedIndex, alice, 10_000e6);
        uint256 p = VaultShareOracleAdapter(hedgedMarket.oracle).price();
        assertEq(p, audHedgedIndex.previewRedeem(1e18) * 1e18);
        assertLt(audHedgedIndex.previewRedeem(1e18), audHedgedIndex.navPerShare()); // net of exit cost
    }

    function test_donationDoesNotMoveVaultOracle() public {
        _deposit(audHedgedIndex, alice, 10_000e6);
        uint256 p0 = VaultShareOracleAdapter(hedgedMarket.oracle).price();
        audd.mint(address(audHedgedIndex), 5_000_000e6);
        assertEq(VaultShareOracleAdapter(hedgedMarket.oracle).price(), p0);
    }

    // ------------------------------------------------------------------ router borrow controls

    function test_depositToVaultAndBorrow() public {
        uint256 bal0 = audd.balanceOf(alice);
        vm.startPrank(alice);
        audd.approve(address(router), 10_000e6);
        router.depositToVaultAndBorrow(audHedgedIndex, address(audd), 10_000e6, 0, hedgedMarket, 5_000e6);
        vm.stopPrank();

        Position memory p = morpho.position(hedgedMarket.id(), alice);
        assertGt(p.collateral, 0);
        assertEq(audd.balanceOf(alice), bal0 - 10_000e6 + 5_000e6);
        assertApproxEqRel(router.ltvOf(hedgedMarket, alice), 0.501e18, 0.01e18);
        assertGt(router.healthFactor(hedgedMarket, alice), 1.5e18);
    }

    function test_depositWithOtherAudStable() public {
        audm.grantRole(audm.MINTER_ROLE(), admin);
        audm.mint(alice, 5_000e6);
        vm.startPrank(alice);
        audm.approve(address(router), 5_000e6);
        uint256 shares = router.depositWith(audHedgedIndex, address(audm), 5_000e6, 0);
        vm.stopPrank();
        assertEq(audHedgedIndex.balanceOf(alice), shares);
        assertEq(audm.balanceOf(alice), 0);
    }

    function test_redeemToOtherAudStable() public {
        _deposit(audHedgedIndex, alice, 10_000e6);
        uint256 s = audHedgedIndex.balanceOf(alice);
        vm.startPrank(alice);
        audHedgedIndex.approve(address(router), s);
        uint256 out = router.redeemTo(audHedgedIndex, s, address(audm), 0);
        vm.stopPrank();
        assertEq(audm.balanceOf(alice), out);
        assertApproxEqRel(out, 10_000e6, 0.003e18);
    }

    function test_openingLtvCapEnforced() public {
        vm.startPrank(alice);
        audd.approve(address(router), 10_000e6);
        vm.expectRevert(); // OpeningLtvExceeded
        router.depositToVaultAndBorrow(audHedgedIndex, address(audd), 10_000e6, 0, hedgedMarket, 6_000e6);
        vm.stopPrank();
    }

    function test_maxBorrowView() public {
        vm.startPrank(alice);
        audd.approve(address(router), 10_000e6);
        router.depositToVaultAndBorrow(audHedgedIndex, address(audd), 10_000e6, 0, hedgedMarket, 0);
        uint256 m = router.maxBorrow(hedgedMarket, alice);
        assertApproxEqRel(m, 5_480e6, 0.005e18);
        router.supplyCollateralAndBorrow(hedgedMarket, 0, m);
        vm.stopPrank();
        assertApproxEqRel(router.ltvOf(hedgedMarket, alice), OPEN_HEDGED, 0.0001e18);
    }

    function test_borrowAllowedWhileMarketClosed() public {
        vm.startPrank(alice);
        audd.approve(address(router), 10_000e6);
        router.depositToVaultAndBorrow(audHedgedIndex, address(audd), 10_000e6, 0, hedgedMarket, 0);
        vm.stopPrank();

        // v0.4: borrowing is allowed 24/7; the DEX deviation guard replaces the market-hours rule.
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_CLOSED);
        vm.prank(alice);
        router.supplyCollateralAndBorrow(hedgedMarket, 0, 1_000e6);
        assertGt(morpho.position(hedgedMarket.id(), alice).borrowShares, 0);
    }

    function test_deviationGuardPausesBorrowAndLiquidation() public {
        vm.startPrank(alice);
        audd.approve(address(router), 10_000e6);
        router.depositToVaultAndBorrow(audHedgedIndex, address(audd), 10_000e6, 0, hedgedMarket, 5_000e6);
        vm.stopPrank();

        // 3% discount (red): borrowing still allowed, collateral value unchanged
        uint256 hf0 = router.healthFactor(hedgedMarket, alice);
        vm.prank(admin);
        exchange.setDrift(-500);
        assertEq(exchange.deviationLevel(), 2);
        assertEq(router.healthFactor(hedgedMarket, alice), hf0, "DEX drift must not move collateral value");

        // 10% discount: router refuses new borrows and the oracle reverts (liquidation paused)
        vm.prank(admin);
        exchange.setDrift(-1_000);
        assertEq(exchange.deviationLevel(), 3);
        vm.prank(alice);
        vm.expectRevert(ParallelRouter.DexDislocated.selector);
        router.supplyCollateralAndBorrow(hedgedMarket, 0, 100e6);
        vm.expectRevert();
        router.healthFactor(hedgedMarket, alice);

        // back to normal: everything resumes
        vm.prank(admin);
        exchange.setDrift(0);
        assertEq(router.healthFactor(hedgedMarket, alice), hf0);
    }

    function test_repayAllAndWithdrawWhileClosed() public {
        vm.startPrank(alice);
        audd.approve(address(router), type(uint256).max);
        router.depositToVaultAndBorrow(audHedgedIndex, address(audd), 10_000e6, 0, hedgedMarket, 4_000e6);
        vm.stopPrank();

        vm.warp(block.timestamp + 30 days);
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_CLOSED); // repay is always allowed
        uint256 coll = morpho.position(hedgedMarket.id(), alice).collateral;
        vm.prank(alice);
        router.repayAndWithdraw(hedgedMarket, 0, true, coll);

        Position memory p = morpho.position(hedgedMarket.id(), alice);
        assertEq(p.borrowShares, 0);
        assertEq(p.collateral, 0);
        assertEq(audHedgedIndex.balanceOf(alice), coll);
    }

    function test_interestAccruesAtKinkedRate() public view {
        assertApproxEqRel(irm.aprAt(0), 0.02e18, 0.001e18);
        assertApproxEqRel(irm.aprAt(0.8e18), 0.08e18, 0.001e18);
        assertApproxEqRel(irm.aprAt(1e18), 0.6e18, 0.001e18);
        assertApproxEqRel(irm.aprAt(0.4e18), 0.05e18, 0.001e18);
    }

    // ------------------------------------------------------------------ end-to-end liquidations

    /// Deposit -> borrow -> S&P shock -> liquidate -> liquidator redeems seized shares.
    function test_e2e_hedgedVaultShareLiquidation() public {
        vm.startPrank(alice);
        audd.approve(address(router), 10_000e6);
        router.depositToVaultAndBorrow(audHedgedIndex, address(audd), 10_000e6, 0, hedgedMarket, 5_400e6);
        vm.stopPrank();
        assertGt(router.healthFactor(hedgedMarket, alice), 1e18);

        oracle.shock(oracle.equityKey(address(spy)), -3_500, 1 hours); // S&P -35%
        assertLt(router.healthFactor(hedgedMarket, alice), 1e18, "should be liquidatable");

        Position memory p = morpho.position(hedgedMarket.id(), alice);
        vm.startPrank(liquidator);
        audd.approve(address(morpho), type(uint256).max);
        (uint256 seized, uint256 repaid) = morpho.liquidate(hedgedMarket, alice, 0, p.borrowShares / 2, "");
        assertGt(seized, 0);
        assertGt(repaid, 0);

        // Exit path for hedged vault shares: redeem (market open) -> vault sells equities, resizes hedge.
        uint256 bal0 = audd.balanceOf(liquidator);
        uint256 out = audHedgedIndex.redeem(seized, liquidator, liquidator);
        vm.stopPrank();
        assertEq(audd.balanceOf(liquidator) - bal0, out);
        assertGt(out, repaid, "liquidation incentive covers exit cost");
    }

    function test_e2e_liquidationWhileClosedUsesQueue() public {
        vm.startPrank(alice);
        audd.approve(address(router), 10_000e6);
        router.depositToVaultAndBorrow(audHedgedIndex, address(audd), 10_000e6, 0, hedgedMarket, 5_400e6);
        vm.stopPrank();

        oracle.shock(oracle.equityKey(address(spy)), -3_500, 3 days);
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_CLOSED);

        Position memory p = morpho.position(hedgedMarket.id(), alice);
        vm.startPrank(liquidator);
        audd.approve(address(morpho), type(uint256).max);
        (uint256 seized,) = morpho.liquidate(hedgedMarket, alice, 0, p.borrowShares / 2, "");
        // cannot redeem instantly while closed -> queue, settle at next open
        audHedgedIndex.requestRedeem(seized, liquidator, 0);
        vm.stopPrank();

        oracle.setMarketMode(OracleHub.MarketMode.FORCE_OPEN);
        uint256 bal0 = audd.balanceOf(liquidator);
        vm.prank(keeper);
        audHedgedIndex.processQueue(10);
        assertGt(audd.balanceOf(liquidator), bal0, "cash recovered after open");
    }

    function test_e2e_equityCollateralLiquidation() public {
        spy.grantRole(spy.MINTER_ROLE(), admin);
        spy.mint(alice, 10e18); // ~A$9,231
        vm.startPrank(alice);
        spy.approve(address(router), 10e18);
        router.supplyCollateralAndBorrow(spyMarket, 10e18, 4_000e6);
        vm.stopPrank();

        oracle.shock(oracle.equityKey(address(spy)), -3_500, 1 hours);
        assertLt(router.healthFactor(spyMarket, alice), 1e18);

        Position memory p = morpho.position(spyMarket.id(), alice);
        vm.startPrank(liquidator);
        audd.approve(address(morpho), type(uint256).max);
        (uint256 seized, uint256 repaid) = morpho.liquidate(spyMarket, alice, 0, p.borrowShares / 2, "");
        uint256 out = exchange.sellEquity(address(spy), address(audd), seized, 0, liquidator);
        vm.stopPrank();
        assertGt(out, repaid);
    }

    function test_hedgedSharesStableUnderFxShock() public {
        vm.startPrank(alice);
        audd.approve(address(router), type(uint256).max);
        router.depositToVaultAndBorrow(audHedgedIndex, address(audd), 10_000e6, 0, hedgedMarket, 5_000e6);
        vm.stopPrank();
        uint256 hf0 = router.healthFactor(hedgedMarket, alice);
        _move(ID_AUD, 1_500); // AUD +15%
        assertApproxEqRel(router.healthFactor(hedgedMarket, alice), hf0, 0.01e18);
    }
}
