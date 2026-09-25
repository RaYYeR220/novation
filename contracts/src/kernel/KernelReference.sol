// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {IRiskKernel} from "../interfaces/IRiskKernel.sol";
import {KParams, KUnderlying, KPosition, KMarginOut, SCENARIOS, PRICE_POINTS, VOL_POINTS, YEAR} from "../types/Types.sol";
import {FixedPointMath as F} from "../libraries/FixedPointMath.sol";
import {BlackScholes as BS} from "../libraries/BlackScholes.sol";

contract KernelReference is IRiskKernel {
    error BadUnderlyingIndex();
    error BadShockRange();
    error LengthMismatch();

    int256 internal constant WAD_I = 1e18;

    /// pnl is laid out [u * 39 + v * 13 + j]; scenario s = v * 13 + j; price move m_j = (j - 6) * R / 6.
    function _grid(KParams calldata p, KUnderlying[] calldata us, KPosition[] calldata ps)
        internal pure returns (int256[] memory pnl, int256 mtm, uint256 shortMin)
    {
        uint256 nu = us.length;
        pnl = new int256[](nu * SCENARIOS);
        int256[] memory Sj = new int256[](nu * PRICE_POINTS);
        int256[] memory lnSh = new int256[](nu * PRICE_POINTS);
        int256[] memory vols = new int256[](nu * VOL_POINTS);
        for (uint256 u = 0; u < nu; ++u) {
            KUnderlying calldata U = us[u];
            if (U.shockRange > 0.9e18 || U.volDown >= 1e18) revert BadShockRange();
            int256 S = int256(U.spot);
            int256 R = int256(U.shockRange);
            for (uint256 j = 0; j < PRICE_POINTS; ++j) {
                int256 m = ((int256(j) - 6) * R) / 6;
                Sj[u * PRICE_POINTS + j] = F.mulWad(S, WAD_I + m);
                lnSh[u * PRICE_POINTS + j] = F.lnWad(WAD_I + m);
            }
            int256 v = int256(U.vol);
            vols[u * VOL_POINTS] = F.mulWad(v, WAD_I - int256(U.volDown));
            vols[u * VOL_POINTS + 1] = v;
            vols[u * VOL_POINTS + 2] = F.mulWad(v, WAD_I + int256(U.volUp));
            mtm += F.mulWad(U.tokenQty, S);
            for (uint256 s = 0; s < SCENARIOS; ++s) {
                pnl[u * SCENARIOS + s] += F.mulWad(U.tokenQty, Sj[u * PRICE_POINTS + (s % PRICE_POINTS)] - S);
            }
        }
        for (uint256 i = 0; i < ps.length; ++i) {
            KPosition calldata P = ps[i];
            if (P.u >= nu) revert BadUnderlyingIndex();
            int256 S = int256(us[P.u].spot);
            int256 K = int256(P.strike);
            int256 qty = P.qty;
            if (qty < 0) shortMin += F.mulWadUp(uint256(-qty), F.mulWadUp(uint256(S), p.shortOptionMinPct));
            uint256 tau = P.expiry > p.nowTs ? P.expiry - p.nowTs : 0;
            if (tau == 0) {
                int256 markI = P.isCall ? S - K : K - S;
                if (markI < 0) markI = 0;
                mtm += F.mulWad(qty, markI);
                for (uint256 s = 0; s < SCENARIOS; ++s) {
                    int256 Sx = Sj[P.u * PRICE_POINTS + (s % PRICE_POINTS)];
                    int256 iv = P.isCall ? Sx - K : K - Sx;
                    if (iv < 0) iv = 0;
                    pnl[P.u * SCENARIOS + s] += F.mulWad(qty, iv - markI);
                }
                continue;
            }
            int256 T = BS.yearFrac(tau);
            int256 sqrtT = int256(F.sqrtWad(uint256(T)));
            int256 lnSK = F.lnWad(F.divWad(S, K));
            int256 Kd = F.mulWad(K, BS.discount(p.rate, T));
            int256 mark;
            {
                int256 sig = vols[P.u * VOL_POINTS + 1];
                int256 sst = F.mulWad(sig, sqrtT);
                int256 drift = F.mulWad(p.rate + F.mulWad(sig, sig) / 2, T);
                mark = BS.priceLn(Sj[P.u * PRICE_POINTS + 6], lnSK + lnSh[P.u * PRICE_POINTS + 6], sst, drift, Kd, P.isCall);
            }
            mtm += F.mulWad(qty, mark);
            for (uint256 vi = 0; vi < VOL_POINTS; ++vi) {
                int256 sig = vols[P.u * VOL_POINTS + vi];
                int256 sst = F.mulWad(sig, sqrtT);
                int256 drift = F.mulWad(p.rate + F.mulWad(sig, sig) / 2, T);
                for (uint256 j = 0; j < PRICE_POINTS; ++j) {
                    int256 px = BS.priceLn(Sj[P.u * PRICE_POINTS + j], lnSK + lnSh[P.u * PRICE_POINTS + j], sst, drift, Kd, P.isCall);
                    pnl[P.u * SCENARIOS + vi * PRICE_POINTS + j] += F.mulWad(qty, px - mark);
                }
            }
        }
    }

    function margin(KParams calldata p, KUnderlying[] calldata us, KPosition[] calldata ps)
        external pure returns (KMarginOut memory out, int256[] memory perUnderlyingWorst)
    {
        (int256[] memory pnl, int256 mtm, uint256 shortMin) = _grid(p, us, ps);
        uint256 nu = us.length;
        perUnderlyingWorst = new int256[](nu);
        int256 minSum = 0;
        uint256 worst = 0;
        if (nu > 0) {
            minSum = type(int256).max;
            for (uint256 s = 0; s < SCENARIOS; ++s) {
                int256 sum = 0;
                for (uint256 u = 0; u < nu; ++u) sum += pnl[u * SCENARIOS + s];
                if (sum < minSum) { minSum = sum; worst = s; }
            }
        }
        uint256 lossIndep = 0;
        for (uint256 u = 0; u < nu; ++u) {
            int256 mn = type(int256).max;
            for (uint256 s = 0; s < SCENARIOS; ++s) {
                int256 x = pnl[u * SCENARIOS + s];
                if (x < mn) mn = x;
            }
            perUnderlyingWorst[u] = mn;
            if (mn < 0) lossIndep += uint256(-mn);
        }
        uint256 lossCorr = minSum < 0 ? uint256(-minSum) : 0;
        uint256 indepAdj = uint256(F.mulWad(int256(lossIndep), WAD_I - int256(p.diversificationCredit)));
        uint256 base = lossCorr > indepAdj ? lossCorr : indepAdj;
        out = KMarginOut({
            mtm: mtm, lossIM: base + shortMin, lossCorr: lossCorr, lossIndep: lossIndep,
            shortMin: shortMin, worstScenario: worst
        });
    }

    function scenarioGrid(KParams calldata p, KUnderlying[] calldata us, KPosition[] calldata ps)
        external pure returns (int256[] memory out)
    {
        (int256[] memory pnl,,) = _grid(p, us, ps);
        out = new int256[](SCENARIOS);
        for (uint256 s = 0; s < SCENARIOS; ++s) {
            for (uint256 u = 0; u < us.length; ++u) out[s] += pnl[u * SCENARIOS + s];
        }
    }

    function bsQuote(uint256 spot, uint256 strike, uint256 tau, uint256 vol, int256 rate, bool isCall)
        external pure returns (uint256 price, int256 delta, uint256 gamma, uint256 vega, int256 theta)
    {
        price = BS.price(spot, strike, tau, vol, rate, isCall);
        (delta, gamma, vega, theta) = BS.greeks(spot, strike, tau, vol, rate, isCall);
    }

    /// EWMA ratio estimator. r2 <- l*r2 + (1-l)*ln(p_i/p_{i-1})^2 ; dt <- l*dt + (1-l)*dt_i(years).
    /// A zero dt only advances the last price.
    function ewmaUpdate(uint256 prevR2, uint256 prevDt, uint256 lastPrice, uint256[] calldata prices,
        uint256[] calldata dts, uint256 lambda) external pure returns (uint256 r2, uint256 dt)
    {
        if (prices.length != dts.length) revert LengthMismatch();
        int256 a = int256(prevR2);
        int256 b = int256(prevDt);
        int256 last = int256(lastPrice);
        int256 l = int256(lambda);
        for (uint256 i = 0; i < prices.length; ++i) {
            int256 px = int256(prices[i]);
            if (dts[i] == 0) { last = px; continue; }
            int256 r = F.lnWad(F.divWad(px, last));
            int256 dtY = int256((dts[i] * 1e18) / YEAR);
            a = F.mulWad(l, a) + F.mulWad(WAD_I - l, F.mulWad(r, r));
            b = F.mulWad(l, b) + F.mulWad(WAD_I - l, dtY);
            last = px;
        }
        return (uint256(a), uint256(b));
    }
}
