// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";

import {MockToken} from "../src/tokens/MockToken.sol";
import {OracleHub} from "../src/OracleHub.sol";
import {SimExchange} from "../src/SimExchange.sol";
import {HedgeBook} from "../src/HedgeBook.sol";
import {ParallelVault} from "../src/ParallelVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {Faucet} from "../src/Faucet.sol";
import {ParallelRouter} from "../src/ParallelRouter.sol";
import {KinkedIrm} from "../src/lending/KinkedIrm.sol";
import {EquityOracleAdapter, VaultShareOracleAdapter, IParallelVaultView} from "../src/lending/OracleAdapters.sol";
import {DemoPyth} from "../src/testnet/DemoPyth.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {IOracleHub} from "../src/interfaces/IOracleHub.sol";
import {IMintableToken} from "../src/interfaces/IMintableToken.sol";

/// @title Deploy
/// @notice Deploys and seeds the full Parallel Markets demo:
///   tokens, oracle, exchange, hedge book, 12 vaults, Morpho Blue + IRM + 5 markets, router, faucet.
///
/// Env:
///   PRIVATE_KEY      deployer (becomes admin)
///   KEEPER_ADDRESS   keeper bot address (default: deployer)
///   PYTH_ADDRESS     optional. If unset, deploys DemoPyth (keeper-pushed simulated prices, works 24/7).
///                    If set, uses real Pyth and reads FEED_<KEY> env vars (bytes32) for feed IDs.
///   MORPHO_ADDRESS   optional. If unset, deploys Morpho Blue from the compiled artifact.
///
/// Writes ../packages/shared/deployments/<chainId>.json
contract Deploy is Script {
    using MarketParamsLib for MarketParams;

    bytes32 constant AUD = "AUD";
    bytes32 constant EUR = "EUR";
    bytes32 constant INR = "INR";

    struct Core {
        address admin;
        address keeper;
        bool demoPyth;
        IPyth pyth;
        OracleHub oracle;
        SimExchange exchange;
        HedgeBook hedgeBook;
        Faucet faucet;
        VaultFactory factory;
        IMorpho morpho;
        KinkedIrm irm;
        ParallelRouter router;
    }

    struct VaultInfo {
        address vault;
        string name;
        string symbol;
        bytes32 currency;
        string strategy;
        bool hedged;
    }

    struct MarketInfo {
        MarketParams mp;
        uint256 maxOpenLtv;
        string label;
    }

    Core internal c;
    MockToken[] internal stables;
    bytes32[] internal stableCcy;
    MockToken[] internal equities;
    string[] internal equityKeys;
    bytes32[] internal feedKeys; // for every equity then AUD, EUR, INR
    bytes32[] internal feedIds;
    string[] internal feedNames;
    VaultInfo[] internal vaultInfos;
    MarketInfo[] internal marketInfos;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        c.admin = vm.addr(pk);
        c.keeper = vm.envOr("KEEPER_ADDRESS", c.admin);

        vm.startBroadcast(pk);
        _deployCore();
        _deployTokens();
        _configureFeeds();
        _deployVaults();
        _deployLending();
        _configureFaucet();
        _seed();
        vm.stopBroadcast();

        _writeDeployment();
    }

    // ------------------------------------------------------------------ core

    function _deployCore() internal {
        address pythAddr = vm.envOr("PYTH_ADDRESS", address(0));
        if (pythAddr == address(0)) {
            c.demoPyth = true;
            c.pyth = IPyth(address(new DemoPyth(c.admin, c.keeper)));
        } else {
            c.pyth = IPyth(pythAddr);
        }
        c.oracle = new OracleHub(c.pyth, c.admin);
        // Demo default: market forced open so the journey works at any hour (Brisbane daytime = US night).
        // Switch to AUTO or FORCE_CLOSED from the admin panel to demonstrate market-hours behaviour.
        c.oracle.setMarketMode(OracleHub.MarketMode.FORCE_OPEN);
        if (c.demoPyth) c.oracle.setMaxAge(1 hours);
        c.exchange = new SimExchange(IOracleHub(address(c.oracle)), c.admin);
        c.hedgeBook = new HedgeBook(IOracleHub(address(c.oracle)), c.admin);
        c.faucet = new Faucet(c.admin);

        ParallelVault impl = new ParallelVault();
        c.factory = new VaultFactory(
            address(impl),
            ParallelVault.Deps({
                oracle: IOracleHub(address(c.oracle)),
                exchange: c.exchange,
                hedgeBook: c.hedgeBook,
                treasury: c.admin
            }),
            c.keeper,
            c.admin
        );
        c.hedgeBook.grantRole(c.hedgeBook.REGISTRAR_ROLE(), address(c.factory));

        // Illustrative annual hedge carry (bps, positive = cost to the hedger). Not market data.
        c.hedgeBook.setCarry(AUD, 50);
        c.hedgeBook.setCarry(EUR, 150);
        c.hedgeBook.setCarry(INR, -250);
    }

    function _deployTokens() internal {
        _stable("Mock AUDD (testnet)", "mAUDD", AUD);
        _stable("Mock AUDM (testnet)", "mAUDM", AUD);
        _stable("Mock AUDC (testnet)", "mAUDC", AUD);
        _stable("Mock EURC (testnet)", "mEURC", EUR);
        _stable("Mock INR (testnet)", "mINR", INR);

        _equity("Mock S&P 500 ETF (testnet)", "mSPY", "SPY");
        _equity("Mock Apple (testnet)", "mAAPL", "AAPL");
        _equity("Mock Microsoft (testnet)", "mMSFT", "MSFT");
        _equity("Mock NVIDIA (testnet)", "mNVDA", "NVDA");
        _equity("Mock Amazon (testnet)", "mAMZN", "AMZN");
        _equity("Mock Alphabet (testnet)", "mGOOGL", "GOOGL");
    }

    function _stable(string memory name, string memory symbol, bytes32 ccy) internal {
        MockToken t = new MockToken(name, symbol, 6, "STABLE", c.admin);
        _grantMinters(t);
        c.exchange.registerStable(address(t), ccy);
        stables.push(t);
        stableCcy.push(ccy);
    }

    function _equity(string memory name, string memory symbol, string memory key) internal {
        MockToken t = new MockToken(name, symbol, 18, "EQUITY", c.admin);
        _grantMinters(t);
        c.exchange.registerEquity(address(t), true);
        equities.push(t);
        equityKeys.push(key);
    }

    function _grantMinters(MockToken t) internal {
        bytes32 role = t.MINTER_ROLE();
        t.grantRole(role, address(c.exchange));
        t.grantRole(role, address(c.hedgeBook));
        t.grantRole(role, address(c.faucet));
        t.grantRole(role, c.admin);
    }

    // ------------------------------------------------------------------ feeds

    function _configureFeeds() internal {
        for (uint256 i; i < equities.length; ++i) {
            bytes32 id = _feedId(equityKeys[i]);
            c.oracle.setFeed(c.oracle.equityKey(address(equities[i])), id, false);
            _recordFeed(c.oracle.equityKey(address(equities[i])), id, equityKeys[i]);
        }
        c.oracle.setFeed(AUD, _feedId("AUD"), false);
        c.oracle.setFeed(EUR, _feedId("EUR"), false);
        c.oracle.setFeed(INR, _feedId("INR"), true); // USD/INR is inverted on read
        _recordFeed(AUD, _feedId("AUD"), "AUD");
        _recordFeed(EUR, _feedId("EUR"), "EUR");
        _recordFeed(INR, _feedId("INR"), "INR");

        if (c.demoPyth) {
            // Starting levels for simulated prices (expo -5). The keeper random-walks around these.
            int64[9] memory px = [
                int64(600e5), // SPY
                230e5, // AAPL
                450e5, // MSFT
                140e5, // NVDA
                200e5, // AMZN
                175e5, // GOOGL
                65_000, // AUD/USD 0.65
                108_000, // EUR/USD 1.08
                8_400_000 // USD/INR 84
            ];
            int64[] memory prices = new int64[](9);
            for (uint256 i; i < 9; ++i) prices[i] = px[i];
            DemoPyth(address(c.pyth)).setPrices(feedIds, prices, -5);
        }
    }

    function _feedId(string memory key) internal view returns (bytes32) {
        if (c.demoPyth) return keccak256(bytes(string.concat("parallel.demo.", key)));
        return vm.envBytes32(string.concat("FEED_", key));
    }

    function _recordFeed(bytes32 key, bytes32 id, string memory name) internal {
        feedKeys.push(key);
        feedIds.push(id);
        feedNames.push(name);
    }

    // ------------------------------------------------------------------ vaults

    function _deployVaults() internal {
        MockToken[3] memory assets = [stables[0], stables[3], stables[4]]; // mAUDD, mEURC, mINR
        bytes32[3] memory ccys = [AUD, EUR, INR];
        string[3] memory codes = ["AUD", "EUR", "INR"];
        for (uint256 i; i < 3; ++i) {
            _vault(assets[i], ccys[i], codes[i], true, true);
            _vault(assets[i], ccys[i], codes[i], true, false);
            _vault(assets[i], ccys[i], codes[i], false, true);
            _vault(assets[i], ccys[i], codes[i], false, false);
        }
    }

    function _vault(MockToken asset, bytes32 ccy, string memory code, bool index, bool hedged) internal {
        ParallelVault.Config memory cfg;
        if (index) {
            cfg.equities = new address[](1);
            cfg.equities[0] = address(equities[0]);
            cfg.weightsBps = new uint16[](1);
            cfg.weightsBps[0] = 10_000;
        } else {
            cfg.equities = new address[](5);
            cfg.weightsBps = new uint16[](5);
            for (uint256 i; i < 5; ++i) {
                cfg.equities[i] = address(equities[i + 1]);
                cfg.weightsBps[i] = 2_000;
            }
        }
        cfg.currency = ccy;
        cfg.hedged = hedged;
        cfg.targetHedgeBps = 10_000;
        cfg.hedgeDriftBps = 300;
        cfg.cashBufferBps = 300;
        cfg.mgmtFeeBps = 50;

        string memory strat = index ? "S&P 500" : "US Tech";
        string memory name = string.concat("Parallel ", code, hedged ? " Hedged " : " ", strat);
        string memory symbol = string.concat("pm", code, index ? "-SPY" : "-TECH", hedged ? "-H" : "");
        address v = c.factory.createVault(IERC20(address(asset)), name, symbol, cfg, c.admin);
        vaultInfos.push(VaultInfo(v, name, symbol, ccy, index ? "index" : "basket", hedged));
    }

    // ------------------------------------------------------------------ lending

    function _deployLending() internal {
        address morphoAddr = vm.envOr("MORPHO_ADDRESS", address(0));
        if (morphoAddr == address(0)) {
            morphoAddr = deployCode("out/Morpho.sol/Morpho.json", abi.encode(c.admin));
            c.morpho = IMorpho(morphoAddr);
            c.morpho.enableLltv(0.625e18);
            c.morpho.enableLltv(0.77e18);
        } else {
            c.morpho = IMorpho(morphoAddr);
        }
        c.irm = new KinkedIrm(0.02e18, 0.08e18, 0.6e18, 0.8e18);
        if (!c.morpho.isIrmEnabled(address(c.irm))) c.morpho.enableIrm(address(c.irm));
        c.router = new ParallelRouter(c.morpho, c.exchange, IOracleHub(address(c.oracle)), c.admin);

        // Illustrative parameters, pending risk calibration. LLTV is immutable per market.
        _equityMarket(stables[0], AUD, "mAUDD / mSPY");
        _vaultMarket(vaultInfos[0].vault, stables[0], 0.77e18, 0.55e18, "mAUDD / AUD Hedged S&P 500 shares");
        _vaultMarket(vaultInfos[1].vault, stables[0], 0.625e18, 0.45e18, "mAUDD / AUD S&P 500 shares");
        _equityMarket(stables[3], EUR, "mEURC / mSPY");
        _equityMarket(stables[4], INR, "mINR / mSPY");
    }

    function _equityMarket(MockToken loan, bytes32 ccy, string memory label) internal {
        address oracle =
            address(new EquityOracleAdapter(IOracleHub(address(c.oracle)), address(equities[0]), ccy, address(loan)));
        _market(MarketParams(address(loan), address(equities[0]), oracle, address(c.irm), 0.625e18), 0.45e18, label);
    }

    function _vaultMarket(address vault, MockToken loan, uint256 lltv, uint256 openLtv, string memory label)
        internal
    {
        address oracle = address(new VaultShareOracleAdapter(IParallelVaultView(vault)));
        _market(MarketParams(address(loan), vault, oracle, address(c.irm), lltv), openLtv, label);
    }

    function _market(MarketParams memory mp, uint256 openLtv, string memory label) internal {
        c.morpho.createMarket(mp);
        c.router.setMaxOpenLtv(mp, openLtv);
        marketInfos.push(MarketInfo(mp, openLtv, label));
    }

    // ------------------------------------------------------------------ faucet + seed

    function _configureFaucet() internal {
        Faucet.Drip[] memory d = new Faucet.Drip[](6);
        d[0] = Faucet.Drip(IMintableToken(address(stables[0])), 10_000e6);
        d[1] = Faucet.Drip(IMintableToken(address(stables[1])), 10_000e6);
        d[2] = Faucet.Drip(IMintableToken(address(stables[2])), 10_000e6);
        d[3] = Faucet.Drip(IMintableToken(address(stables[3])), 10_000e6);
        d[4] = Faucet.Drip(IMintableToken(address(stables[4])), 500_000e6);
        d[5] = Faucet.Drip(IMintableToken(address(equities[0])), 10e18);
        c.faucet.setDrips(d);
    }

    function _seed() internal {
        // Seed deposit in every vault (A$/€ 1,000 or ₹ 80,000) so share prices are established.
        for (uint256 i; i < vaultInfos.length; ++i) {
            ParallelVault v = ParallelVault(vaultInfos[i].vault);
            MockToken a = MockToken(v.asset());
            uint256 amt = vaultInfos[i].currency == INR ? 80_000e6 : 1_000e6;
            a.mint(c.admin, amt);
            a.approve(address(v), amt);
            v.deposit(amt, c.admin);
        }
        // Lender liquidity in every Morpho market.
        for (uint256 i; i < marketInfos.length; ++i) {
            MarketParams memory mp = marketInfos[i].mp;
            MockToken loan = MockToken(mp.loanToken);
            uint256 amt = mp.loanToken == address(stables[4]) ? 50_000_000e6 : 1_000_000e6;
            loan.mint(c.admin, amt);
            loan.approve(address(c.morpho), amt);
            c.morpho.supply(mp, amt, 0, c.admin, "");
        }
        // Keeper liquidation inventory.
        stables[0].mint(c.keeper, 1_000_000e6);
        stables[3].mint(c.keeper, 1_000_000e6);
        stables[4].mint(c.keeper, 50_000_000e6);
    }

    // ------------------------------------------------------------------ output

    function _writeDeployment() internal {
        string memory j = string.concat(
            "{\n",
            _kv("chainId", vm.toString(block.chainid), false),
            _kv("demoPyth", c.demoPyth ? "true" : "false", false),
            _kvAddr("admin", c.admin),
            _kvAddr("keeper", c.keeper),
            _kvAddr("pyth", address(c.pyth)),
            _kvAddr("oracleHub", address(c.oracle)),
            _kvAddr("exchange", address(c.exchange)),
            _kvAddr("hedgeBook", address(c.hedgeBook)),
            _kvAddr("faucet", address(c.faucet)),
            _kvAddr("factory", address(c.factory)),
            _kvAddr("morpho", address(c.morpho)),
            _kvAddr("irm", address(c.irm)),
            _kvAddr("router", address(c.router))
        );
        j = string.concat(j, '  "tokens": [\n', _tokensJson(), "  ],\n");
        j = string.concat(j, '  "feeds": [\n', _feedsJson(), "  ],\n");
        j = string.concat(j, '  "vaults": [\n', _vaultsJson(), "  ],\n");
        j = string.concat(j, '  "markets": [\n', _marketsJson(), "  ]\n}\n");

        string memory path = string.concat("../packages/shared/deployments/", vm.toString(block.chainid), ".json");
        vm.writeFile(path, j);
        console2.log("Deployment written to", path);
    }

    function _tokensJson() internal view returns (string memory s) {
        uint256 n = stables.length + equities.length;
        for (uint256 i; i < n; ++i) {
            bool isStable = i < stables.length;
            MockToken t = isStable ? stables[i] : equities[i - stables.length];
            string memory ccy = isStable ? _b32(stableCcy[i]) : "USD";
            s = string.concat(
                s,
                '    {"address": "',
                vm.toString(address(t)),
                '", "symbol": "',
                t.symbol(),
                '", "name": "',
                t.name(),
                '", "decimals": ',
                vm.toString(t.decimals()),
                ', "kind": "',
                isStable ? "stable" : "equity",
                '", "currency": "',
                ccy,
                i + 1 < n ? '"},\n' : '"}\n'
            );
        }
    }

    function _feedsJson() internal view returns (string memory s) {
        for (uint256 i; i < feedIds.length; ++i) {
            s = string.concat(
                s,
                '    {"name": "',
                feedNames[i],
                '", "key": "',
                vm.toString(feedKeys[i]),
                '", "pythId": "',
                vm.toString(feedIds[i]),
                i + 1 < feedIds.length ? '"},\n' : '"}\n'
            );
        }
    }

    function _vaultsJson() internal view returns (string memory s) {
        for (uint256 i; i < vaultInfos.length; ++i) {
            VaultInfo memory v = vaultInfos[i];
            s = string.concat(
                s,
                '    {"address": "',
                vm.toString(v.vault),
                '", "name": "',
                v.name,
                '", "symbol": "',
                v.symbol,
                '", "currency": "',
                _b32(v.currency),
                '", "strategy": "',
                v.strategy,
                '", "hedged": ',
                v.hedged ? "true" : "false",
                i + 1 < vaultInfos.length ? "},\n" : "}\n"
            );
        }
    }

    function _marketsJson() internal view returns (string memory s) {
        for (uint256 i; i < marketInfos.length; ++i) {
            MarketInfo memory m = marketInfos[i];
            s = string.concat(
                s,
                '    {"id": "',
                vm.toString(Id.unwrap(m.mp.id())),
                '", "label": "',
                m.label,
                '", "loanToken": "',
                vm.toString(m.mp.loanToken),
                '", "collateralToken": "',
                vm.toString(m.mp.collateralToken),
                '", "oracle": "',
                vm.toString(m.mp.oracle),
                '", "irm": "',
                vm.toString(m.mp.irm)
            );
            s = string.concat(
                s,
                '", "lltv": "',
                vm.toString(m.mp.lltv),
                '", "maxOpenLtv": "',
                vm.toString(m.maxOpenLtv),
                i + 1 < marketInfos.length ? '"},\n' : '"}\n'
            );
        }
    }

    function _kv(string memory k, string memory v, bool quote) internal pure returns (string memory) {
        return string.concat('  "', k, '": ', quote ? '"' : "", v, quote ? '"' : "", ",\n");
    }

    function _kvAddr(string memory k, address a) internal pure returns (string memory) {
        return _kv(k, vm.toString(a), true);
    }

    function _b32(bytes32 b) internal pure returns (string memory) {
        uint256 len;
        while (len < 32 && b[len] != 0) ++len;
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) out[i] = b[i];
        return string(out);
    }
}
