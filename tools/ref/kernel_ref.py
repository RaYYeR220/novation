"""Bit-exact Python reference for KernelReference.sol (contracts/src/kernel/KernelReference.sol).

Every function here reproduces, operation for operation, the corresponding
Solidity function in KernelReference.sol, using fpmath.py (itself bit-exact
for FixedPointMath.sol / BlackScholes.sol) so that the two integer outputs
are IDENTICAL for the same inputs. Every signed division goes through
`fpmath.tdiv` (never Python `//`, which floors toward negative infinity
instead of truncating toward zero). The one unsigned division in
`ewma_update` (`(dts[i] * 1e18) / YEAR`, both uint256 in Solidity) uses plain
Python `//`, which already matches uint256 floor division.

Inputs (books, positions, KParams) are plain dicts / lists of dicts; see the
`grid` docstring for the expected shapes. This module does not re-implement
Solidity's revert conditions as exceptions for every call site covered by
gen_vectors.py -- callers are responsible for keeping generated vectors
within the domain KernelReference.sol accepts (see BadUnderlyingIndex /
BadShockRange below, raised only where the Solidity source itself reverts).
"""

import fpmath as F

SCENARIOS = 39
PRICE_POINTS = 13
VOL_POINTS = 3
WAD_I = 10**18
YEAR = 31_536_000


class BadUnderlyingIndex(Exception):
    pass


class BadShockRange(Exception):
    pass


class LengthMismatch(Exception):
    pass


def grid(p: dict, us: list, ps: list):
    """Mirrors KernelReference._grid.

    p: {"nowTs": int, "rate": int, "diversificationCredit": int, "shortOptionMinPct": int}
    us: list of {"spot", "vol", "shockRange", "volUp", "volDown", "tokenQty"} (all int)
    ps: list of {"u", "isCall", "expiry", "strike", "qty"}

    Returns (pnl: list[int] length nu*39, mtm: int, shortMin: int).
    pnl is laid out [u * 39 + v * 13 + j]; scenario s = v * 13 + j.
    """
    nu = len(us)
    pnl = [0] * (nu * SCENARIOS)
    Sj = [0] * (nu * PRICE_POINTS)
    lnSh = [0] * (nu * PRICE_POINTS)
    vols = [0] * (nu * VOL_POINTS)
    mtm = 0

    for u in range(nu):
        U = us[u]
        if U["shockRange"] > int(0.9 * WAD_I) or U["volDown"] >= WAD_I:
            raise BadShockRange()
        S = U["spot"]
        R = U["shockRange"]
        for j in range(PRICE_POINTS):
            m = F.tdiv((j - 6) * R, 6)
            Sj[u * PRICE_POINTS + j] = F.mulWad(S, WAD_I + m)
            lnSh[u * PRICE_POINTS + j] = F.lnWad(WAD_I + m)
        v = U["vol"]
        vols[u * VOL_POINTS] = F.mulWad(v, WAD_I - U["volDown"])
        vols[u * VOL_POINTS + 1] = v
        vols[u * VOL_POINTS + 2] = F.mulWad(v, WAD_I + U["volUp"])
        mtm += F.mulWad(U["tokenQty"], S)
        for s in range(SCENARIOS):
            pnl[u * SCENARIOS + s] += F.mulWad(U["tokenQty"], Sj[u * PRICE_POINTS + (s % PRICE_POINTS)] - S)

    shortMin = 0
    for P in ps:
        if P["u"] >= nu:
            raise BadUnderlyingIndex()
        S = us[P["u"]]["spot"]
        K = P["strike"]
        qty = P["qty"]
        if qty < 0:
            shortMin += F.mulWadUp(-qty, F.mulWadUp(S, p["shortOptionMinPct"]))
        tau = P["expiry"] - p["nowTs"] if P["expiry"] > p["nowTs"] else 0
        if tau == 0:
            markI = S - K if P["isCall"] else K - S
            if markI < 0:
                markI = 0
            mtm += F.mulWad(qty, markI)
            for s in range(SCENARIOS):
                Sx = Sj[P["u"] * PRICE_POINTS + (s % PRICE_POINTS)]
                iv = Sx - K if P["isCall"] else K - Sx
                if iv < 0:
                    iv = 0
                pnl[P["u"] * SCENARIOS + s] += F.mulWad(qty, iv - markI)
            continue

        T = F.yearFrac(tau)
        sqrtT = F.sqrtWad(T)
        lnSK = F.lnWad(F.divWad(S, K))
        Kd = F.mulWad(K, F.discount(p["rate"], T))
        sig = vols[P["u"] * VOL_POINTS + 1]
        sst = F.mulWad(sig, sqrtT)
        drift = F.mulWad(p["rate"] + F.tdiv(F.mulWad(sig, sig), 2), T)
        mark = F.priceLn(
            Sj[P["u"] * PRICE_POINTS + 6], lnSK + lnSh[P["u"] * PRICE_POINTS + 6], sst, drift, Kd, P["isCall"]
        )
        mtm += F.mulWad(qty, mark)
        for vi in range(VOL_POINTS):
            sig = vols[P["u"] * VOL_POINTS + vi]
            sst = F.mulWad(sig, sqrtT)
            drift = F.mulWad(p["rate"] + F.tdiv(F.mulWad(sig, sig), 2), T)
            for j in range(PRICE_POINTS):
                px = F.priceLn(
                    Sj[P["u"] * PRICE_POINTS + j], lnSK + lnSh[P["u"] * PRICE_POINTS + j], sst, drift, Kd, P["isCall"]
                )
                pnl[P["u"] * SCENARIOS + vi * PRICE_POINTS + j] += F.mulWad(qty, px - mark)

    return pnl, mtm, shortMin


def margin(p: dict, us: list, ps: list):
    """Mirrors KernelReference.margin. Returns (out: dict, perUnderlyingWorst: list[int])."""
    pnl, mtm, shortMin = grid(p, us, ps)
    nu = len(us)
    perUnderlyingWorst = [0] * nu
    minSum = 0
    worst = 0
    if nu > 0:
        minSum = F.INT256_MAX
        for s in range(SCENARIOS):
            total = 0
            for u in range(nu):
                total += pnl[u * SCENARIOS + s]
            if total < minSum:
                minSum = total
                worst = s

    lossIndep = 0
    for u in range(nu):
        mn = F.INT256_MAX
        for s in range(SCENARIOS):
            x = pnl[u * SCENARIOS + s]
            if x < mn:
                mn = x
        perUnderlyingWorst[u] = mn
        if mn < 0:
            lossIndep += -mn

    lossCorr = -minSum if minSum < 0 else 0
    indepAdj = F.mulWad(lossIndep, WAD_I - p["diversificationCredit"])
    base = lossCorr if lossCorr > indepAdj else indepAdj
    out = {
        "mtm": mtm,
        "lossIM": base + shortMin,
        "lossCorr": lossCorr,
        "lossIndep": lossIndep,
        "shortMin": shortMin,
        "worstScenario": worst,
    }
    return out, perUnderlyingWorst


def scenario_grid(p: dict, us: list, ps: list):
    """Mirrors KernelReference.scenarioGrid. Returns list[int] length 39."""
    pnl, _mtm, _shortMin = grid(p, us, ps)
    nu = len(us)
    out = [0] * SCENARIOS
    for s in range(SCENARIOS):
        for u in range(nu):
            out[s] += pnl[u * SCENARIOS + s]
    return out


def bs_quote(spot: int, strike: int, tau: int, vol: int, rate: int, is_call: bool):
    """Mirrors KernelReference.bsQuote. Returns (price, delta, gamma, vega, theta)."""
    price = F.price(spot, strike, tau, vol, rate, is_call)
    delta, gamma, vega, theta = F.greeks(spot, strike, tau, vol, rate, is_call)
    return price, delta, gamma, vega, theta


def ewma_update(prevR2: int, prevDt: int, lastPrice: int, prices: list, dts: list, lam: int):
    """Mirrors KernelReference.ewmaUpdate. Returns (r2, dt)."""
    if len(prices) != len(dts):
        raise LengthMismatch()
    a = prevR2
    b = prevDt
    last = lastPrice
    l = lam
    for px, dt in zip(prices, dts):
        if dt == 0:
            last = px
            continue
        r = F.lnWad(F.divWad(px, last))
        dtY = (dt * WAD_I) // YEAR  # uint256 / uint256 in Solidity: plain floor division
        a = F.mulWad(l, a) + F.mulWad(WAD_I - l, F.mulWad(r, r))
        b = F.mulWad(l, b) + F.mulWad(WAD_I - l, dtY)
        last = px
    return a, b
