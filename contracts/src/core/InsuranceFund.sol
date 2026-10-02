// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IInsuranceFund} from "../interfaces/IInsuranceFund.sol";

/// @notice Holds USDG that backstops bad debt. Anyone can top it up by transferring USDG in;
/// only the bound clearinghouse can draw on it and report recoveries / write-offs.
contract InsuranceFund is IInsuranceFund, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error NotSetupAdmin();
    error AlreadyBound();
    error NotClearinghouse();
    error BadDecimals();

    IERC20Metadata public immutable usdg;
    address public immutable setupAdmin;
    uint256 private immutable _scale; // 10 ** (18 - decimals)

    address public clearinghouse;
    uint256 private _outstanding;

    constructor(IERC20Metadata usdg_, address setupAdmin_) {
        if (address(usdg_) == address(0) || setupAdmin_ == address(0)) revert ZeroAddress();
        uint8 dec = usdg_.decimals();
        if (dec > 18) revert BadDecimals();
        usdg = usdg_;
        setupAdmin = setupAdmin_;
        _scale = 10 ** (18 - dec);
    }

    function bindClearinghouse(address ch) external nonReentrant {
        if (msg.sender != setupAdmin) revert NotSetupAdmin();
        if (clearinghouse != address(0)) revert AlreadyBound();
        if (ch == address(0)) revert ZeroAddress();
        clearinghouse = ch;
    }

    function balanceWad() public view returns (uint256) {
        return usdg.balanceOf(address(this)) * _scale;
    }

    function outstandingWad() external view returns (uint256) {
        return _outstanding;
    }

    function cover(uint256 amountWad) external nonReentrant returns (uint256 coveredWad) {
        if (msg.sender != clearinghouse) revert NotClearinghouse();
        uint256 bal = balanceWad();
        uint256 tokenAmt = (amountWad < bal ? amountWad : bal) / _scale;
        if (tokenAmt == 0) return 0; // nothing to pay: no event, nothing outstanding
        coveredWad = tokenAmt * _scale;
        _outstanding += coveredWad;
        emit Covered(amountWad, coveredWad);
        IERC20(address(usdg)).safeTransfer(msg.sender, tokenAmt);
    }

    function notifyRecovered(uint256 amountWad) external nonReentrant {
        if (msg.sender != clearinghouse) revert NotClearinghouse();
        emit Recovered(_reduce(amountWad));
    }

    function notifyWrittenOff(uint256 amountWad) external nonReentrant {
        if (msg.sender != clearinghouse) revert NotClearinghouse();
        emit WrittenOff(_reduce(amountWad));
    }

    function _reduce(uint256 x) private returns (uint256 applied) {
        applied = x < _outstanding ? x : _outstanding;
        _outstanding -= applied;
    }
}
