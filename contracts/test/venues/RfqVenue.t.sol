// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Fixture} from "../utils/Fixture.sol";
import {RfqVenue, Quote} from "../../src/venues/RfqVenue.sol";
import {CHErrors} from "../../src/core/ClearinghouseStorage.sol";
import {IClearinghouse, AgentPolicy, AccountState} from "../../src/interfaces/IClearinghouse.sol";
import {Position} from "../../src/types/Types.sol";
import {FixedPointMath} from "../../src/libraries/FixedPointMath.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Minimal ERC-1271 smart account: a signature is valid when its owner key signed the hash.
contract Account1271 {
    address public immutable signerKey;

    constructor(address signerKey_) {
        signerKey = signerKey_;
    }

    function createSubaccount(IClearinghouse ch) external returns (uint256) {
        return ch.createSubaccount();
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, sig);
        return err == ECDSA.RecoverError.NoError && rec == signerKey ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract RfqVenueTest is Fixture {
    uint256 constant MAKER_PK = 0xA11CE;
    uint256 constant OTHER_PK = 0xB0B;
    uint256 constant AGENT_PK = 0xA6E47;

    RfqVenue rfq;
    address maker;
    address other;
    address agentAddr;
    address taker;
    uint256 makerId;
    uint256 takerId;
    uint32 call180;

    function setUp() public override {
        super.setUp();
        rfq = new RfqVenue(ch);
        ch.addVenue(address(rfq));
        maker = vm.addr(MAKER_PK);
        other = vm.addr(OTHER_PK);
        agentAddr = vm.addr(AGENT_PK);
        taker = _user("taker");
        makerId = _fund(maker, 10_000 * USDG, 0);
        takerId = _fund(taker, 10_000 * USDG, 0);
        call180 = _list(address(nvda), _expiry(), 180e18, true);
    }

    function _quote(bool makerSells, uint256 maxQty, uint256 price) internal view returns (Quote memory) {
        return Quote({
            signer: maker,
            makerId: makerId,
            seriesId: call180,
            makerSells: makerSells,
            maxQty: maxQty,
            price: price,
            deadline: uint64(block.timestamp + 1 hours),
            nonce: 1
        });
    }

    function _sign(uint256 pk, Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, rfq.hashQuote(q));
        return abi.encodePacked(r, s, v);
    }

    function _pos(uint256 id) internal view returns (int256) {
        Position[] memory ps = ch.positionsOf(id);
        for (uint256 i = 0; i < ps.length; ++i) {
            if (ps[i].seriesId == call180) return ps[i].qty;
        }
        return 0;
    }

    function _fill(Quote memory q, bytes memory sig, uint256 qty) internal returns (uint256) {
        vm.prank(taker);
        return rfq.fill(q, sig, takerId, qty);
    }

    function test_typehash() public view {
        assertEq(
            rfq.QUOTE_TYPEHASH(),
            keccak256(
                "Quote(address signer,uint256 makerId,uint32 seriesId,bool makerSells,uint256 maxQty,uint256 price,uint64 deadline,uint256 nonce)"
            )
        );
    }

    function test_fillPartialThenRest() public {
        Quote memory q = _quote(true, 2e18, 8.333333333333333333e18);
        bytes memory sig = _sign(MAKER_PK, q);
        bytes32 h = rfq.hashQuote(q);

        uint256 p1 = FixedPointMath.mulWadUp(0.75e18, q.price);
        vm.expectEmit(true, true, false, true, address(rfq));
        emit RfqVenue.QuoteFilled(h, takerId, 0.75e18, p1);
        assertEq(_fill(q, sig, 0.75e18), p1);
        assertEq(rfq.filled(h), 0.75e18);
        assertEq(_pos(takerId), 0.75e18);
        assertEq(_pos(makerId), -0.75e18);

        uint256 p2 = FixedPointMath.mulWadUp(1.25e18, q.price);
        assertEq(_fill(q, sig, 1.25e18), p2);
        assertEq(rfq.filled(h), 2e18);
        assertEq(_pos(takerId), 2e18);
        assertEq(_pos(makerId), -2e18);
        // maker received the premiums in cash
        assertEq(ch.cashOf(makerId), 10_000e18 + p1 + p2);
    }

    function test_takerSellsWhenMakerBuys() public {
        Quote memory q = _quote(false, 2e18, 3.333333333333333333e18);
        bytes memory sig = _sign(MAKER_PK, q);
        uint256 p = 0.5e18 * q.price / 1e18;
        assertEq(_fill(q, sig, 0.5e18), p);
        assertEq(_pos(takerId), -0.5e18);
        assertEq(_pos(makerId), 0.5e18);
        assertEq(ch.cashOf(makerId), 10_000e18 - p);
    }

    function test_overfillReverts() public {
        Quote memory q = _quote(true, 1e18, 8e18);
        bytes memory sig = _sign(MAKER_PK, q);
        _fill(q, sig, 0.6e18);
        vm.expectRevert(RfqVenue.Overfill.selector);
        _fill(q, sig, 0.4e18 + 1);
        _fill(q, sig, 0.4e18); // exactly the remainder is fine
    }

    function test_expiredQuoteReverts() public {
        Quote memory q = _quote(true, 1e18, 8e18);
        bytes memory sig = _sign(MAKER_PK, q);
        vm.warp(q.deadline); // the deadline itself is still valid
        _fill(q, sig, 0.1e18);
        vm.warp(uint256(q.deadline) + 1);
        vm.expectRevert(RfqVenue.QuoteExpired.selector);
        _fill(q, sig, 0.1e18);
    }

    function test_cancelledNonceReverts() public {
        Quote memory q = _quote(true, 1e18, 8e18);
        bytes memory sig = _sign(MAKER_PK, q);
        assertFalse(rfq.isNonceCancelled(maker, 1));

        // someone else cancelling the same nonce doesn't touch the maker's
        vm.prank(other);
        rfq.cancelNonce(1);
        assertFalse(rfq.isNonceCancelled(maker, 1));
        _fill(q, sig, 0.1e18);

        vm.prank(maker);
        rfq.cancelNonce(1);
        assertTrue(rfq.isNonceCancelled(maker, 1));
        assertFalse(rfq.isNonceCancelled(maker, 2));
        assertFalse(rfq.isNonceCancelled(maker, 257)); // another bitmap word
        vm.expectRevert(RfqVenue.NonceCancelled.selector);
        _fill(q, sig, 0.1e18);
    }

    function test_wrongSignerReverts() public {
        Quote memory q = _quote(true, 1e18, 8e18);
        bytes memory bad = _sign(OTHER_PK, q);
        vm.expectRevert(RfqVenue.BadSignature.selector);
        _fill(q, bad, 0.1e18);

        // a valid signature over different terms fails too
        Quote memory q2 = _quote(true, 1e18, 7e18);
        bad = _sign(MAKER_PK, q2);
        vm.expectRevert(RfqVenue.BadSignature.selector);
        _fill(q, bad, 0.1e18);
    }

    function test_signerNotAuthorizedReverts() public {
        Quote memory q = _quote(true, 1e18, 8e18);
        q.signer = other; // properly signed by `other`, who has no rights over makerId
        bytes memory bad = _sign(OTHER_PK, q);
        vm.expectRevert(RfqVenue.SignerNotAuthorized.selector);
        _fill(q, bad, 0.1e18);
    }

    function test_agentSignedQuoteRespectsBudget() public {
        vm.prank(maker);
        ch.grantAgent(
            makerId,
            agentAddr,
            AgentPolicy({
                maxWorstLoss: 100e18,
                maxPremiumPerTrade: 50e18,
                allowedMask: 1,
                expiresAt: uint64(block.timestamp + 1 days)
            })
        );
        Quote memory q = _quote(true, 2e18, 8e18);
        q.signer = agentAddr;
        bytes memory sig = _sign(AGENT_PK, q);

        _fill(q, sig, 1e18); // one short call fits the budget
        assertEq(_pos(makerId), -1e18);

        AccountState memory st = ch.marginAfter(makerId, call180, -1e18, int256(8e18));
        assertGt(st.im, 100e18);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.AgentRiskBudgetExceeded.selector, makerId, st.im, 100e18));
        _fill(q, sig, 1e18);

        // the owner signing the same size isn't bound by the agent budget
        Quote memory qo = _quote(true, 2e18, 8e18);
        qo.nonce = 2;
        _fill(qo, _sign(MAKER_PK, qo), 1e18);
        assertEq(_pos(makerId), -2e18);
    }

    function test_erc1271SignerAccepted() public {
        Account1271 acct = new Account1271(maker);
        uint256 id = acct.createSubaccount(ch);
        // anyone may deposit into an account
        _deposit(taker, id, address(usdg), 10_000 * USDG);

        Quote memory q = _quote(true, 1e18, 8e18);
        q.signer = address(acct);
        q.makerId = id;

        _fill(q, _sign(MAKER_PK, q), 0.5e18);
        assertEq(_pos(id), -0.5e18);

        bytes memory bad = _sign(OTHER_PK, q);
        vm.expectRevert(RfqVenue.BadSignature.selector);
        _fill(q, bad, 0.5e18);
    }

    function test_replayOnOtherChainFails() public {
        Quote memory q = _quote(true, 1e18, 8e18);
        bytes memory sig = _sign(MAKER_PK, q);
        vm.chainId(1);
        vm.expectRevert(RfqVenue.BadSignature.selector);
        _fill(q, sig, 0.1e18);
    }

    function test_digestMatchesIndependentConstruction() public view {
        Quote memory q = _quote(true, 2e18, 8e18);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Quote(address signer,uint256 makerId,uint32 seriesId,bool makerSells,uint256 maxQty,uint256 price,uint64 deadline,uint256 nonce)"
                ),
                q.signer,
                q.makerId,
                q.seriesId,
                q.makerSells,
                q.maxQty,
                q.price,
                q.deadline,
                q.nonce
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Novation RFQ"),
                keccak256("1"),
                block.chainid,
                address(rfq)
            )
        );
        assertEq(rfq.hashQuote(q), keccak256(abi.encodePacked(hex"1901", domain, structHash)));
    }

    function test_qtyZeroReverts() public {
        Quote memory q = _quote(true, 1e18, 8e18);
        bytes memory sig = _sign(MAKER_PK, q);
        vm.expectRevert(CHErrors.QtyTooSmall.selector);
        _fill(q, sig, 0);
    }

    function test_selfTradeReverts() public {
        Quote memory q = _quote(true, 1e18, 8e18);
        bytes memory sig = _sign(MAKER_PK, q);
        vm.prank(maker);
        vm.expectRevert(CHErrors.SelfTrade.selector);
        rfq.fill(q, sig, makerId, 0.1e18);
    }

    function test_takerNotAuthorizedReverts() public {
        Quote memory q = _quote(true, 1e18, 8e18);
        bytes memory sig = _sign(MAKER_PK, q);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(CHErrors.NotAuthorized.selector, takerId, other));
        rfq.fill(q, sig, takerId, 0.1e18);
    }
}
