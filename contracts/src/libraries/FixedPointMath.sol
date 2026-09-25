// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

library FixedPointMath {
    error ExpOverflow();
    error LnNonPositive();

    int256 internal constant WAD_I = 1e18;
    int256 internal constant LN2 = 693147180559945309; // floor(ln2 * 1e18)
    int256 internal constant SQRT2 = 1414213562373095048; // floor(sqrt2 * 1e18)
    int256 internal constant INV_SQRT_2PI = 398942280401432678; // round(1/sqrt(2pi) * 1e18)
    // Abramowitz-Stegun 26.2.17
    int256 internal constant AS_P = 231641900000000000;
    int256 internal constant AS_B1 = 319381530000000000;
    int256 internal constant AS_B2 = -356563782000000000;
    int256 internal constant AS_B3 = 1781477937000000000;
    int256 internal constant AS_B4 = -1821255978000000000;
    int256 internal constant AS_B5 = 1330274429000000000;

    function mulWad(int256 a, int256 b) internal pure returns (int256) {
        return (a * b) / WAD_I;
    }

    function divWad(int256 a, int256 b) internal pure returns (int256) {
        return (a * WAD_I) / b;
    }

    function mulWadUp(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 p = a * b;
        return p == 0 ? 0 : (p - 1) / 1e18 + 1;
    }

    function divWadUp(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 p = a * 1e18;
        return p == 0 ? 0 : (p - 1) / b + 1;
    }

    /// e^x for WAD x. x = k*ln2 + r with |r| <= ln2/2; Horner Taylor to degree 12.
    function expWad(int256 x) internal pure returns (int256) {
        if (x < -41e18) return 0;
        if (x > 130e18) revert ExpOverflow();
        int256 k = x >= 0 ? (x + LN2 / 2) / LN2 : (x - LN2 / 2) / LN2;
        int256 r = x - k * LN2;
        int256 t = WAD_I;
        for (int256 n = 12; n >= 1; --n) {
            t = WAD_I + mulWad(r, t) / n;
        }
        return k >= 0 ? t << uint256(k) : t >> uint256(-k);
    }

    /// ln(x) for WAD x > 0.
    /// Normalize: find k with WAD <= m < 2*WAD where m = x >> k (k >= 0, floor) or m = x << -k (k < 0).
    /// If m > SQRT2 then m = m / 2 (truncating) and k += 1.
    /// z = divWad(m - WAD, m + WAD); ln m = 2 * mulWad(z, s), s = 1 + z^2/3 + ... + z^18/19 (Horner, below).
    function lnWad(int256 x) internal pure returns (int256) {
        if (x <= 0) revert LnNonPositive();
        int256 k = 0;
        int256 m = x;
        while (m >= 2 * WAD_I) {
            k++;
            m = x >> uint256(k);
        }
        while (m < WAD_I) {
            k--;
            m = x << uint256(-k);
        }
        if (m > SQRT2) {
            m = m / 2;
            k += 1;
        }
        int256 z = divWad(m - WAD_I, m + WAD_I);
        int256 z2 = mulWad(z, z);
        int256 s = WAD_I / 19;
        for (int256 n = 17; n >= 1; n -= 2) {
            s = WAD_I / n + mulWad(z2, s);
        }
        return k * LN2 + 2 * mulWad(z, s);
    }

    /// floor(sqrt(x * 1e18)), exact.
    function sqrtWad(uint256 x) internal pure returns (uint256) {
        return _isqrt(x * 1e18);
    }

    function _isqrt(uint256 n) private pure returns (uint256 r) {
        if (n == 0) return 0;
        r = n;
        uint256 y = (n + 1) / 2;
        while (y < r) {
            r = y;
            y = (n / y + y) / 2;
        }
    }

    function normPdf(int256 x) internal pure returns (int256) {
        return mulWad(INV_SQRT_2PI, expWad(-mulWad(x, x) / 2));
    }

    /// Standard normal CDF, A&S 26.2.17 (|err| < 7.5e-8).
    function normCdf(int256 x) internal pure returns (int256) {
        if (x >= 8e18) return WAD_I;
        if (x <= -8e18) return 0;
        int256 ax = x >= 0 ? x : -x;
        int256 t = divWad(WAD_I, WAD_I + mulWad(AS_P, ax));
        int256 poly = AS_B5;
        poly = AS_B4 + mulWad(t, poly);
        poly = AS_B3 + mulWad(t, poly);
        poly = AS_B2 + mulWad(t, poly);
        poly = AS_B1 + mulWad(t, poly);
        poly = mulWad(t, poly);
        int256 tail = mulWad(normPdf(ax), poly);
        return x >= 0 ? WAD_I - tail : tail;
    }
}
