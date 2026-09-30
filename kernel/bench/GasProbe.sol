// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IArbWasm {
    function activateProgram(address program) external payable returns (uint16 version, uint256 dataFee);
}

/// Injected with a state override into an eth_call only (never deployed): optionally activates a
/// Stylus program placed at `target` by the same override, then measures one staticcall to it.
contract GasProbe {
    function measure(address target, uint256 activationFee, bytes calldata data)
        external
        payable
        returns (bool ok, uint256 gasUsed, bytes memory ret)
    {
        if (activationFee > 0) {
            IArbWasm(address(0x71)).activateProgram{value: activationFee}(target);
        }
        uint256 g = gasleft();
        (ok, ret) = target.staticcall(data);
        gasUsed = g - gasleft();
    }
}
