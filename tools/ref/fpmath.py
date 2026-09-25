"""Bit-exact Python reference for FixedPointMath.sol and BlackScholes.sol.

Every function here reproduces, operation for operation, the corresponding
Solidity function so that the two integer outputs are IDENTICAL for the same
inputs. In particular:

  - Solidity's signed `/` truncates toward zero. Python's `//` floors toward
    negative infinity, so every signed division in this file goes through
    `tdiv(a, b)` instead of `//`.
  - Solidity's `<<` / `>>` on `int256` here are only ever applied to
    non-negative shift amounts and non-negative operands (checked with
    asserts), matching the Solidity source, which casts the shift amount to
    `uint256` and only shifts values known to be representable.
  - Solidity's checked arithmetic reverts on int256/uint256 overflow. This
    module does not re-implement overflow checks; callers (gen_vectors.py)
    are responsible for keeping vector inputs within range so nothing here
    would have overflowed in Solidity.
"""

import math

WAD = 10**18
WAD_I = 10**18

INT256_MIN = -(2**255)
INT256_MAX = 2**255 - 1
UINT256_MAX = 2**256 - 1

LN2 = 693147180559945309  # floor(ln2 * 1e18)
SQRT2 = 1414213562373095048  # floor(sqrt2 * 1e18)
INV_SQRT_2PI = 398942280401432678  # round(1/sqrt(2pi) * 1e18)

# Abramowitz-Stegun 26.2.17
AS_P = 231641900000000000
AS_B1 = 319381530000000000
AS_B2 = -356563782000000000
AS_B3 = 1781477937000000000
AS_B4 = -1821255978000000000
AS_B5 = 1330274429000000000

MIN_SST = 1_000_000  # 1e6

YEAR = 31_536_000


class ExpOverflow(Exception):
    pass


class LnNonPositive(Exception):
    pass


def tdiv(a: int, b: int) -> int:
    """Truncating (toward zero) integer division, matching Solidity's `/`."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def _check_int256(v: int) -> int:
    assert INT256_MIN <= v <= INT256_MAX, f"int256 overflow: {v}"
    return v


def _check_uint256(v: int) -> int:
    assert 0 <= v <= UINT256_MAX, f"uint256 overflow: {v}"
    return v


def mulWad(a: int, b: int) -> int:
    return _check_int256(tdiv(a * b, WAD_I))


def divWad(a: int, b: int) -> int:
    return _check_int256(tdiv(a * WAD_I, b))


def mulWadUp(a: int, b: int) -> int:
    p = _check_uint256(a * b)
    return 0 if p == 0 else (p - 1) // 10**18 + 1


def divWadUp(a: int, b: int) -> int:
    p = _check_uint256(a * 10**18)
    return 0 if p == 0 else (p - 1) // b + 1


def expWad(x: int) -> int:
    if x < -41 * WAD_I:
        return 0
    if x > 130 * WAD_I:
        raise ExpOverflow()
    k = tdiv(x + LN2 // 2, LN2) if x >= 0 else tdiv(x - LN2 // 2, LN2)
    r = x - k * LN2
    t = WAD_I
    for n in range(12, 0, -1):
        t = WAD_I + tdiv(mulWad(r, t), n)
    if k >= 0:
        assert t >= 0
        return _check_int256(t << k)
    else:
        assert t >= 0
        return t >> (-k)


def lnWad(x: int) -> int:
    if x <= 0:
        raise LnNonPositive()
    k = 0
    m = x
    while m >= 2 * WAD_I:
        k += 1
        assert x >= 0
        m = x >> k
    while m < WAD_I:
        k -= 1
        assert m >= 0
        m = x << (-k)
    if m > SQRT2:
        m = tdiv(m, 2)
        k += 1
    z = divWad(m - WAD_I, m + WAD_I)
    z2 = mulWad(z, z)
    s = tdiv(WAD_I, 19)
    for n in range(17, 0, -2):
        s = tdiv(WAD_I, n) + mulWad(z2, s)
    return k * LN2 + 2 * mulWad(z, s)


def _isqrt(n: int) -> int:
    if n == 0:
        return 0
    r = n
    y = (n + 1) // 2
    while y < r:
        r = y
        y = (n // y + y) // 2
    return r


def sqrtWad(x: int) -> int:
    return _check_uint256(_isqrt(_check_uint256(x * 10**18)))


def normPdf(x: int) -> int:
    return mulWad(INV_SQRT_2PI, expWad(tdiv(-mulWad(x, x), 2)))


def normCdf(x: int) -> int:
    if x >= 8 * WAD_I:
        return WAD_I
    if x <= -8 * WAD_I:
        return 0
    ax = x if x >= 0 else -x
    t = divWad(WAD_I, WAD_I + mulWad(AS_P, ax))
    poly = AS_B5
    poly = AS_B4 + mulWad(t, poly)
    poly = AS_B3 + mulWad(t, poly)
    poly = AS_B2 + mulWad(t, poly)
    poly = AS_B1 + mulWad(t, poly)
    poly = mulWad(t, poly)
    tail = mulWad(normPdf(ax), poly)
    return WAD_I - tail if x >= 0 else tail


# ---------------------------------------------------------------------------
# BlackScholes.sol
# ---------------------------------------------------------------------------


def priceLn(Sx: int, lnx: int, sst: int, drift: int, Kd: int, is_call: bool) -> int:
    if sst < MIN_SST:
        v = Sx - Kd if is_call else Kd - Sx
        return v if v > 0 else 0
    d1 = divWad(lnx + drift, sst)
    d2 = d1 - sst
    if is_call:
        v = mulWad(Sx, normCdf(d1)) - mulWad(Kd, normCdf(d2))
    else:
        v = mulWad(Kd, normCdf(-d2)) - mulWad(Sx, normCdf(-d1))
    if v < 0:
        v = 0
    return v


def yearFrac(tau: int) -> int:
    return _check_int256(tdiv(tau * 10**18, YEAR))


def discount(rate: int, T: int) -> int:
    return WAD_I if rate == 0 else expWad(-mulWad(rate, T))


def price(S: int, K: int, tau: int, vol: int, rate: int, is_call: bool) -> int:
    s = S
    k = K
    if tau == 0:
        iv = s - k if is_call else k - s
        return iv if iv > 0 else 0
    T = yearFrac(tau)
    sqrtT = sqrtWad(T)
    sig = vol
    sst = mulWad(sig, sqrtT)
    drift = mulWad(rate + tdiv(mulWad(sig, sig), 2), T)
    Kd = mulWad(k, discount(rate, T))
    lnx = lnWad(divWad(s, k))
    return _check_uint256(priceLn(s, lnx, sst, drift, Kd, is_call))


def greeks(S: int, K: int, tau: int, vol: int, rate: int, is_call: bool):
    s = S
    k = K
    T = yearFrac(tau)
    sqrtT = sqrtWad(T)
    sig = vol
    sst = mulWad(sig, sqrtT)
    if tau == 0 or sst < MIN_SST:
        itm = s > k if is_call else k > s
        delta = (WAD_I if is_call else -WAD_I) if itm else 0
        return delta, 0, 0, 0
    drift = mulWad(rate + tdiv(mulWad(sig, sig), 2), T)
    Kd = mulWad(k, discount(rate, T))
    d1 = divWad(lnWad(divWad(s, k)) + drift, sst)
    d2 = d1 - sst
    pdf1 = normPdf(d1)
    delta = normCdf(d1) if is_call else normCdf(d1) - WAD_I
    gamma = divWad(pdf1, mulWad(s, sst))
    vega = mulWad(mulWad(s, pdf1), sqrtT)
    decay = -divWad(mulWad(mulWad(s, pdf1), sig), 2 * sqrtT)
    if is_call:
        theta = decay - mulWad(mulWad(rate, Kd), normCdf(d2))
    else:
        theta = decay + mulWad(mulWad(rate, Kd), normCdf(-d2))
    return delta, _check_uint256(gamma), _check_uint256(vega), theta


# ---------------------------------------------------------------------------
# Float reference (for accuracy checks only, not bit-exact)
# ---------------------------------------------------------------------------


def float_price(S: float, K: float, tau: float, vol: float, r: float, is_call: bool) -> float:
    """Black-Scholes price using math.erf, all inputs already WAD-scaled floats."""
    s = S / 1e18
    k = K / 1e18
    T = tau / YEAR
    sigma = vol / 1e18
    rate = r / 1e18
    if tau == 0:
        iv = (s - k) if is_call else (k - s)
        return max(iv, 0.0) * 1e18
    if T <= 0:
        iv = (s - k) if is_call else (k - s)
        return max(iv, 0.0) * 1e18
    sst = sigma * math.sqrt(T)
    if sst < MIN_SST / 1e18:
        Kd = k * math.exp(-rate * T)
        iv = (s - Kd) if is_call else (Kd - s)
        return max(iv, 0.0) * 1e18

    def norm_cdf(x: float) -> float:
        return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))

    d1 = (math.log(s / k) + (rate + 0.5 * sigma * sigma) * T) / sst
    d2 = d1 - sst
    Kd = k * math.exp(-rate * T)
    if is_call:
        v = s * norm_cdf(d1) - Kd * norm_cdf(d2)
    else:
        v = Kd * norm_cdf(-d2) - s * norm_cdf(-d1)
    return max(v, 0.0) * 1e18
