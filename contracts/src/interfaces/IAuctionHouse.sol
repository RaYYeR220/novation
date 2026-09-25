// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
interface IAuctionHouse {
    event LiquidationStarted(uint256 indexed id, uint64 startedAt);
    event LiquidationBid(uint256 indexed id, uint256 indexed bidderId, uint256 fractionWad, int256 paidWad, uint256 discountWad);
    event LiquidationEnded(uint256 indexed id);
    event DeficitSaleStarted(uint256 indexed id, uint64 indexed expiry, uint64 startedAt);
    event DeficitBid(uint256 indexed id, uint256 indexed bidderId, address token, uint256 tokenWad, uint256 paidWad);

    function startLiquidation(uint256 id) external;
    function bidLiquidation(uint256 id, uint256 fractionWad, uint256 bidderId, int256 maxPayWad) external returns (int256 paidWad);
    function startDeficitSale(uint256 id, uint64 expiry) external; // clearinghouse only
    function bidDeficit(uint256 id, uint64 expiry, address token, uint256 tokenWad, uint256 bidderId, uint256 maxPayWad) external returns (uint256 paidWad);
    function liquidationDiscount(uint256 id) external view returns (uint256 discountWad, bool active);
    function deficitDiscount(uint256 id, uint64 expiry) external view returns (uint256 discountWad, bool active);
}
