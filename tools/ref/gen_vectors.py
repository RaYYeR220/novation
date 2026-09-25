"""Generate contracts/test/vectors/math.json and contracts/test/vectors/kernel.json
from the bit-exact Python references in fpmath.py and kernel_ref.py.

Run: python tools/ref/gen_vectors.py
(from the repo root, or anywhere -- paths below are resolved relative to this
file so the script works from any cwd.)

--------------------------------------------------------------------------
Schema of contracts/test/vectors/math.json
--------------------------------------------------------------------------
The file is read both by Foundry tests via `vm.parseJson*` cheatcodes and,
later, by a Rust test via `serde_json`. Every big integer (any WAD-scaled
int256/uint256 value, or a raw uint256 like `tau` in seconds) is stored as a
decimal STRING -- JSON numbers are not safe for values wider than an f64's
53-bit mantissa, and 256-bit integers routinely are. Booleans are stored as
native JSON booleans.

Top-level object:
{
  "expWad":  { "x": [string, ...], "y": [string, ...] },   // y = expWad(x)
  "lnWad":   { "x": [string, ...], "y": [string, ...] },   // y = lnWad(x)
  "sqrtWad": { "x": [string, ...], "y": [string, ...] },   // y = sqrtWad(x)
  "normCdf": { "x": [string, ...], "y": [string, ...] },   // y = normCdf(x)
  "mulWadUp": { "a": [string, ...], "b": [string, ...], "y": [string, ...] },  // y = mulWadUp(a, b), uint256
  "divWadUp": { "a": [string, ...], "b": [string, ...], "y": [string, ...] },  // y = divWadUp(a, b), uint256
  "price": {
    "S":    [string, ...],   // WAD spot
    "K":    [string, ...],   // WAD strike
    "tau":  [string, ...],   // seconds, decimal string (uint256)
    "vol":  [string, ...],   // WAD annualized vol
    "rate": [string, ...],   // WAD annual rate, signed
    "isCall": [bool, ...],
    "y":    [string, ...],   // BlackScholes.price(...) exact integer result, WAD
    "floatPriceWad": [string, ...]  // round(float_price(...)), WAD-scaled, for tolerance checks only
  }
}

Within one section every array is parallel: index i across all arrays in that
section describes one test case. Arrays across different sections are
unrelated.

--------------------------------------------------------------------------
Schema of contracts/test/vectors/kernel.json
--------------------------------------------------------------------------
Same string-encoding convention as math.json (every integer, signed or
unsigned, is a decimal string; booleans are native JSON booleans). Ragged
per-book / per-case data (a book has a variable number of underlyings and
positions; an ewmaUpdate case has a variable number of price/dt samples) is
stored as FLAT parallel arrays at the section level, with a per-book/per-case
count field giving each record's slice length. A reader walks the count
array and keeps a running offset into the flat arrays -- this avoids nested
JSON objects/arrays, which are awkward to address generically from
forge-std's `vm.parseJson*` cheatcodes.

Top-level object:
{
  "books": {
    // one entry per book (152 books: 150 random + 2 fixed zero-vol books
    // appended last, see _zero_vol_books), index i describes book i:
    "n_us":  [string, ...],   // underlying count for book i
    "n_ps":  [string, ...],   // position count for book i
    "p_nowTs":  [string, ...],
    "p_rate":   [string, ...],   // KParams.rate, signed
    "p_credit": [string, ...],   // KParams.diversificationCredit
    "p_shortMin": [string, ...], // KParams.shortOptionMinPct

    // flattened across all books in order, sum(n_us) entries total; book i's
    // underlyings occupy the slice starting at sum(n_us[0..i)):
    "us_spot": [string, ...], "us_vol": [string, ...], "us_shockRange": [string, ...],
    "us_volUp": [string, ...], "us_volDown": [string, ...], "us_tokenQty": [string, ...],

    // flattened across all books in order, sum(n_ps) entries total; book i's
    // positions occupy the slice starting at sum(n_ps[0..i)):
    "ps_u": [string, ...], "ps_isCall": [bool, ...], "ps_expiry": [string, ...],
    "ps_strike": [string, ...], "ps_qty": [string, ...],

    // expected KMarginOut fields, one entry per book:
    "out_mtm": [string, ...], "out_lossIM": [string, ...], "out_lossCorr": [string, ...],
    "out_lossIndep": [string, ...], "out_shortMin": [string, ...], "out_worstScenario": [string, ...],
    // expected perUnderlyingWorst, flattened like us_*, sum(n_us) entries:
    "out_perUnderlyingWorst": [string, ...],
    // expected scenarioGrid, flattened, always 39 entries per book (152*39 total):
    "out_scenarioGrid": [string, ...]
  },
  "ewma": {
    // one entry per case (50 cases), index i describes case i:
    "n": [string, ...],          // sample count for case i
    "prevR2": [string, ...], "prevDt": [string, ...], "lastPrice": [string, ...], "lambda": [string, ...],
    // flattened across all cases in order, sum(n) entries total:
    "prices": [string, ...], "dts": [string, ...],
    // expected outputs, one entry per case:
    "out_r2": [string, ...], "out_dt": [string, ...]
  },
  "bsQuote": {
    // 212 flat cases: 200 random (100 spot/strike/tau/vol/rate combos x isCall
    // true/false) + 12 fixed sst < MIN_SST fallback cases appended last (see
    // the fallback_cases list in gen_bsQuote):
    "spot": [string, ...], "strike": [string, ...], "tau": [string, ...], "vol": [string, ...],
    "rate": [string, ...], "isCall": [bool, ...],
    "price": [string, ...], "delta": [string, ...], "gamma": [string, ...],
    "vega": [string, ...], "theta": [string, ...]
  }
}
"""

import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fpmath as F
import kernel_ref as kref

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT_PATH = os.path.join(REPO_ROOT, "contracts", "test", "vectors", "math.json")
KERNEL_OUT_PATH = os.path.join(REPO_ROOT, "contracts", "test", "vectors", "kernel.json")

WAD = 10**18
DAY = 86400


def unique_fill(rng: random.Random, mandatory, count, sampler):
    """Return `count` distinct ints: `mandatory` first, then random samples
    from `sampler(rng)` until the target size is reached."""
    seen = list(dict.fromkeys(mandatory))  # de-dupe, preserve order
    s = set(seen)
    guard = 0
    while len(seen) < count:
        guard += 1
        if guard > count * 1000:
            raise RuntimeError("sampler could not produce enough distinct values")
        v = sampler(rng)
        if v not in s:
            s.add(v)
            seen.append(v)
    return seen[:count]


def gen_expWad(rng: random.Random):
    lo, hi = -45 * WAD, 130 * WAD
    half_ln2 = F.tdiv(F.LN2, 2)
    mandatory = [0, half_ln2, -half_ln2, -41 * WAD, 130 * WAD]
    xs = unique_fill(rng, mandatory, 300, lambda r: r.randint(lo, hi))

    out_x, out_y = [], []
    for x in xs:
        try:
            y = F.expWad(x)
        except (F.ExpOverflow, AssertionError):
            continue  # would revert / overflow in Solidity -- excluded
        out_x.append(str(x))
        out_y.append(str(y))
    return out_x, out_y


def gen_lnWad(rng: random.Random):
    lo, hi = 1, 10**40
    powers_of_two = []
    k = 0
    while (1 << k) * WAD <= hi:
        powers_of_two.append((1 << k) * WAD)
        k += 1
    mandatory = [1, WAD, F.SQRT2 - 1, F.SQRT2 + 1] + powers_of_two

    def sample(r: random.Random) -> int:
        # log-uniform over ~40 orders of magnitude so the domain isn't
        # dominated by values near 1e40.
        exp = r.uniform(0, 40)
        v = int(10**exp)
        return max(lo, min(hi, v))

    xs = unique_fill(rng, mandatory, 300, sample)

    out_x, out_y = [], []
    for x in xs:
        try:
            y = F.lnWad(x)
        except (F.LnNonPositive, AssertionError):
            continue
        out_x.append(str(x))
        out_y.append(str(y))
    return out_x, out_y


def gen_sqrtWad(rng: random.Random):
    # Safety margin well below the uint256 overflow boundary for x*1e18
    # (x <= (2**256-1)//1e18 ~= 1.1579e59).
    hi = 10**36
    mandatory = [0, 1, WAD, 4 * WAD, hi]

    def sample(r: random.Random) -> int:
        if r.random() < 0.5:
            return r.randint(0, 10 * WAD)  # realistic Black-Scholes T range
        exp = r.uniform(0, 36)
        return int(10**exp)

    xs = unique_fill(rng, mandatory, 200, sample)

    out_x, out_y = [], []
    for x in xs:
        try:
            y = F.sqrtWad(x)
        except AssertionError:
            continue
        out_x.append(str(x))
        out_y.append(str(y))
    return out_x, out_y


def gen_normCdf(rng: random.Random):
    lo, hi = -9 * WAD, 9 * WAD
    mandatory = [-9 * WAD, -8 * WAD, 0, 8 * WAD, 9 * WAD]
    xs = unique_fill(rng, mandatory, 300, lambda r: r.randint(lo, hi))

    out_x, out_y = [], []
    for x in xs:
        try:
            y = F.normCdf(x)
        except AssertionError:
            continue
        out_x.append(str(x))
        out_y.append(str(y))
    return out_x, out_y


def gen_price(rng: random.Random):
    fields = {k: [] for k in ("S", "K", "tau", "vol", "rate", "isCall", "y", "floatPriceWad")}
    n_combos = 200
    produced = 0
    guard = 0
    while produced < n_combos:
        guard += 1
        if guard > n_combos * 100:
            raise RuntimeError("could not produce enough valid price combos")

        S = rng.randint(1 * WAD, 5000 * WAD)
        K = rng.randint((3 * S) // 10, 2 * S)
        if K <= 0:
            continue
        tau_choice = rng.choice(["zero", "one", "range"])
        if tau_choice == "zero":
            tau = 0
        elif tau_choice == "one":
            tau = 1
        else:
            tau = rng.randint(60 * DAY, 120 * DAY)
        vol = rng.randint(int(0.01 * WAD), 3 * WAD)
        rate = rng.choice([0, int(0.05 * WAD)])

        combo_ok = True
        results = {}
        for is_call in (True, False):
            try:
                y = F.price(S, K, tau, vol, rate, is_call)
            except (F.ExpOverflow, F.LnNonPositive, AssertionError):
                combo_ok = False
                break
            fp = F.float_price(float(S), float(K), float(tau), float(vol), float(rate), is_call)
            results[is_call] = (y, round(fp))
        if not combo_ok:
            continue

        for is_call in (True, False):
            y, fp_wad = results[is_call]
            fields["S"].append(str(S))
            fields["K"].append(str(K))
            fields["tau"].append(str(tau))
            fields["vol"].append(str(vol))
            fields["rate"].append(str(rate))
            fields["isCall"].append(is_call)
            fields["y"].append(str(y))
            fields["floatPriceWad"].append(str(fp_wad))
        produced += 1

    return fields


def gen_mulWadUp(rng: random.Random):
    hi = 10_000 * WAD
    mandatory = [(0, 0), (0, hi), (hi, 0), (1, 1), (WAD, WAD), (WAD + 1, WAD), (1, WAD - 1), (hi, hi)]
    pairs = unique_fill(rng, mandatory, 100, lambda r: (r.randint(0, hi), r.randint(0, hi)))

    out_a, out_b, out_y = [], [], []
    for a, b in pairs:
        out_a.append(str(a))
        out_b.append(str(b))
        out_y.append(str(F.mulWadUp(a, b)))
    return out_a, out_b, out_y


def gen_divWadUp(rng: random.Random):
    hi = 10_000 * WAD
    mandatory = [(0, 1), (0, hi), (1, hi), (WAD, WAD), (WAD + 1, WAD), (1, WAD - 1), (hi, 1), (hi, hi)]
    pairs = unique_fill(rng, mandatory, 100, lambda r: (r.randint(0, hi), r.randint(1, hi)))

    out_a, out_b, out_y = [], [], []
    for a, b in pairs:
        out_a.append(str(a))
        out_b.append(str(b))
        out_y.append(str(F.divWadUp(a, b)))
    return out_a, out_b, out_y


# ---------------------------------------------------------------------------
# kernel.json (KernelReference.sol vectors)
# ---------------------------------------------------------------------------

NOW_TS = 1_790_000_000
LARGE_SIZES = [64, 128, 256]

# WAD-scaled constants as exact integers (never float * WAD -- 1e18-scale
# floats lose precision well before that magnitude in a float64 mantissa).
PCT_01 = 10**16  # 0.01e18
PCT_04 = 4 * 10**16  # 0.04e18
PCT_05 = 5 * 10**16  # 0.05e18
PCT_10 = 10**17  # 0.1e18
PCT_30 = 3 * 10**17  # 0.3e18
PCT_40 = 4 * 10**17  # 0.4e18
PCT_90 = 9 * 10**17  # 0.9e18
PCT_150 = 15 * 10**17  # 1.5e18


def _append_book(fields, us_flat, ps_flat, outs, out_puw, out_sg, p, us, ps):
    """Compute one book's margin/scenarioGrid via kernel_ref and append it to the
    flat field dicts. Shared by the random books loop and the deterministic
    fixed books appended after it, so both serialize identically."""
    out, puw = kref.margin(p, us, ps)
    sg = kref.scenario_grid(p, us, ps)

    fields["n_us"].append(str(len(us)))
    fields["n_ps"].append(str(len(ps)))
    fields["p_nowTs"].append(str(p["nowTs"]))
    fields["p_rate"].append(str(p["rate"]))
    fields["p_credit"].append(str(p["diversificationCredit"]))
    fields["p_shortMin"].append(str(p["shortOptionMinPct"]))

    for U in us:
        us_flat["us_spot"].append(str(U["spot"]))
        us_flat["us_vol"].append(str(U["vol"]))
        us_flat["us_shockRange"].append(str(U["shockRange"]))
        us_flat["us_volUp"].append(str(U["volUp"]))
        us_flat["us_volDown"].append(str(U["volDown"]))
        us_flat["us_tokenQty"].append(str(U["tokenQty"]))

    for P in ps:
        ps_flat["ps_u"].append(str(P["u"]))
        ps_flat["ps_isCall"].append(P["isCall"])
        ps_flat["ps_expiry"].append(str(P["expiry"]))
        ps_flat["ps_strike"].append(str(P["strike"]))
        ps_flat["ps_qty"].append(str(P["qty"]))

    outs["out_mtm"].append(str(out["mtm"]))
    outs["out_lossIM"].append(str(out["lossIM"]))
    outs["out_lossCorr"].append(str(out["lossCorr"]))
    outs["out_lossIndep"].append(str(out["lossIndep"]))
    outs["out_shortMin"].append(str(out["shortMin"]))
    outs["out_worstScenario"].append(str(out["worstScenario"]))
    out_puw.extend(str(x) for x in puw)
    out_sg.extend(str(x) for x in sg)


def _zero_vol_books():
    """2 fixed books with underlying vol == 0 and positions at tau > 0. vol == 0
    forces sst == 0 for every one of the 39 scenarios on that underlying (all
    three vol slices are mulWad(0, ...) == 0), so every priceLn call for these
    positions -- not just the already-covered tau == 0 branch -- takes the
    sst < MIN_SST fallback: v = isCall ? Sx - Kd : Kd - Sx (the *discounted*
    Kd intrinsic, not raw K), and BS.greeks takes its own tau>0-but-degenerate
    fallback (delta +/-1e18 or 0, other greeks 0). Book A has rate == 0 (Kd ==
    K exactly); book B has rate == 0.04e18 so Kd is genuinely discounted,
    pinning the Kd computation itself, not just the branch selection.
    """
    return [
        (
            {"nowTs": NOW_TS, "rate": 0, "diversificationCredit": PCT_30, "shortOptionMinPct": PCT_01},
            [{"spot": 100 * WAD, "vol": 0, "shockRange": 2 * 10**17, "volUp": PCT_40, "volDown": PCT_30, "tokenQty": 5 * WAD}],
            [
                {"u": 0, "isCall": True, "expiry": NOW_TS + 7 * DAY, "strike": 90 * WAD, "qty": 10 * WAD},
                {"u": 0, "isCall": True, "expiry": NOW_TS + 14 * DAY, "strike": 110 * WAD, "qty": -8 * WAD},
                {"u": 0, "isCall": False, "expiry": NOW_TS + 21 * DAY, "strike": 95 * WAD, "qty": 6 * WAD},
                {"u": 0, "isCall": False, "expiry": NOW_TS + 30 * DAY, "strike": 105 * WAD, "qty": -4 * WAD},
            ],
        ),
        (
            {"nowTs": NOW_TS, "rate": PCT_04, "diversificationCredit": PCT_30, "shortOptionMinPct": PCT_01},
            [{"spot": 200 * WAD, "vol": 0, "shockRange": 25 * 10**16, "volUp": PCT_40, "volDown": PCT_30, "tokenQty": 0}],
            [
                {"u": 0, "isCall": True, "expiry": NOW_TS + 10 * DAY, "strike": 180 * WAD, "qty": -15 * WAD},
                {"u": 0, "isCall": True, "expiry": NOW_TS + 45 * DAY, "strike": 220 * WAD, "qty": 12 * WAD},
                {"u": 0, "isCall": False, "expiry": NOW_TS + 60 * DAY, "strike": 190 * WAD, "qty": -9 * WAD},
            ],
        ),
    ]


def gen_books(rng: random.Random):
    fields = {k: [] for k in ("n_us", "n_ps", "p_nowTs", "p_rate", "p_credit", "p_shortMin")}
    us_flat = {k: [] for k in ("us_spot", "us_vol", "us_shockRange", "us_volUp", "us_volDown", "us_tokenQty")}
    ps_flat = {k: [] for k in ("ps_u", "ps_isCall", "ps_expiry", "ps_strike", "ps_qty")}
    outs = {
        k: []
        for k in ("out_mtm", "out_lossIM", "out_lossCorr", "out_lossIndep", "out_shortMin", "out_worstScenario")
    }
    out_puw = []
    out_sg = []

    n_small = 140
    n_large = 10

    for bi in range(n_small + n_large):
        nu = rng.randint(1, 8)

        us = []
        for _ in range(nu):
            spot = rng.randint(5 * WAD, 2000 * WAD)
            vol = rng.randint(PCT_10, PCT_150)
            vol_f = vol / WAD
            base = max(0.1, 3.0 * vol_f * math.sqrt(2.0 / 365.0))
            mult = rng.choice([1.0, 1.2, 1.75, 2.5])
            shock_f = min(0.9, base * mult)
            shockRange = min(int(round(shock_f * WAD)), PCT_90)
            tokenQty = 0 if rng.random() < 0.4 else rng.randint(0, 100 * WAD)
            us.append(
                {
                    "spot": spot,
                    "vol": vol,
                    "shockRange": shockRange,
                    "volUp": PCT_40,
                    "volDown": PCT_30,
                    "tokenQty": tokenQty,
                }
            )

        if bi < n_small:
            npos = rng.randint(0, 32)
        else:
            npos = LARGE_SIZES[(bi - n_small) % 3]

        ps = []
        for _ in range(npos):
            u = rng.randint(0, nu - 1)
            isCall = rng.random() < 0.5
            expiry = NOW_TS + rng.randint(-86400, 42 * 86400)
            spot_u = us[u]["spot"]
            strike_dollars = round((spot_u / WAD) * rng.uniform(0.6, 1.5))
            strike = max(1, strike_dollars) * WAD
            qty = rng.randint(-50 * WAD, 50 * WAD)
            ps.append({"u": u, "isCall": isCall, "expiry": expiry, "strike": strike, "qty": qty})

        rate = rng.choice([0, PCT_04])
        p = {"nowTs": NOW_TS, "rate": rate, "diversificationCredit": PCT_30, "shortOptionMinPct": PCT_01}

        _append_book(fields, us_flat, ps_flat, outs, out_puw, out_sg, p, us, ps)

    # Deterministic zero-vol books, appended after the random ones so none of the
    # existing (random-book) entries above shift position.
    for p, us, ps in _zero_vol_books():
        _append_book(fields, us_flat, ps_flat, outs, out_puw, out_sg, p, us, ps)

    doc = {}
    doc.update(fields)
    doc.update(us_flat)
    doc.update(ps_flat)
    doc.update(outs)
    doc["out_perUnderlyingWorst"] = out_puw
    doc["out_scenarioGrid"] = out_sg
    return doc


def gen_ewma(rng: random.Random):
    fields = {k: [] for k in ("n", "prevR2", "prevDt", "lastPrice", "lambda", "out_r2", "out_dt")}
    flat = {"prices": [], "dts": []}

    for ci in range(50):
        n = rng.randint(5, 40)
        prevR2 = rng.randint(0, 2 * 10**16)
        prevDt = rng.randint(0, 10**17)
        lastPrice = rng.randint(5 * WAD, 2000 * WAD)
        lam = rng.randint(PCT_90, 995 * 10**15)  # [0.9e18, 0.995e18]

        prices, dts = [], []
        for j in range(n):
            prices.append(rng.randint(5 * WAD, 2000 * WAD))
            if ci == 0 and j == 0:
                dts.append(0)  # guarantee a zero-dt (advance-only) case
            elif ci == 1 and j == 0:
                dts.append(216000)  # guarantee the 2.5-day-gap case
            else:
                r = rng.random()
                if r < 0.15:
                    dts.append(0)
                elif r < 0.30:
                    dts.append(216000)
                else:
                    dts.append(rng.randint(60, 7 * 86400))

        r2, dt = kref.ewma_update(prevR2, prevDt, lastPrice, prices, dts, lam)

        fields["n"].append(str(n))
        fields["prevR2"].append(str(prevR2))
        fields["prevDt"].append(str(prevDt))
        fields["lastPrice"].append(str(lastPrice))
        fields["lambda"].append(str(lam))
        fields["out_r2"].append(str(r2))
        fields["out_dt"].append(str(dt))
        flat["prices"].extend(str(x) for x in prices)
        flat["dts"].extend(str(x) for x in dts)

    doc = {}
    doc.update(fields)
    doc.update(flat)
    return doc


def gen_bsQuote(rng: random.Random):
    fields = {
        k: [] for k in ("spot", "strike", "tau", "vol", "rate", "isCall", "price", "delta", "gamma", "vega", "theta")
    }
    n_combos = 100
    produced = 0
    guard = 0
    while produced < n_combos:
        guard += 1
        if guard > n_combos * 200:
            raise RuntimeError("could not produce enough valid bsQuote combos")

        S = rng.randint(WAD, 5000 * WAD)
        K = rng.randint((3 * S) // 10, 2 * S)
        if K <= 0:
            continue

        # tau weighted toward the realistic range: 70% [1 day, 120 days],
        # 15% tiny [1 s, 1 h], 15% zero.
        r = rng.random()
        if r < 0.70:
            tau = rng.randint(1 * DAY, 120 * DAY)
        elif r < 0.85:
            tau = rng.randint(1, 3600)
        else:
            tau = 0

        vol = rng.randint(PCT_01, 3 * WAD)
        rate = rng.choice([0, PCT_05])

        combo_ok = True
        results = {}
        for is_call in (True, False):
            try:
                results[is_call] = kref.bs_quote(S, K, tau, vol, rate, is_call)
            except (F.ExpOverflow, F.LnNonPositive, AssertionError):
                combo_ok = False
                break
        if not combo_ok:
            continue

        for is_call in (True, False):
            price, delta, gamma, vega, theta = results[is_call]
            fields["spot"].append(str(S))
            fields["strike"].append(str(K))
            fields["tau"].append(str(tau))
            fields["vol"].append(str(vol))
            fields["rate"].append(str(rate))
            fields["isCall"].append(is_call)
            fields["price"].append(str(price))
            fields["delta"].append(str(delta))
            fields["gamma"].append(str(gamma))
            fields["vega"].append(str(vega))
            fields["theta"].append(str(theta))
        produced += 1

    # Deterministic sst < MIN_SST fallback cases, appended after the random
    # combos so none of the existing entries above shift position. vol in
    # {0, 1, 1e6 wei} keeps sst = mulWad(vol, sqrtT) below MIN_SST (1e6) for
    # every tau here (all "in days"), landing in BlackScholes.priceLn's / .
    # greeks' sst < MIN_SST fallback with tau > 0 (as opposed to the tau == 0
    # branch, which the random cases above already cover). vol = 1e9 wei is
    # included too, but at these "in days" tau values sst is always well
    # above MIN_SST (~5.2e7 at tau = 1 day) -- these three cases instead pin
    # the full Black-Scholes branch immediately outside the fallback, at the
    # smallest vol that still avoids it; see the report for the exact numbers.
    fallback_cases = [
        (100 * WAD, 90 * WAD, 7 * DAY, 0, 0, True),
        (100 * WAD, 110 * WAD, 30 * DAY, 0, PCT_04, False),
        (100 * WAD, 100 * WAD, 1 * DAY, 0, 0, True),
        (100 * WAD, 90 * WAD, 14 * DAY, 1, PCT_04, True),
        (100 * WAD, 110 * WAD, 60 * DAY, 1, 0, True),
        (100 * WAD, 95 * WAD, 3 * DAY, 1, PCT_04, False),
        (150 * WAD, 140 * WAD, 7 * DAY, 10**6, 0, True),
        (150 * WAD, 160 * WAD, 45 * DAY, 10**6, PCT_04, False),
        (150 * WAD, 150 * WAD, 21 * DAY, 10**6, 0, False),
        (200 * WAD, 180 * WAD, 1 * DAY, 10**9, 0, True),
        (200 * WAD, 220 * WAD, 1 * DAY, 10**9, PCT_04, False),
        (200 * WAD, 200 * WAD, 1 * DAY, 10**9, 0, True),
    ]
    for S, K, tau, vol, rate, is_call in fallback_cases:
        price, delta, gamma, vega, theta = kref.bs_quote(S, K, tau, vol, rate, is_call)
        fields["spot"].append(str(S))
        fields["strike"].append(str(K))
        fields["tau"].append(str(tau))
        fields["vol"].append(str(vol))
        fields["rate"].append(str(rate))
        fields["isCall"].append(is_call)
        fields["price"].append(str(price))
        fields["delta"].append(str(delta))
        fields["gamma"].append(str(gamma))
        fields["vega"].append(str(vega))
        fields["theta"].append(str(theta))

    return fields


def main():
    rng = random.Random(42)

    exp_x, exp_y = gen_expWad(rng)
    ln_x, ln_y = gen_lnWad(rng)
    sqrt_x, sqrt_y = gen_sqrtWad(rng)
    cdf_x, cdf_y = gen_normCdf(rng)
    price_fields = gen_price(rng)
    mulup_a, mulup_b, mulup_y = gen_mulWadUp(rng)
    divup_a, divup_b, divup_y = gen_divWadUp(rng)

    doc = {
        "expWad": {"x": exp_x, "y": exp_y},
        "lnWad": {"x": ln_x, "y": ln_y},
        "sqrtWad": {"x": sqrt_x, "y": sqrt_y},
        "normCdf": {"x": cdf_x, "y": cdf_y},
        "mulWadUp": {"a": mulup_a, "b": mulup_b, "y": mulup_y},
        "divWadUp": {"a": divup_a, "b": divup_b, "y": divup_y},
        "price": price_fields,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", newline="\n") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")

    print(f"wrote {OUT_PATH}")
    print(f"  expWad:   {len(exp_x)}")
    print(f"  lnWad:    {len(ln_x)}")
    print(f"  sqrtWad:  {len(sqrt_x)}")
    print(f"  normCdf:  {len(cdf_x)}")
    print(f"  mulWadUp: {len(mulup_a)}")
    print(f"  divWadUp: {len(divup_a)}")
    print(f"  price:    {len(price_fields['S'])}")

    rng_kernel = random.Random(7)
    books_doc = gen_books(rng_kernel)
    ewma_doc = gen_ewma(rng_kernel)
    bsquote_fields = gen_bsQuote(rng_kernel)

    kernel_doc = {
        "books": books_doc,
        "ewma": ewma_doc,
        "bsQuote": bsquote_fields,
    }

    os.makedirs(os.path.dirname(KERNEL_OUT_PATH), exist_ok=True)
    with open(KERNEL_OUT_PATH, "w", newline="\n") as f:
        json.dump(kernel_doc, f, indent=2)
        f.write("\n")

    print(f"wrote {KERNEL_OUT_PATH}")
    print(f"  books:   {len(books_doc['n_us'])}")
    print(f"  ewma:    {len(ewma_doc['n'])}")
    print(f"  bsQuote: {len(bsquote_fields['spot'])}")


if __name__ == "__main__":
    main()
