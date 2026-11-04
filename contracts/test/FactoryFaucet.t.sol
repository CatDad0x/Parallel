// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTest} from "./Base.t.sol";
import {ParallelVault} from "../src/ParallelVault.sol";
import {Faucet} from "../src/Faucet.sol";
import {MockToken} from "../src/tokens/MockToken.sol";
import {IMintableToken} from "../src/interfaces/IMintableToken.sol";

contract FactoryFaucetTest is BaseTest {
    function test_fullTwelveVaultLineup() public {
        // fixture already created 3 AUD vaults; add the remaining 9
        _createVault(audd, AUD, "Parallel AUD US Tech", "pmAUD-TECH", _basket(), false);
        MockToken[2] memory others = [eurc, inr];
        bytes32[2] memory ccys = [EUR, INR];
        for (uint256 i; i < 2; ++i) {
            _createVault(others[i], ccys[i], "Index H", "IH", _index(), true);
            _createVault(others[i], ccys[i], "Index", "I", _index(), false);
            _createVault(others[i], ccys[i], "Basket H", "BH", _basket(), true);
            _createVault(others[i], ccys[i], "Basket", "B", _basket(), false);
        }
        assertEq(factory.vaults().length, 12);
        assertEq(factory.vaultsByCurrency(AUD).length, 4);
        assertEq(factory.vaultsByCurrency(EUR).length, 4);
        assertEq(factory.vaultsByCurrency(INR).length, 4);
    }

    function test_inrHedgedVaultWorks() public {
        ParallelVault v = _createVault(inr, INR, "Parallel INR Hedged S&P 500", "pmINR-SPY-H", _index(), true);
        inr.grantRole(inr.MINTER_ROLE(), admin);
        inr.mint(alice, 840_000e6); // ~US$10k
        _deposit(v, alice, 840_000e6);
        uint256 v0 = _assetValue(v, alice);
        _move(ID_INR, -1_000); // USD/INR falls 10% => INR strengthens
        assertApproxEqRel(_assetValue(v, alice), v0, 0.005e18);
    }

    function test_onlyAdminCreatesVaults() public {
        ParallelVault.Config memory c = _index();
        vm.prank(alice);
        vm.expectRevert();
        factory.createVault(audd, "x", "x", c, alice);
    }

    function test_badWeightsRevert() public {
        ParallelVault.Config memory c = _index();
        c.weightsBps[0] = 9_000;
        c.currency = AUD;
        vm.expectRevert(ParallelVault.BadConfig.selector);
        factory.createVault(audd, "x", "x", c, admin);
    }

    function test_implementationCannotBeInitialised() public {
        ParallelVault impl = ParallelVault(factory.implementation());
        ParallelVault.Config memory c = _index();
        ParallelVault.Deps memory d;
        vm.expectRevert();
        impl.initialize(audd, "x", "x", c, d, admin, keeper);
    }

    function test_faucetClaimAndCooldown() public {
        Faucet.Drip[] memory d = new Faucet.Drip[](2);
        d[0] = Faucet.Drip(IMintableToken(address(audm)), 10_000e6);
        d[1] = Faucet.Drip(IMintableToken(address(spy)), 5e18);
        faucet.setDrips(d);

        address carol = makeAddr("carol");
        vm.prank(carol);
        faucet.claim();
        assertEq(audm.balanceOf(carol), 10_000e6);
        assertEq(spy.balanceOf(carol), 5e18);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Faucet.CoolingDown.selector, block.timestamp + 1 days));
        faucet.claim();

        vm.warp(block.timestamp + 1 days);
        faucet.claimFor(carol);
        assertEq(audm.balanceOf(carol), 20_000e6);
    }
}
