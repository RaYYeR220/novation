// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Never deployed: injected via an eth_call state override to measure the gas of one inner CALL.
contract Probe {
    function probe(address t, bytes calldata d) external returns (uint256 used, bool ok, bytes memory ret) {
        uint256 g = gasleft();
        (ok, ret) = t.call(d);
        used = g - gasleft();
    }
}
