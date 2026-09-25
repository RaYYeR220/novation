"""Generate contracts/test/vectors/math.json from the bit-exact Python reference
in fpmath.py.

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
"""

import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fpmath as F

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT_PATH = os.path.join(REPO_ROOT, "contracts", "test", "vectors", "math.json")

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


def main():
    rng = random.Random(42)

    exp_x, exp_y = gen_expWad(rng)
    ln_x, ln_y = gen_lnWad(rng)
    sqrt_x, sqrt_y = gen_sqrtWad(rng)
    cdf_x, cdf_y = gen_normCdf(rng)
    price_fields = gen_price(rng)

    doc = {
        "expWad": {"x": exp_x, "y": exp_y},
        "lnWad": {"x": ln_x, "y": ln_y},
        "sqrtWad": {"x": sqrt_x, "y": sqrt_y},
        "normCdf": {"x": cdf_x, "y": cdf_y},
        "price": price_fields,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", newline="\n") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")

    print(f"wrote {OUT_PATH}")
    print(f"  expWad:  {len(exp_x)}")
    print(f"  lnWad:   {len(ln_x)}")
    print(f"  sqrtWad: {len(sqrt_x)}")
    print(f"  normCdf: {len(cdf_x)}")
    print(f"  price:   {len(price_fields['S'])}")


if __name__ == "__main__":
    main()
