// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMarketDataHub} from "../interfaces/IMarketDataHub.sol";

interface IQuotingVault {
    function underlying() external view returns (address);
    function isLive() external view returns (bool);
    function quote(uint32 seriesId, uint256 qty, bool takerBuys) external view returns (uint256 premium);
}

/// @notice Read helper that is never deployed: callers run it as a deployless eth_call. Every vault
/// operation first folds the feed's pending rounds into the hub's mark vol (hub.syncVol), so a vault
/// whose stored vol is a few rounds behind still trades, while its quote() view reverts VaultNotLive
/// until someone pokes it. This does the same sync inside the call, then reads the vault's ask and
/// bid for each series. A side the vault refuses comes back as 0 with its revert data.
contract VaultQuoteLens {
    struct SeriesQuote {
        uint256 ask;
        uint256 bid;
        bytes askError;
        bytes bidError;
    }

    function quotes(IMarketDataHub hub, IQuotingVault vault, uint32[] calldata ids, uint256 qty)
        external
        returns (bool live, SeriesQuote[] memory out)
    {
        try hub.syncVol(vault.underlying()) {} catch {}
        live = vault.isLive();
        out = new SeriesQuote[](ids.length);
        for (uint256 i = 0; i < ids.length; ++i) {
            try vault.quote(ids[i], qty, true) returns (uint256 p) {
                out[i].ask = p;
            } catch (bytes memory e) {
                out[i].askError = e;
            }
            try vault.quote(ids[i], qty, false) returns (uint256 p) {
                out[i].bid = p;
            } catch (bytes memory e) {
                out[i].bidError = e;
            }
        }
    }
}
