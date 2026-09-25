// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FixedPointMath as F} from "./FixedPointMath.sol";
import {YEAR} from "../types/Types.sol";

library BlackScholes {
    int256 internal constant WAD_I = 1e18;
    int256 internal constant MIN_SST = 1e6; // below this sigma*sqrt(T), value at forward intrinsic

    /// Sx spot, lnx = ln(Sx/K), sst = sigma*sqrt(T), drift = (r + sigma^2/2)*T, Kd = K*e^{-rT}. Returns >= 0.
    function priceLn(int256 Sx, int256 lnx, int256 sst, int256 drift, int256 Kd, bool isCall)
        internal
        pure
        returns (int256 v)
    {
        if (sst < MIN_SST) {
            v = isCall ? Sx - Kd : Kd - Sx;
            return v > 0 ? v : int256(0);
        }
        int256 d1 = F.divWad(lnx + drift, sst);
        int256 d2 = d1 - sst;
        if (isCall) v = F.mulWad(Sx, F.normCdf(d1)) - F.mulWad(Kd, F.normCdf(d2));
        else v = F.mulWad(Kd, F.normCdf(-d2)) - F.mulWad(Sx, F.normCdf(-d1));
        if (v < 0) v = 0;
    }

    function yearFrac(uint256 tau) internal pure returns (int256) {
        return int256((tau * 1e18) / YEAR);
    }

    function discount(int256 rate, int256 T) internal pure returns (int256) {
        return rate == 0 ? WAD_I : F.expWad(-F.mulWad(rate, T));
    }

    function price(uint256 S, uint256 K, uint256 tau, uint256 vol, int256 rate, bool isCall)
        internal
        pure
        returns (uint256)
    {
        int256 s = int256(S);
        int256 k = int256(K);
        if (tau == 0) {
            int256 iv = isCall ? s - k : k - s;
            return iv > 0 ? uint256(iv) : 0;
        }
        int256 T = yearFrac(tau);
        int256 sqrtT = int256(F.sqrtWad(uint256(T)));
        int256 sig = int256(vol);
        int256 sst = F.mulWad(sig, sqrtT);
        int256 drift = F.mulWad(rate + F.mulWad(sig, sig) / 2, T);
        int256 Kd = F.mulWad(k, discount(rate, T));
        int256 lnx = F.lnWad(F.divWad(s, k));
        return uint256(priceLn(s, lnx, sst, drift, Kd, isCall));
    }

    /// delta (signed), gamma, vega (per 1.0 vol), theta (per year, signed).
    /// When tau == 0 or sst < MIN_SST: delta = +/-1 if in the money else 0, other greeks 0.
    function greeks(uint256 S, uint256 K, uint256 tau, uint256 vol, int256 rate, bool isCall)
        internal
        pure
        returns (int256 delta, uint256 gamma, uint256 vega, int256 theta)
    {
        int256 s = int256(S);
        int256 k = int256(K);
        int256 T = yearFrac(tau);
        int256 sqrtT = int256(F.sqrtWad(uint256(T)));
        int256 sig = int256(vol);
        int256 sst = F.mulWad(sig, sqrtT);
        if (tau == 0 || sst < MIN_SST) {
            bool itm = isCall ? s > k : k > s;
            delta = itm ? (isCall ? WAD_I : -WAD_I) : int256(0);
            return (delta, 0, 0, 0);
        }
        int256 drift = F.mulWad(rate + F.mulWad(sig, sig) / 2, T);
        int256 Kd = F.mulWad(k, discount(rate, T));
        int256 d1 = F.divWad(F.lnWad(F.divWad(s, k)) + drift, sst);
        int256 d2 = d1 - sst;
        int256 pdf1 = F.normPdf(d1);
        delta = isCall ? F.normCdf(d1) : F.normCdf(d1) - WAD_I;
        gamma = uint256(F.divWad(pdf1, F.mulWad(s, sst)));
        vega = uint256(F.mulWad(F.mulWad(s, pdf1), sqrtT));
        int256 decay = -F.divWad(F.mulWad(F.mulWad(s, pdf1), sig), 2 * sqrtT);
        theta = isCall
            ? decay - F.mulWad(F.mulWad(rate, Kd), F.normCdf(d2))
            : decay + F.mulWad(F.mulWad(rate, Kd), F.normCdf(-d2));
    }
}
