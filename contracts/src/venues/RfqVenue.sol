// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IClearinghouse, TradeParams} from "../interfaces/IClearinghouse.sol";
import {FixedPointMath} from "../libraries/FixedPointMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice A maker's signed offer. `signer` is the owner or an authorized agent of `makerId`
/// (an EOA, or a smart account verified through ERC-1271).
struct Quote {
    address signer;
    uint256 makerId;
    uint32 seriesId;
    bool makerSells; // true: the taker buys from the maker
    uint256 maxQty; // WAD
    uint256 price; // WAD USDG per contract
    uint64 deadline;
    uint256 nonce;
}

/// @notice Fills EIP-712 signed maker quotes against the clearinghouse. Margin and agent risk
/// budgets are enforced there; this venue only checks the quote itself.
contract RfqVenue is EIP712("Novation RFQ", "1"), ReentrancyGuardTransient {
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address signer,uint256 makerId,uint32 seriesId,bool makerSells,uint256 maxQty,uint256 price,uint64 deadline,uint256 nonce)"
    );

    error QuoteExpired();
    error NonceCancelled();
    error BadSignature();
    error SignerNotAuthorized();
    error Overfill();

    event QuoteFilled(bytes32 indexed quoteHash, uint256 indexed takerId, uint256 qty, uint256 premium);
    event NonceCancelledBy(address indexed signer, uint256 nonce);

    IClearinghouse public immutable ch;

    mapping(bytes32 quoteHash => uint256) public filled;
    mapping(address signer => mapping(uint256 word => uint256 bits)) private _cancelled;

    constructor(IClearinghouse ch_) {
        ch = ch_;
    }

    function hashQuote(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    q.signer,
                    q.makerId,
                    q.seriesId,
                    q.makerSells,
                    q.maxQty,
                    q.price,
                    q.deadline,
                    q.nonce
                )
            )
        );
    }

    function fill(Quote calldata q, bytes calldata sig, uint256 takerId, uint256 qty)
        external
        nonReentrant
        returns (uint256 premium)
    {
        if (block.timestamp > q.deadline) revert QuoteExpired();
        if (isNonceCancelled(q.signer, q.nonce)) revert NonceCancelled();
        bytes32 h = hashQuote(q);
        if (!SignatureChecker.isValidSignatureNow(q.signer, h, sig)) revert BadSignature();
        if (!ch.isAuthorized(q.makerId, q.signer)) revert SignerNotAuthorized();

        uint256 newFilled = filled[h] + qty;
        if (newFilled > q.maxQty) revert Overfill();
        filled[h] = newFilled;

        // the taker pays up on a buy and the maker pays down on a sell: both round against the payer
        premium = q.makerSells ? FixedPointMath.mulWadUp(qty, q.price) : Math.mulDiv(qty, q.price, 1e18);
        ch.trade(
            TradeParams({
                takerActor: msg.sender,
                makerActor: q.signer,
                takerId: takerId,
                makerId: q.makerId,
                seriesId: q.seriesId,
                qty: q.makerSells ? SafeCast.toInt256(qty) : -SafeCast.toInt256(qty),
                premium: premium
            })
        );
        emit QuoteFilled(h, takerId, qty, premium);
    }

    /// @notice Cancels one of the caller's own nonces.
    function cancelNonce(uint256 nonce) external {
        _cancelled[msg.sender][nonce >> 8] |= 1 << (nonce & 0xff);
        emit NonceCancelledBy(msg.sender, nonce);
    }

    function isNonceCancelled(address signer, uint256 nonce) public view returns (bool) {
        return _cancelled[signer][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }
}
