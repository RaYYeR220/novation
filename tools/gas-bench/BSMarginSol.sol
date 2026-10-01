// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// WAD fixed-point Black-Scholes + 39-scenario portfolio-margin kernel.
/// Same constants and rounding as the production kernel (every a*b/WAD and a*WAD/b truncates
/// toward zero), so both return identical integers. The short-option minimum is not computed here.
/// All arithmetic is `unchecked` after input bounds are validated (|values| <= 1e27, |qty| <= 1e26,
/// so every intermediate product stays far below 2^255). No inline assembly.
contract BSMarginSol {
    struct Position {
        uint256 strike;
        uint64 expiry;
        bool isCall;
        int256 qty;
    }

    struct Underlying {
        uint256 spot;
        uint256 vol;
        int256 spotQty;
        uint256 beta;
    }

    struct PositionM {
        uint8 und;
        uint256 strike;
        uint64 expiry;
        bool isCall;
        int256 qty;
    }

    error Range();

    int256 internal constant WAD = 1e18;
    int256 internal constant LN2 = 693147180559945309;
    int256 internal constant HALF_LN2 = 346573590279972654;
    int256 internal constant SQRT2 = 1414213562373095048;
    int256 internal constant INV_SQRT_2PI = 398942280401432678;
    int256 internal constant YEAR = 31536000;

    int256 internal constant AS_P = 231641900000000000;
    int256 internal constant AS_B1 = 319381530000000000;
    int256 internal constant AS_B2 = -356563782000000000;
    int256 internal constant AS_B3 = 1781477937000000000;
    int256 internal constant AS_B4 = -1821255978000000000;
    int256 internal constant AS_B5 = 1330274429000000000;

    uint256 internal constant NS = 13;
    uint256 internal constant NV = 3;
    uint256 internal constant NSCEN = 39;
    uint256 internal constant BASE = 19;

    int256 internal constant MAX_PRICE = 1e27;
    int256 internal constant MAX_QTY = 1e26;
    int256 internal constant MAX_VOL = 10e18;
    int256 internal constant MAX_RATE = 1e18;
    uint256 internal constant MAX_TAU_SECS = 10 * 31536000;

    function ping() external pure returns (uint256) {
        return 1;
    }

    // ---------------- fixed-point primitives ----------------

    function _exp(int256 x) internal pure returns (int256) {
        unchecked {
            if (x < -42 * WAD) return 0;
            if (x > 40 * WAD) revert Range();
            int256 k = x >= 0 ? (x + HALF_LN2) / LN2 : (x - HALF_LN2) / LN2;
            int256 r = x - k * LN2;
            int256 acc = 25052108385;
            acc = 275573192240 + acc * r / WAD;
            acc = 2755731922399 + acc * r / WAD;
            acc = 24801587301587 + acc * r / WAD;
            acc = 198412698412698 + acc * r / WAD;
            acc = 1388888888888889 + acc * r / WAD;
            acc = 8333333333333333 + acc * r / WAD;
            acc = 41666666666666667 + acc * r / WAD;
            acc = 166666666666666667 + acc * r / WAD;
            acc = 500000000000000000 + acc * r / WAD;
            acc = 1000000000000000000 + acc * r / WAD;
            acc = 1000000000000000000 + acc * r / WAD;
            return k >= 0 ? acc << uint256(k) : acc >> uint256(-k);
        }
    }

    function _ln(int256 x) internal pure returns (int256) {
        unchecked {
            if (x <= 0) revert Range();
            int256 m = x;
            int256 k = 0;
            while (m >= 2 * WAD) {
                m >>= 1;
                k++;
            }
            while (m < WAD) {
                m <<= 1;
                k--;
            }
            int256 z;
            if (m >= SQRT2) {
                k++;
                z = (m - 2 * WAD) * WAD / (m + 2 * WAD);
            } else {
                z = (m - WAD) * WAD / (m + WAD);
            }
            int256 z2 = z * z / WAD;
            int256 acc = 58823529411764706;
            acc = 66666666666666667 + acc * z2 / WAD;
            acc = 76923076923076923 + acc * z2 / WAD;
            acc = 90909090909090909 + acc * z2 / WAD;
            acc = 111111111111111111 + acc * z2 / WAD;
            acc = 142857142857142857 + acc * z2 / WAD;
            acc = 200000000000000000 + acc * z2 / WAD;
            acc = 333333333333333333 + acc * z2 / WAD;
            acc = 1000000000000000000 + acc * z2 / WAD;
            return k * LN2 + 2 * (z * acc / WAD);
        }
    }

    function _sqrt(uint256 n) internal pure returns (uint256 x) {
        unchecked {
            if (n == 0) return 0;
            uint256 b = 0;
            uint256 t = n;
            if (t >= 1 << 128) { t >>= 128; b += 128; }
            if (t >= 1 << 64) { t >>= 64; b += 64; }
            if (t >= 1 << 32) { t >>= 32; b += 32; }
            if (t >= 1 << 16) { t >>= 16; b += 16; }
            if (t >= 1 << 8) { t >>= 8; b += 8; }
            if (t >= 1 << 4) { t >>= 4; b += 4; }
            if (t >= 1 << 2) { t >>= 2; b += 2; }
            if (t >= 1 << 1) { b += 1; }
            // bitlen = b + 1 ; x0 = 2^ceil(bitlen/2) >= sqrt(n)
            x = 1 << ((b + 2) / 2);
            while (true) {
                uint256 y = (x + n / x) >> 1;
                if (y >= x) return x;
                x = y;
            }
        }
    }

    /// Standard normal CDF, Abramowitz & Stegun 26.2.17
    function _ncdf(int256 x) internal pure returns (int256) {
        unchecked {
            int256 ax = x < 0 ? -x : x;
            int256 q = 0;
            if (ax < 9 * WAD) {
                int256 t = WAD * WAD / (WAD + AS_P * ax / WAD);
                int256 poly = AS_B5;
                poly = AS_B4 + poly * t / WAD;
                poly = AS_B3 + poly * t / WAD;
                poly = AS_B2 + poly * t / WAD;
                poly = AS_B1 + poly * t / WAD;
                poly = poly * t / WAD;
                int256 phi = _exp(-(ax * ax / WAD / 2)) * INV_SQRT_2PI / WAD;
                q = phi * poly / WAD;
            }
            return x >= 0 ? WAD - q : q;
        }
    }

    function _pricePre(int256 s, int256 kdf, int256 a, int256 sigt, bool isCall) internal pure returns (int256 p) {
        unchecked {
            if (sigt <= 0) {
                p = isCall ? s - kdf : kdf - s;
            } else {
                int256 d1 = a * WAD / sigt;
                int256 d2 = d1 - sigt;
                int256 n1 = _ncdf(d1);
                int256 n2 = _ncdf(d2);
                if (isCall) {
                    p = s * n1 / WAD - kdf * n2 / WAD;
                } else {
                    p = kdf * (WAD - n2) / WAD - s * (WAD - n1) / WAD;
                }
            }
            if (p < 0) p = 0;
        }
    }

    function _bs(int256 s, int256 k, int256 t, int256 sigma, int256 r, bool isCall) internal pure returns (int256) {
        unchecked {
            if (t <= 0) {
                int256 p = isCall ? s - k : k - s;
                return p > 0 ? p : int256(0);
            }
            int256 sqrtT = int256(_sqrt(uint256(t * WAD)));
            int256 rt = r * t / WAD;
            int256 kdf = k * _exp(-rt) / WAD;
            int256 lnsk = _ln(s * WAD / k);
            int256 sigt = sigma * sqrtT / WAD;
            int256 a = lnsk + rt + sigt * sigt / WAD / 2;
            return _pricePre(s, kdf, a, sigt, isCall);
        }
    }

    // ---------------- input validation ----------------

    function _u(uint256 x, int256 max) internal pure returns (int256) {
        if (x > uint256(max)) revert Range();
        return int256(x);
    }

    function _s(int256 x, int256 max) internal pure returns (int256) {
        if (x > max || x < -max) revert Range();
        return x;
    }

    // ---------------- public API ----------------

    function bsPrice(uint256 s, uint256 k, uint256 t, uint256 sigma, int256 r, bool isCall)
        external
        pure
        returns (uint256)
    {
        int256 S = _u(s, MAX_PRICE);
        int256 K = _u(k, MAX_PRICE);
        int256 T = _u(t, 10 * WAD);
        int256 V = _u(sigma, MAX_VOL);
        int256 R = _s(r, MAX_RATE);
        if (S == 0 || K == 0) revert Range();
        return uint256(_bs(S, K, T, V, R, isCall));
    }

    struct Ctx {
        int256 spot;
        int256 vol;
        int256 rate;
        uint256 nowTs;
    }

    /// Reprice one position over the 39-scenario grid; val[off + v*13 + j] += qty * price
    function _accumulate(
        Ctx memory c,
        int256 k,
        uint256 expiry,
        bool isCall,
        int256 qty,
        int256[13] memory sj,
        int256[13] memory lnsh,
        int256[] memory val,
        uint256 off
    ) internal pure {
        unchecked {
            if (k == 0) revert Range();
            if (expiry <= c.nowTs) {
                for (uint256 j = 0; j < NS; j++) {
                    int256 intr = isCall ? sj[j] - k : k - sj[j];
                    int256 cc = intr > 0 ? qty * intr / WAD : int256(0);
                    val[off + j] += cc;
                    val[off + NS + j] += cc;
                    val[off + 2 * NS + j] += cc;
                }
                return;
            }
            if (expiry - c.nowTs > MAX_TAU_SECS) revert Range();
            int256 tau = int256(expiry - c.nowTs) * WAD / YEAR;
            int256 sqrtTau = int256(_sqrt(uint256(tau * WAD)));
            int256 rt = c.rate * tau / WAD;
            int256 kdf = k * _exp(-rt) / WAD;
            int256 lnsk = _ln(c.spot * WAD / k);
            int256 sigt = c.vol * sqrtTau / WAD;
            for (uint256 v = 0; v < NV; v++) {
                int256 volm = v == 0 ? int256(0.7e18) : (v == 1 ? int256(1e18) : int256(1.4e18));
                int256 sigtv = sigt * volm / WAD;
                int256 a = lnsk + rt + sigtv * sigtv / WAD / 2;
                uint256 base = off + v * NS;
                for (uint256 j = 0; j < NS; j++) {
                    int256 pr = _pricePre(sj[j], kdf, a + lnsh[j], sigtv, isCall);
                    val[base + j] += qty * pr / WAD;
                }
            }
        }
    }

    function _shocks() internal pure returns (int256[13] memory s) {
        s = [
            int256(-0.30e18), -0.25e18, -0.20e18, -0.15e18, -0.10e18, -0.05e18, 0,
            0.05e18, 0.10e18, 0.15e18, 0.20e18, 0.25e18, 0.30e18
        ];
    }

    function _lnShocks() internal pure returns (int256[13] memory s) {
        s = [
            int256(-356674943938732379), -287682072451780927, -223143551314209756, -162518929497774913,
            -105360515657826301, -51293294387550533, 0, 48790164169432003, 95310179804324860,
            139761942375158697, 182321556793954626, 223143551314209756, 262364264467491052
        ];
    }

    function worstLoss(
        Position[] calldata positions,
        int256 spotQty,
        uint256 spot,
        uint256 vol,
        uint256 nowTs,
        int256 rate
    ) external pure returns (int256 worst, uint256 idx) {
        Ctx memory c;
        c.spot = _u(spot, MAX_PRICE);
        c.vol = _u(vol, MAX_VOL);
        c.rate = _s(rate, MAX_RATE);
        if (nowTs > type(uint64).max) revert Range();
        c.nowTs = nowTs;
        int256 sq = _s(spotQty, MAX_QTY);
        if (c.spot == 0) revert Range();
        int256[13] memory sh = _shocks();
        int256[13] memory lnsh = _lnShocks();
        int256[13] memory sj;
        unchecked {
            for (uint256 j = 0; j < NS; j++) {
                sj[j] = c.spot * (WAD + sh[j]) / WAD;
            }
        }
        int256[] memory val = new int256[](NSCEN);
        uint256 n = positions.length;
        for (uint256 i = 0; i < n; i++) {
            Position calldata p = positions[i];
            _accumulate(c, _u(p.strike, MAX_PRICE), p.expiry, p.isCall, _s(p.qty, MAX_QTY), sj, lnsh, val, 0);
        }
        unchecked {
            int256 b = val[BASE];
            worst = type(int256).max;
            for (uint256 s = 0; s < NSCEN; s++) {
                uint256 j = s % NS;
                int256 pnl = val[s] - b + sq * (sj[j] - c.spot) / WAD;
                if (pnl < worst) {
                    worst = pnl;
                    idx = s;
                }
            }
        }
    }

    /// Multi-underlying; underlying u is shocked by beta_u * SHOCK[j] (correlated regime).
    /// Returns worst correlated portfolio PnL, its scenario index, and the undiversified
    /// sum of per-underlying worst PnLs.
    function worstLossMulti(
        Underlying[] calldata unds,
        PositionM[] calldata positions,
        uint256 nowTs,
        int256 rate
    ) external pure returns (int256 worst, uint256 idx, int256 undiv) {
        uint256 nu = unds.length;
        if (nu == 0 || nu > 16) revert Range();
        if (nowTs > type(uint64).max) revert Range();
        Ctx[] memory cs = new Ctx[](nu);
        int256[13][] memory sj = new int256[13][](nu);
        int256[13][] memory lnsh = new int256[13][](nu);
        int256[] memory sq = new int256[](nu);
        int256[13] memory sh = _shocks();
        int256 r = _s(rate, MAX_RATE);
        for (uint256 u = 0; u < nu; u++) {
            Underlying calldata U = unds[u];
            Ctx memory c = cs[u];
            c.spot = _u(U.spot, MAX_PRICE);
            c.vol = _u(U.vol, MAX_VOL);
            c.rate = r;
            c.nowTs = nowTs;
            sq[u] = _s(U.spotQty, MAX_QTY);
            int256 beta = _u(U.beta, 3 * WAD);
            if (c.spot == 0 || beta == 0) revert Range();
            unchecked {
                for (uint256 j = 0; j < NS; j++) {
                    int256 f = WAD + beta * sh[j] / WAD;
                    sj[u][j] = c.spot * f / WAD;
                    lnsh[u][j] = _ln(f);
                }
            }
        }
        int256[] memory val = new int256[](nu * NSCEN);
        uint256 n = positions.length;
        for (uint256 i = 0; i < n; i++) {
            PositionM calldata p = positions[i];
            uint256 u = p.und;
            if (u >= nu) revert Range();
            _accumulate(cs[u], _u(p.strike, MAX_PRICE), p.expiry, p.isCall, _s(p.qty, MAX_QTY), sj[u], lnsh[u], val, u * NSCEN);
        }
        unchecked {
            int256[39] memory total;
            for (uint256 u = 0; u < nu; u++) {
                uint256 o = u * NSCEN;
                int256 b = val[o + BASE];
                int256 wu = type(int256).max;
                for (uint256 s = 0; s < NSCEN; s++) {
                    uint256 j = s % NS;
                    int256 pnl = val[o + s] - b + sq[u] * (sj[u][j] - cs[u].spot) / WAD;
                    total[s] += pnl;
                    if (pnl < wu) wu = pnl;
                }
                undiv += wu;
            }
            worst = type(int256).max;
            for (uint256 s = 0; s < NSCEN; s++) {
                if (total[s] < worst) {
                    worst = total[s];
                    idx = s;
                }
            }
        }
    }
}
