// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IScaledUiAmount} from "../interfaces/IScaledUiAmount.sol";

/// @notice Test-only stock token: ERC-20 plus the rebasing-UI and pause surface
/// MarketDataHub reads for session halts.
contract MockStockToken is ERC20, IScaledUiAmount {
    uint256 private _uiMultiplier = 1e18;
    uint256 private _newUiMultiplier = 1e18;
    uint256 private _effectiveAt;
    bool private _paused;
    bool private _tokenPaused;
    bool private _oraclePaused;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setUiMultiplier(uint256 cur, uint256 next, uint256 effectiveAt_) external {
        _uiMultiplier = cur;
        _newUiMultiplier = next;
        _effectiveAt = effectiveAt_;
    }

    function setPaused(bool p) external {
        _paused = p;
    }

    function setTokenPaused(bool p) external {
        _tokenPaused = p;
    }

    function setOraclePaused(bool p) external {
        _oraclePaused = p;
    }

    function uiMultiplier() external view returns (uint256) {
        return _uiMultiplier;
    }

    function newUIMultiplier() external view returns (uint256) {
        return _newUiMultiplier;
    }

    function effectiveAt() external view returns (uint256) {
        return _effectiveAt;
    }

    function paused() external view returns (bool) {
        return _paused;
    }

    function tokenPaused() external view returns (bool) {
        return _tokenPaused;
    }

    function oraclePaused() external view returns (bool) {
        return _oraclePaused;
    }
}
