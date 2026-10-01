// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IClearinghouse} from "../../src/interfaces/IClearinghouse.sol";

/// @notice Test-only stand-in for the auction house: records every deficit sale the clearinghouse
/// starts and can hand auction proceeds back through applyDeficitProceeds. No auction logic.
contract MockAuctionHouse {
    error NotClearinghouse();

    struct Sale {
        uint256 id;
        uint64 expiry;
    }

    IClearinghouse public immutable ch;
    Sale[] private _sales;

    constructor(IClearinghouse ch_) {
        ch = ch_;
    }

    function startDeficitSale(uint256 id, uint64 expiry) external {
        if (msg.sender != address(ch)) revert NotClearinghouse();
        _sales.push(Sale({id: id, expiry: expiry}));
    }

    /// @notice Forwards to the clearinghouse as the bound auction house (after a bidder's payment
    /// has reached the account's cash).
    function applyDeficitProceeds(uint256 id, uint64 expiry) external {
        ch.applyDeficitProceeds(id, expiry);
    }

    function salesCount() external view returns (uint256) {
        return _sales.length;
    }

    function sale(uint256 i) external view returns (uint256 id, uint64 expiry) {
        Sale memory s = _sales[i];
        return (s.id, s.expiry);
    }
}
