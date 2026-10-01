"""Generate app/src/fixtures/*.json from the bit-exact kernel reference.

Run: python tools/ref/gen_app_fixtures.py

All margin outputs, scenario grids, marks and greeks are computed with integer
WAD maths (kernel_ref.py / fpmath.py) and converted to floats (/1e18) only
when written to JSON.

Inputs:
  spots   latest Chainlink RH mainnet rounds (spikes/rh-data/RESULTS.md section 3,
          rounds_*.json at the last round): NVDA 225.57, TSLA 380.245, SPY 768.43, AAPL 336.31
  vols    NVDA 0.52, TSLA 0.61, SPY 0.16, AAPL 0.27
  gas     docs/gas.md headline comparison (Stylus risk kernel vs hand-optimized Solidity)
  agent / protocol / vault aggregates: design/variants/_data/book.json (demo book)
Symbols are used as the underlying identifier everywhere in the fixtures.
"""

import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fpmath as F  # noqa: E402
import kernel_ref as K  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(REPO, "app", "src", "fixtures")
WAD = 10**18

# ---- parameters ------------------------------------------------------------
NOW = 1790697600  # 2026-09-30 16:00:00 UTC (Wed 12:00 ET)
DAY = 86400
MIN_SHOCK, SHOCK_K = 0.10, 3.0
SESSION_MULT = {"REGULAR": 1.0, "EXTENDED": 1.2, "WEEKEND": 1.75}
VOL_UP, VOL_DOWN, DIV_CREDIT, SHORT_MIN, RATE, MM_RATIO = 0.4, 0.3, 0.3, 0.01, 0.0, 0.75
FEE_BPS = 5  # placeholder fee model: 5 bps of premium notional

UND = {
    "NVDA": dict(name="NVIDIA", spot=225.57, vol=0.52, ui=1.000775159164630595),
    "TSLA": dict(name="Tesla", spot=380.245, vol=0.61, ui=1.0),
    "SPY": dict(name="SPDR S&P 500 ETF", spot=768.43, vol=0.16, ui=1.001717991187472003),
    "AAPL": dict(name="Apple", spot=336.31, vol=0.27, ui=1.000566080061092436),
}
EXPIRY_DAYS = [6, 13, 20, 27]
STEP = {"NVDA": 5, "TSLA": 10, "SPY": 10, "AAPL": 5}
EXTRA_STRIKES = {"NVDA": [170, 200], "TSLA": [380], "SPY": [640], "AAPL": []}


def w(x):
    return int(round(x * WAD))


def f(x):
    return x / WAD


def shock_range(vol, session):
    return min(0.9, max(MIN_SHOCK, SHOCK_K * vol * math.sqrt(2 / 365)) * SESSION_MULT[session])


def kparams():
    return {"nowTs": NOW, "rate": w(RATE), "diversificationCredit": w(DIV_CREDIT), "shortOptionMinPct": w(SHORT_MIN)}


def und_entry(sym, session, token_qty=0.0):
    u = UND[sym]
    return {
        "spot": w(u["spot"]),
        "vol": w(u["vol"]),
        "shockRange": min(w(shock_range(u["vol"], session)), 9 * 10**17),
        "volUp": w(VOL_UP),
        "volDown": w(VOL_DOWN),
        "tokenQty": w(token_qty),
    }


def mark(sym, strike, days, is_call):
    u = UND[sym]
    return f(F.price(w(u["spot"]), w(strike), days * DAY, w(u["vol"]), 0, is_call))


def w_round(x, n=6):
    return round(x, n)


# ---- option chain ----------------------------------------------------------
def build_chain():
    series, underlyings_out = [], {}
    sid = 1
    ids = {}
    for sym, u in UND.items():
        spot, step = u["spot"], STEP[sym]
        base = round(spot / step) * step
        strikes = sorted(set([base + step * k for k in range(-6, 7)] + EXTRA_STRIKES[sym]))
        rows = []
        for d in EXPIRY_DAYS:
            for k in strikes:
                for is_call in (True, False):
                    tau = d * DAY
                    S, Kw = w(spot), w(k)
                    vol = u["vol"]
                    bid = f(F.price(S, Kw, tau, w(vol * 0.95), 0, is_call))
                    ask = f(F.price(S, Kw, tau, w(vol * 1.05), 0, is_call))
                    delta = f(F.greeks(S, Kw, tau, w(vol), 0, is_call)[0])
                    rows.append({
                        "id": sid, "underlying": sym, "expiry": NOW + tau, "strike": k, "isCall": is_call,
                        "bid": w_round(bid), "ask": w_round(ask), "delta": w_round(delta), "iv": vol,
                    })
                    ids[(sym, k, d, is_call)] = sid
                    sid += 1
        underlyings_out[sym] = {"expiries": [NOW + d * DAY for d in EXPIRY_DAYS], "series": rows}
    return underlyings_out, ids


# ---- account 7 -------------------------------------------------------------
def book7(sids, delta_call=0.0):
    order = ["NVDA", "TSLA", "SPY"]
    tq = {"NVDA": 40.0, "TSLA": 0.0, "SPY": 0.0}
    held = [
        ("NVDA", 200, True, -40.0 + delta_call),
        ("NVDA", 170, False, 10.0),
        ("TSLA", 380, False, -6.0),
        ("SPY", 640, False, 4.0),
    ]
    return order, tq, held


def run_margin(order, tq, held, session):
    us = [und_entry(s, session, tq[s]) for s in order]
    ps = [{"u": order.index(s), "isCall": c, "expiry": NOW + 6 * DAY, "strike": w(k), "qty": w(q)} for s, k, c, q in held]
    out, _ = K.margin(kparams(), us, ps)
    grid = K.scenario_grid(kparams(), us, ps)
    return out, grid


def account_state(cash, out, extra_cash=0.0):
    mtm = f(out["mtm"])
    cash = cash + extra_cash
    equity = cash + mtm
    im = f(out["lossIM"])
    mm = im * MM_RATIO
    return {
        "cash": w_round(cash, 6), "mtm": w_round(mtm, 6), "settledValue": w_round(cash, 6),
        "deficit": w_round(max(0.0, im - equity), 6), "equity": w_round(equity, 6),
        "im": w_round(im, 6), "mm": w_round(mm, 6), "worstScenario": out["worstScenario"],
        "healthy": equity >= im, "liquidatable": equity < mm,
    }


def build_account7(ids):
    cash = 2400.0
    order, tq, held = book7(ids)
    res = {}
    for s in ("REGULAR", "EXTENDED", "WEEKEND"):
        out, grid = run_margin(order, tq, held, s)
        res[s] = {"out": out, "grid": [w_round(f(x), 6) for x in grid],
                  "grid_wad": [str(x) for x in grid],
                  "shockRange": {sym: w_round(shock_range(UND[sym]["vol"], s), 6) for sym in order}}
    state = account_state(cash, res["REGULAR"]["out"])
    positions = []
    for sym, k, c, q in held:
        positions.append({
            "seriesId": ids[(sym, k, 6, c)], "qty": q, "mark": w_round(mark(sym, k, 6, c)),
            "id": ids[(sym, k, 6, c)], "underlying": sym, "expiry": NOW + 6 * DAY, "strike": k, "isCall": c,
        })
    acct = {"id": 7, "owner": "0x4a1c00000000000000000000000000000000" + "9e2f", "state": state,
            "positions": positions, "collateral": {"NVDA": 40.0}}
    summary = {
        "im_regular": w_round(f(res["REGULAR"]["out"]["lossIM"]), 6),
        "im_extended": w_round(f(res["EXTENDED"]["out"]["lossIM"]), 6),
        "im_weekend": w_round(f(res["WEEKEND"]["out"]["lossIM"]), 6),
        "mtm": state["mtm"], "equity": state["equity"],
        "worstScenario": {s: res[s]["out"]["worstScenario"] for s in res},
        "im_wad": {s: str(res[s]["out"]["lossIM"]) for s in res},
    }
    return acct, res, summary


# ---- what-if: hedge-bot over budget ---------------------------------------
def build_whatif(ids, acct, res):
    sid = ids[("NVDA", 200, 6, True)]
    qty_delta = -60.0
    mk = mark("NVDA", 200, 6, True)
    # Quote.premium is a positive magnitude; direction comes from the sign of qtyDelta.
    premium = w_round(abs(qty_delta) * mk)
    fee = w_round(premium * FEE_BPS / 1e4)
    cash_change = (premium if qty_delta < 0 else -premium) - fee  # sell receives, buy pays
    order, tq, held = book7(ids, delta_call=qty_delta)
    out, grid = run_margin(order, tq, held, "REGULAR")
    after = account_state(2400.0 + cash_change, out)
    before_loss = f(res["REGULAR"]["out"]["lossCorr"])
    worst_loss = f(out["lossCorr"])
    budget, used = 1500.0, 1180.0
    refusal = None
    projected = used + max(0.0, worst_loss - before_loss)  # budget used after this trade
    if projected > budget:
        refusal = {
            "code": "AgentRiskBudgetExceeded",
            "message": "Worst-case loss after this trade exceeds the agent's risk budget.",
            "numbers": {"worstLoss": w_round(projected, 2), "budget": budget, "used": used,
                        "remaining": budget - used},
        }
    quote = {"premium": premium, "fee": fee, "after": after}
    if refusal:
        quote["refusal"] = refusal
    return {"id": 7, "seriesId": sid, "qtyDelta": qty_delta, "premium": premium, "quote": quote}


# ---- market maker: 256 positions, grid only -------------------------------
def build_mm(ids):
    rnd = random.Random(2607)
    syms = list(UND)
    order = syms
    us = [und_entry(s, "REGULAR", 0.0) for s in order]
    ps = []
    for _ in range(256):
        s = rnd.choice(syms)
        d = rnd.choice(EXPIRY_DAYS)
        spot, step = UND[s]["spot"], STEP[s]
        k = round(spot / step) * step + step * rnd.randint(-6, 6)
        ps.append({"u": order.index(s), "isCall": rnd.random() < 0.5, "expiry": NOW + d * DAY,
                   "strike": w(k), "qty": w(rnd.choice([-1, 1]) * rnd.randint(1, 30))})
    out, _ = K.margin(kparams(), us, ps)
    grid = K.scenario_grid(kparams(), us, ps)
    agg = {}
    for p in ps:
        sym = order[p["u"]]
        key = (sym, f(p["strike"]), (p["expiry"] - NOW) // DAY, p["isCall"])
        agg[key] = agg.get(key, 0) + f(p["qty"])
    positions = []
    for (sym, k, d, c), q in agg.items():
        k = int(k) if float(k).is_integer() else k
        sid = ids[(sym, k, d, c)]
        positions.append({"seriesId": sid, "qty": q, "mark": w_round(mark(sym, k, d, c)), "id": sid,
                          "underlying": sym, "expiry": NOW + d * DAY, "strike": k, "isCall": c})
    state = account_state(250000.0, out)
    return {"id": 1, "owner": "0x" + "4d" * 20, "positionCount": 256, "state": state, "positions": positions,
            "collateral": {}, "grid": [w_round(f(x), 6) for x in grid],
            "lossIM": w_round(f(out["lossIM"]), 6), "worstScenario": out["worstScenario"]}


# ---- static aggregates -----------------------------------------------------
def gas_table():
    # docs/gas.md, "Headline comparison": execution gas of one margin() call, measured with a
    # gasleft() probe inside eth_call on RH testnet. Stylus = the Novation risk kernel; Solidity =
    # the hand-optimized baseline (BSMarginSol), same 39-scenario grid and integer algorithms.
    rows = [
        (1, 109700, 42597), (8, 745420, 76352), (32, 2922648, 199415), (64, 5828423, 351072),
        (128, 11646851, 685075), (256, 23269339, 1323108),
    ]
    return {
        "source": "docs/gas.md (RH testnet, execution gas of one margin() call, gasleft() probe)",
        "capNote": "Hand-optimized Solidity reaches the 32M per-tx gas limit at about 345 positions for one evaluation.",
        "rows": [{"positions": n, "solidityOptimized": s, "stylus": y} for n, s, y in rows],
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    chains, ids = build_chain()
    acct, res, summary = build_account7(ids)
    whatif = build_whatif(ids, acct, res)
    mm = build_mm(ids)

    underlyings = []
    for i, (sym, u) in enumerate(UND.items()):
        addr = "0x" + ("%02x" % (i + 1)) * 20
        underlyings.append({"address": addr, "symbol": sym, "name": u["name"], "spot": u["spot"],
                            "session": "REGULAR", "markVol": u["vol"], "uiMultiplier": u["ui"], "halted": False})

    protocol = {"openInterestUsd": 1843200, "vaultTvlUsd": 612000 + 430000 + 288000, "insuranceFundUsd": 25000,
                "premium7dUsd": 18450, "liquidations7d": 2, "socializedUsd": 0}
    vaults = [
        {"address": "0xa1" * 1 + "00" * 19, "kind": "coveredCall", "underlying": "NVDA", "tvl": 612000, "nav": 608940,
         "apy7d": 0.184, "utilization": 0.62, "epoch": 14, "live": True},
        {"address": "0xa2" + "00" * 19, "kind": "putWrite", "underlying": "NVDA", "tvl": 430000, "nav": 428710,
         "apy7d": 0.231, "utilization": 0.48, "epoch": 14, "live": True},
        {"address": "0xa3" + "00" * 19, "kind": "coveredCall", "underlying": "TSLA", "tvl": 288000, "nav": 286850,
         "apy7d": 0.152, "utilization": 0.55, "epoch": 9, "live": True},
    ]
    wi = whatif["quote"]["refusal"]  # kernel-computed; shared by agents, feed and what-if
    last_ref = {"code": wi["code"],
                "message": "Worst-case loss %.2f exceeds the risk budget of %.2f." % (
                    wi["numbers"]["worstLoss"], wi["numbers"]["budget"]),
                "numbers": dict(wi["numbers"]),
                "txHash": "0x" + "7c" * 32}
    agents = {"7": [{"agent": "0x" + "b0" * 20, "label": "hedge-bot", "maxWorstLoss": 1500, "maxPremiumPerTrade": 500,
                     "allowed": ["NVDA", "SPY"], "expiresAt": NOW + 30 * DAY, "used": 1180, "lastRefusal": last_ref}]}
    refusals = [
        dict(last_ref, at=NOW - 3600, account=7),
        {"code": "InsufficientMargin", "message": "Initial margin after trade exceeds equity.",
         "numbers": {"im": 3120.5, "equity": 2890.0}, "at": NOW - 7200, "txHash": "0x" + "3e" * 32, "account": 12},
        {"code": "OpeningNotAllowed", "message": "Opening trades are closed while the session is halted.",
         "at": NOW - 86400, "account": 31},
    ]

    files = {
        "underlyings.json": underlyings,
        "chains.json": chains,
        "account7.json": {"account": acct, "grids": {s: {"cells": res[s]["grid"], "shockRange": res[s]["shockRange"]} for s in res},
                          "summary": summary},
        "whatifs.json": [whatif],
        "market-maker.json": mm,
        "vaults.json": vaults,
        "agents.json": agents,
        "protocol.json": protocol,
        "refusals.json": refusals,
        "gas.json": gas_table(),
    }
    for name, data in files.items():
        with open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1)
            fh.write("\n")
    print(json.dumps(summary, indent=1))
    print("whatif:", json.dumps(whatif["quote"].get("refusal"), indent=1))
    print("mm:", mm["lossIM"], mm["worstScenario"])


if __name__ == "__main__":
    main()
