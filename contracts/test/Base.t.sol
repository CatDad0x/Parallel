// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockPyth} from "./mocks/MockPyth.sol";
import {MockToken} from "../src/tokens/MockToken.sol";
import {OracleHub} from "../src/OracleHub.sol";
import {SimExchange} from "../src/SimExchange.sol";
import {HedgeBook} from "../src/HedgeBook.sol";
import {ParallelVault} from "../src/ParallelVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {Faucet} from "../src/Faucet.sol";
import {IOracleHub} from "../src/interfaces/IOracleHub.sol";
import {IMintableToken} from "../src/interfaces/IMintableToken.sol";

/// @notice Shared fixture: full protocol with AUD/EUR/INR stables, SPY + 5-stock basket, and
/// three AUD vaults (hedged index, unhedged index, hedged basket).
abstract contract BaseTest is Test {
    bytes32 constant AUD = "AUD";
    bytes32 constant EUR = "EUR";
    bytes32 constant INR = "INR";
    bytes32 constant STABLE = "STABLE";
    bytes32 constant EQUITY = "EQUITY";

    bytes32 constant ID_SPY = keccak256("SPY");
    bytes32 constant ID_AAPL = keccak256("AAPL");
    bytes32 constant ID_MSFT = keccak256("MSFT");
    bytes32 constant ID_NVDA = keccak256("NVDA");
    bytes32 constant ID_AMZN = keccak256("AMZN");
    bytes32 constant ID_GOOGL = keccak256("GOOGL");
    bytes32 constant ID_AUD = keccak256("AUD/USD");
    bytes32 constant ID_EUR = keccak256("EUR/USD");
    bytes32 constant ID_INR = keccak256("USD/INR");

    address admin = address(this);
    address keeper = makeAddr("keeper");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    MockPyth pyth;
    OracleHub oracle;
    SimExchange exchange;
    HedgeBook hedgeBook;
    VaultFactory factory;
    Faucet faucet;

    MockToken audd;
    MockToken audm;
    MockToken audc;
    MockToken eurc;
    MockToken inr;

    MockToken spy;
    MockToken aapl;
    MockToken msft;
    MockToken nvda;
    MockToken amzn;
    MockToken googl;

    ParallelVault audHedgedIndex;
    ParallelVault audUnhedgedIndex;
    ParallelVault audHedgedBasket;

    function setUp() public virtual {
        vm.warp(1_780_000_000);

        pyth = new MockPyth();
        oracle = new OracleHub(pyth, admin);
        oracle.setMarketMode(OracleHub.MarketMode.FORCE_OPEN);
        exchange = new SimExchange(IOracleHub(address(oracle)), admin);
        hedgeBook = new HedgeBook(IOracleHub(address(oracle)), admin);
        faucet = new Faucet(admin);

        audd = _stable("Mock AUDD", "mAUDD", AUD);
        audm = _stable("Mock AUDM", "mAUDM", AUD);
        audc = _stable("Mock AUDC", "mAUDC", AUD);
        eurc = _stable("Mock EURC", "mEURC", EUR);
        inr = _stable("Mock INR", "mINR", INR);

        spy = _equity("Mock S&P 500 ETF", "mSPY", ID_SPY);
        aapl = _equity("Mock Apple", "mAAPL", ID_AAPL);
        msft = _equity("Mock Microsoft", "mMSFT", ID_MSFT);
        nvda = _equity("Mock NVIDIA", "mNVDA", ID_NVDA);
        amzn = _equity("Mock Amazon", "mAMZN", ID_AMZN);
        googl = _equity("Mock Alphabet", "mGOOGL", ID_GOOGL);

        oracle.setFeed(AUD, ID_AUD, false);
        oracle.setFeed(EUR, ID_EUR, false);
        oracle.setFeed(INR, ID_INR, true);

        _setDefaultPrices();

        ParallelVault impl = new ParallelVault();
        factory = new VaultFactory(
            address(impl),
            ParallelVault.Deps({
                oracle: IOracleHub(address(oracle)), exchange: exchange, hedgeBook: hedgeBook, treasury: treasury
            }),
            keeper,
            admin
        );
        hedgeBook.grantRole(hedgeBook.REGISTRAR_ROLE(), address(factory));

        audHedgedIndex = _createVault(audd, AUD, "Parallel AUD Hedged S&P 500", "pmAUD-SPY-H", _index(), true);
        audUnhedgedIndex = _createVault(audd, AUD, "Parallel AUD S&P 500", "pmAUD-SPY", _index(), false);
        audHedgedBasket = _createVault(audd, AUD, "Parallel AUD Hedged US Tech", "pmAUD-TECH-H", _basket(), true);

        audd.grantRole(audd.MINTER_ROLE(), admin);
        audd.mint(alice, 1_000_000e6);
        audd.mint(bob, 1_000_000e6);
    }

    // ------------------------------------------------------------------ helpers

    function _stable(string memory n, string memory s, bytes32 ccy) internal returns (MockToken t) {
        t = new MockToken(n, s, 6, STABLE, admin);
        _grantMinters(t);
        exchange.registerStable(address(t), ccy);
    }

    function _equity(string memory n, string memory s, bytes32 pythId) internal returns (MockToken t) {
        t = new MockToken(n, s, 18, EQUITY, admin);
        _grantMinters(t);
        exchange.registerEquity(address(t), true);
        oracle.setFeed(oracle.equityKey(address(t)), pythId, false);
    }

    function _grantMinters(MockToken t) internal {
        t.grantRole(t.MINTER_ROLE(), address(exchange));
        t.grantRole(t.MINTER_ROLE(), address(hedgeBook));
        t.grantRole(t.MINTER_ROLE(), address(faucet));
    }

    function _setDefaultPrices() internal {
        // Pyth-style: price * 10^expo
        _px(ID_SPY, 600e5, -5); // $600
        _px(ID_AAPL, 230e5, -5);
        _px(ID_MSFT, 450e5, -5);
        _px(ID_NVDA, 140e5, -5);
        _px(ID_AMZN, 200e5, -5);
        _px(ID_GOOGL, 175e5, -5);
        _px(ID_AUD, 65_000, -5); // 0.65 USD per AUD
        _px(ID_EUR, 108_000, -5); // 1.08 USD per EUR
        _px(ID_INR, 8_400_000, -5); // 84 INR per USD
    }

    function _px(bytes32 id, int64 p, int32 expo) internal {
        pyth.setPrice(id, p, expo, block.timestamp);
    }

    /// @dev Scale a price feed by (10000 + bps) / 10000, keeping expo -5.
    function _move(bytes32 id, int256 bps) internal {
        int64 cur = pyth.getPriceUnsafe(id).price;
        _px(id, int64(int256(cur) * (10_000 + bps) / 10_000), -5);
    }

    function _index() internal view returns (ParallelVault.Config memory c) {
        address[] memory eq = new address[](1);
        eq[0] = address(spy);
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        c.equities = eq;
        c.weightsBps = w;
    }

    function _basket() internal view returns (ParallelVault.Config memory c) {
        address[] memory eq = new address[](5);
        (eq[0], eq[1], eq[2], eq[3], eq[4]) =
        (address(aapl), address(msft), address(nvda), address(amzn), address(googl));
        uint16[] memory w = new uint16[](5);
        for (uint256 i; i < 5; ++i) {
            w[i] = 2_000;
        }
        c.equities = eq;
        c.weightsBps = w;
    }

    function _createVault(
        MockToken asset,
        bytes32 ccy,
        string memory name,
        string memory symbol,
        ParallelVault.Config memory c,
        bool hedged
    ) internal returns (ParallelVault v) {
        c.currency = ccy;
        c.hedged = hedged;
        c.targetHedgeBps = 10_000;
        c.hedgeDriftBps = 300;
        c.cashBufferBps = 300;
        c.mgmtFeeBps = 50;
        v = ParallelVault(factory.createVault(IERC20(address(asset)), name, symbol, c, admin));
    }

    function _deposit(ParallelVault v, address who, uint256 assets) internal returns (uint256 shares) {
        vm.startPrank(who);
        IERC20(v.asset()).approve(address(v), assets);
        shares = v.deposit(assets, who);
        vm.stopPrank();
    }

    function _redeemAll(ParallelVault v, address who) internal returns (uint256 assets) {
        uint256 bal = v.balanceOf(who);
        vm.prank(who);
        assets = v.redeem(bal, who, who);
    }

    function _assetValue(ParallelVault v, address who) internal view returns (uint256) {
        return v.convertToAssets(v.balanceOf(who));
    }
}
