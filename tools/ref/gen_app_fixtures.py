"""Generate app/src/fixtures/*.json from the bit-exact kernel reference.

Run: python tools/ref/gen_app_fixtures.py

All margin outputs, scenario grids, marks and greeks are computed with integer
WAD maths (kernel_ref.py / fpmath.py) and converted to floats (/1e18) only
when written to JSON.

Inputs:
  spots   latest Chainlink RH mainnet rounds (spikes/rh-data/RESULTS.md section 3,
          rounds_*.json at the last round): NVDA 225.57, TSLA 380.245, SPY 768.43, AAPL 336.31
  vols    NVDA 0.52, TSLA 0.61, SPY 0.16, AAPL 0.27
  gas     spikes/stylus-bs-gas/RESULTS.md (Stylus fast + 32 KB stack vs Solidity via-IR)
  agent budget and caps: design/variants/_data/book.json (demo book)
  history data/rh_rounds.json: every Chainlink round of the four feeds to 2026-09-25, replayed by
          app_history.py into halts, settlement prices and the vault strategy (vaults, pools,
          insurance, auctions, refusals); books, deposits and fills there are demo choices
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
import nyse  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(REPO, "app", "src", "fixtures")
WAD = 10**18

# ---- parameters ------------------------------------------------------------
NOW = 1790697600  # 2026-09-29 16:00:00 UTC (Tue 12:00 ET, regular session)
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
# The next four NYSE weekly closes after NOW (NyseCalendar.nextWeeklyExpiry): Fri Oct 2, 9, 16, 23 at 16:00 ET.
nyse.self_check()
EXPIRIES = nyse.weekly_expiries(NOW, 4)
# Agent policy for hedge-bot on account 7 (design/variants/_data/book.json).
AGENT = "0x" + "b0" * 20
AGENT_BUDGET, AGENT_PREMIUM_CAP = 1500.0, 500.0
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


def mark(sym, strike, expiry, is_call):
    u = UND[sym]
    return f(F.price(w(u["spot"]), w(strike), expiry - NOW, w(u["vol"]), 0, is_call))


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
        for e in EXPIRIES:
            for k in strikes:
                for is_call in (True, False):
                    tau = e - NOW
                    S, Kw = w(spot), w(k)
                    vol = u["vol"]
                    bid = f(F.price(S, Kw, tau, w(vol * 0.95), 0, is_call))
                    ask = f(F.price(S, Kw, tau, w(vol * 1.05), 0, is_call))
                    delta = f(F.greeks(S, Kw, tau, w(vol), 0, is_call)[0])
                    rows.append({
                        "id": sid, "underlying": sym, "expiry": e, "strike": k, "isCall": is_call,
                        "bid": w_round(bid), "ask": w_round(ask), "delta": w_round(delta), "iv": vol,
                    })
                    ids[(sym, k, e, is_call)] = sid
                    sid += 1
        underlyings_out[sym] = {"expiries": list(EXPIRIES), "series": rows}
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
    ps = [{"u": order.index(s), "isCall": c, "expiry": EXPIRIES[0], "strike": w(k), "qty": w(q)} for s, k, c, q in held]
    out, _ = K.margin(kparams(), us, ps)
    grid = K.scenario_grid(kparams(), us, ps)
    return out, grid


def account_state(cash, out, extra_cash=0.0):
    mtm = f(out["mtm"])
    cash = cash + extra_cash
    equity = cash + mtm
    im = f(out["lossIM"])
    mm = im * MM_RATIO
    # Clearinghouse.accountState: settledValue holds expired-unsettled positions and unpaid claims, and
    # deficit is the USDG owed to the insurance fund after a settlement; the demo books carry neither.
    return {
        "cash": w_round(cash, 6), "mtm": w_round(mtm, 6), "settledValue": 0.0,
        "deficit": 0.0, "equity": w_round(equity, 6),
        "im": w_round(im, 6), "mm": w_round(mm, 6), "worstScenario": out["worstScenario"],
        "healthy": equity >= im, "liquidatable": equity < mm,
    }


def build_account7(ids):
    cash = 2400.0
    order, tq, held = book7(ids)
    res = {}
    for s in ("REGULAR", "EXTENDED", "WEEKEND"):
        out, grid = run_margin(order, tq, held, s)
        res[s] = {"out": out, "grid": [w_round(f(x), 6) for x in grid], "im": w_round(f(out["lossIM"]), 6),
                  "grid_wad": [str(x) for x in grid],
                  "shockRange": {sym: w_round(shock_range(UND[sym]["vol"], s), 6) for sym in order}}
    state = account_state(cash, res["REGULAR"]["out"])
    positions = []
    for sym, k, c, q in held:
        e = EXPIRIES[0]
        positions.append({
            "seriesId": ids[(sym, k, e, c)], "qty": q, "mark": w_round(mark(sym, k, e, c)),
            "id": ids[(sym, k, e, c)], "underlying": sym, "expiry": e, "strike": k, "isCall": c,
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
def build_whatif(ids, chains, acct, res):
    """hedge-bot, acting for account 7, sells 60 NVDA 200 calls through RFQ at the demo maker's
    quote: the mid of the chain's bid and ask, exactly as the app computes it. Margin, grid and
    refusal follow TradeLogic.trade: margin first, then the agent's policy (_checkBudget):
    post-trade lossIM within maxWorstLoss unless the side reduces risk, premium within
    maxPremiumPerTrade, and the equity given up against the mark (fee aside) within the same cap."""
    e = EXPIRIES[0]
    sid = ids[("NVDA", 200, e, True)]
    row = next(r for r in chains["NVDA"]["series"] if r["id"] == sid)
    qty_delta = -60.0
    rfq_price = (row["bid"] + row["ask"]) / 2
    # Quote.premium is a positive magnitude; direction comes from the sign of qtyDelta.
    premium = w_round(abs(qty_delta) * rfq_price)
    fee = w_round(premium * FEE_BPS / 1e4)
    cash_change = (premium if qty_delta < 0 else -premium) - fee  # sell receives, buy pays
    order, tq, held = book7(ids, delta_call=qty_delta)
    out, grid = run_margin(order, tq, held, "REGULAR")
    after = account_state(2400.0 + cash_change, out)
    pre = account_state(2400.0, res["REGULAR"]["out"])

    old_qty, new_qty = -40.0, -40.0 + qty_delta
    opening = new_qty != 0 and (abs(new_qty) > abs(old_qty) or (old_qty > 0) != (new_qty > 0))
    pure_reduction = not opening and after["im"] <= pre["im"] and after["equity"] + fee >= pre["equity"]
    refusal = None
    if not after["healthy"] and not pure_reduction:
        refusal = {"code": "InsufficientMargin", "message": "Initial margin after the trade exceeds equity.",
                   "numbers": {"im": after["im"], "equity": after["equity"]}}
    elif after["im"] > AGENT_BUDGET and (opening or after["im"] > pre["im"]):
        refusal = {"code": "AgentRiskBudgetExceeded",
                   "message": "Worst-case loss after this trade exceeds the agent's risk budget.",
                   "numbers": {"worstLoss": after["im"], "budget": AGENT_BUDGET, "used": pre["im"],
                               "remaining": w_round(AGENT_BUDGET - pre["im"], 6)}}
    elif premium > AGENT_PREMIUM_CAP:
        refusal = {"code": "AgentPremiumExceeded", "message": "Premium exceeds the agent's per-trade cap.",
                   "numbers": {"premium": premium, "cap": AGENT_PREMIUM_CAP}}
    else:
        loss = w_round(pre["equity"] - (after["equity"] + fee), 6)
        if loss > AGENT_PREMIUM_CAP:
            refusal = {"code": "AgentValueDrainExceeded",
                       "message": "The trade gives up more value than the agent's cap.",
                       "numbers": {"loss": loss, "cap": AGENT_PREMIUM_CAP}}
    quote = {"premium": premium, "fee": fee, "after": after, "afterGrid": [w_round(f(x), 6) for x in grid]}
    if refusal:
        quote["refusal"] = refusal
    return {"id": 7, "seriesId": sid, "qtyDelta": qty_delta, "premium": premium, "venue": "rfq", "agent": AGENT,
            "quote": quote}


# ---- market maker: 256 positions, grid only -------------------------------
def build_mm(ids):
    rnd = random.Random(2607)
    syms = list(UND)
    order = syms
    us = [und_entry(s, "REGULAR", 0.0) for s in order]
    ps = []
    for _ in range(256):
        s = rnd.choice(syms)
        e = rnd.choice(EXPIRIES)
        spot, step = UND[s]["spot"], STEP[s]
        k = round(spot / step) * step + step * rnd.randint(-6, 6)
        ps.append({"u": order.index(s), "isCall": rnd.random() < 0.5, "expiry": e,
                   "strike": w(k), "qty": w(rnd.choice([-1, 1]) * rnd.randint(1, 30))})
    out, _ = K.margin(kparams(), us, ps)
    grid = K.scenario_grid(kparams(), us, ps)
    agg = {}
    for p in ps:
        sym = order[p["u"]]
        key = (sym, f(p["strike"]), p["expiry"], p["isCall"])
        agg[key] = agg.get(key, 0) + f(p["qty"])
    positions = []
    for (sym, k, e, c), q in agg.items():
        k = int(k) if float(k).is_integer() else k
        sid = ids[(sym, k, e, c)]
        positions.append({"seriesId": sid, "qty": q, "mark": w_round(mark(sym, k, e, c)), "id": sid,
                          "underlying": sym, "expiry": e, "strike": k, "isCall": c})
    state = account_state(250000.0, out)
    us_w = [und_entry(s, "WEEKEND", 0.0) for s in order]
    out_w, _ = K.margin(kparams(), us_w, ps)
    grid_w = K.scenario_grid(kparams(), us_w, ps)
    grids = {
        "REGULAR": {"cells": [w_round(f(x), 6) for x in grid], "im": w_round(f(out["lossIM"]), 6),
                    "shockRange": {s: w_round(shock_range(UND[s]["vol"], "REGULAR"), 6) for s in order}},
        "WEEKEND": {"cells": [w_round(f(x), 6) for x in grid_w], "im": w_round(f(out_w["lossIM"]), 6),
                    "shockRange": {s: w_round(shock_range(UND[s]["vol"], "WEEKEND"), 6) for s in order}},
    }
    return {"id": 1, "owner": "0x" + "4d" * 20, "positionCount": 256, "state": state, "positions": positions,
            "collateral": {}, "grid": [w_round(f(x), 6) for x in grid], "grids": grids,
            "lossIM": w_round(f(out["lossIM"]), 6), "worstScenario": out["worstScenario"]}


# ---- static aggregates -----------------------------------------------------
def gas_table():
    rows = [
        (1, 131615, 52363), (4, 410442, 68509), (8, 780061, 90179), (16, 1520541, 131738),
        (32, 2995000, 215756), (64, 5952285, 386324), (128, 11872957, 726891),
        (256, 23698810, 1406348), (336, 31083410, 1831848),
    ]
    return {
        "source": "spikes/stylus-bs-gas/RESULTS.md (RH testnet, L2 gas = estimate - L1 component)",
        "capNote": "Solidity hits the 32M per-tx gas cap at about 343-347 positions; Stylus does N=352 in 1.92M gas.",
        "rows": [{"positions": n, "solidityOptimized": s, "stylus": y} for n, s, y in rows],
    }


# ---- demo world: settlement history, vaults, halts, auctions --------------
# Everything below replays the real Chainlink rounds (data/rh_rounds.json, read 2026-09-25) through the
# contract rules. Books, deposits, fills and timings are demo choices, written out where they are made.
import app_history as H  # noqa: E402

READ_AT, FEEDS = H.load_feeds()
HALTS = {s: H.halt_history(s, FEEDS[s], READ_AT) for s in FEEDS}
PAST = [e for e in nyse.weekly_expiries(NOW - 15 * 7 * DAY, 16) if e < NOW]
E_SEP18, E_SEP25 = PAST[-2], PAST[-1]
SETTLE = {}


def settle_of(sym, e):
    if (sym, e) not in SETTLE:
        SETTLE[(sym, e)] = H.settlement(sym, FEEDS[sym], e, NOW)
    return SETTLE[(sym, e)]


def tx(tag):
    return "0x" + tag * 32


def run_book(order, tq, legs, session):
    """legs: (sym, strike, expiry, isCall, qty)."""
    us = [und_entry(s, session, tq.get(s, 0.0)) for s in order]
    ps = [{"u": order.index(sy), "isCall": c, "expiry": e, "strike": w(k), "qty": w(q)} for sy, k, e, c, q in legs]
    out, _ = K.margin(kparams(), us, ps)
    grid = K.scenario_grid(kparams(), us, ps)
    return out, grid


def payoff(sym, k, is_call, e):
    P = settle_of(sym, e)["price"]
    return max(0.0, (P - k) if is_call else (k - P))


VAULT_DEFS = [
    # launch: the first regular-session hour after the feeds' launch-week misprints cleared (Tue Jun 23)
    dict(address="0xa1" + "00" * 19, kind="coveredCall", underlying="NVDA", name="Novation Covered Call NVDA",
         symbol="nccNVDA", vol=0.52, step=5, launch=1782223200, deposit=2600.0, util=0.62, queued=42.5),
    dict(address="0xa2" + "00" * 19, kind="putWrite", underlying="NVDA", name="Novation Put Write NVDA",
         symbol="npwNVDA", vol=0.52, step=5, launch=1782223200, deposit=430000.0, util=0.48, queued=1250.0),
    dict(address="0xa3" + "00" * 19, kind="coveredCall", underlying="TSLA", name="Novation Covered Call TSLA",
         symbol="nccTSLA", vol=0.61, step=10, launch=1785159000, deposit=750.0, util=0.55, queued=12.0),
]


def build_vaults(ids):
    out_list, details, events = [], {}, []
    for v in VAULT_DEFS:
        sym = v["underlying"]
        spot = UND[sym]["spot"]
        r = H.replay_vault(v, FEEDS[sym], settle_of, HALTS[sym], NOW, spot)
        open_legs = r["positions"]
        samples = []
        t = (v["launch"] // DAY) * DAY + 20 * 3600
        while t < READ_AT:
            if t >= v["launch"]:
                samples.append(t)
            t += DAY
        samples.append(NOW)
        hist = H.nav_series(v, FEEDS[sym], r, samples, NOW, spot)
        week = H.nav_series(v, FEEDS[sym], r, [NOW - 7 * DAY], NOW, spot)[0]
        now_pt = hist[-1]
        navps = now_pt["nav"]
        is_call = v["kind"] == "coveredCall"
        locked = sum(p["qty"] for p in open_legs) if is_call else sum(p["qty"] * p["strike"] for p in open_legs)
        backing = r["tokens"] if is_call else r["cash"]
        queued = v["queued"] * navps
        free = max(0.0, backing - locked - queued)
        apy = (navps / week["nav"]) ** (365 / 7) - 1
        live = H.halted_at(HALTS[sym], NOW) is None
        entry = {"address": v["address"], "kind": v["kind"], "underlying": sym, "tvl": now_pt["tvl"], "nav": round(navps, 9),
                 "apy7d": round(apy, 6), "utilization": round(locked / (locked + free) if locked + free else 0, 6),
                 "epoch": len(r["epochs"]), "live": live}
        out_list.append(entry)
        open_series = [{"seriesId": ids[(sym, p["strike"], p["expiry"], is_call)], "underlying": sym, "expiry": p["expiry"],
                        "strike": p["strike"], "isCall": is_call, "qty": -p["qty"], "premium": p["premium"], "soldAt": p["soldAt"],
                        "mark": w_round(mark(sym, p["strike"], p["expiry"], is_call))} for p in open_legs]
        details[v["address"]] = dict(entry, name=v["name"], symbol=v["symbol"], asset=sym if is_call else "USDG",
                                     config=dict(H.VAULT_CFG), launchedAt=v["launch"], shares=r["shares"] - v["queued"],
                                     escrowedShares=v["queued"], navPerShare=round(navps, 9), backing=round(backing, 6),
                                     locked=round(locked, 6), queued=round(queued, 6), free=round(free, 6), cash=round(r["cash"], 6),
                                     tokens=round(r["tokens"], 6), openSeries=open_series, nextRoll=open_legs[0]["expiry"],
                                     cooldown=H.EXIT_COOLDOWN, navHistory=hist, epochs=r["epochs"], deficits=r["deficits"],
                                     markVol=v["vol"], fillShare=v["util"], navWeekAgo=week["nav"])
        for d in r["deficits"]:
            events.append({"at": d["settledAt"], "kind": "cover", "amount": d["bridged"], "who": v["name"], "expiry": d["expiry"]})
            events.append({"at": d["settledAt"] + 600, "kind": "recover", "amount": d["bridged"], "who": v["name"], "expiry": d["expiry"]})
    return out_list, details, events


# Account 12, the demo short book: short puts, NVDA as collateral. On Sep 25 it was a net payer it
# couldn't cover in cash; on Oct 2 shorts it now sits below maintenance margin.
A12_OWNER = "0x" + "12" * 20
A12_TOKENS0, A12_CASH_SEP25 = 5.0, 120.0
A12_SEP25 = [("NVDA", 215, True, -30.0)]
A12_LEGS = [("TSLA", 400, False, -10.0), ("NVDA", 240, False, -15.0)]
A12_SALE_MIN = 14  # minutes into the deficit sale when the bid landed
AUCTION = {"startDiscount": 0.02, "maxDiscount": 0.12, "duration": 1800, "maxFractionPerBid": 0.5, "penaltyBps": 100}


def discount(elapsed):
    return AUCTION["startDiscount"] + (AUCTION["maxDiscount"] - AUCTION["startDiscount"]) * min(elapsed, AUCTION["duration"]) / AUCTION["duration"]


def account_expiries(legs_by_expiry, cash_before, settled_at, claimed_after=120):
    out = []
    for e, legs in legs_by_expiry.items():
        rows = []
        net = 0.0
        for sym, k, c, q in legs:
            pay = payoff(sym, k, c, e)
            rows.append({"underlying": sym, "strike": k, "isCall": c, "qty": q, "settlePrice": round(settle_of(sym, e)["price"], 6),
                         "payoff": round(q * pay, 6)})
            net += q * pay
        st = settled_at[e]
        item = {"expiry": e, "net": round(net, 6), "legs": rows, "settledAt": st}
        if net >= 0:
            item.update(status="claimed", claimable=round(net, 6), readyAt=st + 60, claimedAt=st + 60 + claimed_after)
        else:
            owed = -net
            cash = cash_before.get(e, 1e12)
            paid = min(cash, owed)
            short = owed - paid
            item.update(status="paid", paidCash=round(paid, 6))
            if short > 1e-9:
                item.update(status="deficit-cleared", bridged=math.ceil(short), shortfall=round(short, 6))
        out.append(item)
    return out


def build_world(ids, chains, acct, mm):
    vaults, vdetails, ins_events = build_vaults(ids)
    settled_at = {e: max(settle_of(s, e)["settledAt"] for s in UND) for e in (E_SEP18, E_SEP25)}

    # ---- account 7 history: both expiries paid it; the keeper claimed right after the pool opened
    a7_hist = {E_SEP18: [("NVDA", 215, True, 10.0), ("TSLA", 360, False, -6.0)],
               E_SEP25: [("NVDA", 235, True, -20.0), ("SPY", 760, True, 4.0)]}
    a7 = account_expiries(a7_hist, {}, settled_at)
    a12 = account_expiries({E_SEP25: list(A12_SEP25)}, {E_SEP25: A12_CASH_SEP25}, settled_at)
    d12 = a12[0]
    sale_start = settled_at[E_SEP25]
    sale_at = sale_start + A12_SALE_MIN * 60
    d = discount(sale_at - sale_start)
    sale_spot = H.spot_at(FEEDS["NVDA"], sale_at)
    sale_price = sale_spot * (1 - d)
    sold = d12["bridged"] / sale_price
    d12.update(deficitSale={"startedAt": sale_start, "bidAt": sale_at, "discount": round(d, 6), "spot": round(sale_spot, 6),
                            "price": round(sale_price, 6), "tokensSold": round(sold, 6), "proceeds": d12["bridged"]},
               clearedAt=sale_at)
    ins_events += [{"at": sale_start, "kind": "cover", "amount": d12["bridged"], "who": "Account 12", "expiry": E_SEP25},
                   {"at": sale_at, "kind": "recover", "amount": d12["bridged"], "who": "Account 12", "expiry": E_SEP25}]

    # ---- account 12 now
    order12 = ["NVDA", "TSLA"]
    tq12 = {"NVDA": round(A12_TOKENS0 - sold, 6), "TSLA": 0.0}
    legs12 = [(sy, k, EXPIRIES[0], c, q) for sy, k, c, q in A12_LEGS]
    res12 = {}
    for sess in ("REGULAR", "EXTENDED", "WEEKEND"):
        out, grid = run_book(order12, tq12, legs12, sess)
        res12[sess] = {"out": out, "grid": [w_round(f(x), 6) for x in grid], "im": w_round(f(out["lossIM"]), 6),
                       "shockRange": {s: w_round(shock_range(UND[s]["vol"], sess), 6) for s in order12}}
    out12 = res12["REGULAR"]["out"]
    im12 = f(out12["lossIM"])
    cash12 = round(0.93 * im12 * MM_RATIO - f(out12["mtm"]), 2)  # demo: cash that leaves equity at 93% of MM
    assert cash12 > 0, cash12
    st12 = account_state(cash12, out12)
    assert st12["liquidatable"], st12
    pos12 = [{"seriesId": ids[(sy, k, e, c)], "qty": q, "mark": w_round(mark(sy, k, e, c)), "id": ids[(sy, k, e, c)],
              "underlying": sy, "expiry": e, "strike": k, "isCall": c} for sy, k, e, c, q in legs12]
    account12 = {"account": {"id": 12, "owner": A12_OWNER, "state": st12, "positions": pos12, "collateral": {"NVDA": tq12["NVDA"]}},
                 "grids": {s: {"cells": res12[s]["grid"], "shockRange": res12[s]["shockRange"], "im": res12[s]["im"]} for s in res12},
                 "summary": {"im_regular": res12["REGULAR"]["im"], "im_extended": res12["EXTENDED"]["im"], "im_weekend": res12["WEEKEND"]["im"]}}

    # its refused ticket two hours ago: sell 5 more TSLA 380 puts at the chain bid
    row = next(x for x in chains["TSLA"]["series"] if x["strike"] == 380 and not x["isCall"] and x["expiry"] == EXPIRIES[0])
    prem = w_round(5 * row["bid"])
    fee = w_round(prem * FEE_BPS / 1e4)
    out_r, _ = run_book(order12, tq12, legs12 + [("TSLA", 380, EXPIRIES[0], False, -5.0)], "REGULAR")
    after_r = account_state(cash12 + prem - fee, out_r)
    assert not after_r["healthy"]
    ref12 = {"code": "InsufficientMargin", "message": "Initial margin after the trade exceeds equity.",
             "numbers": {"im": after_r["im"], "equity": after_r["equity"]}, "at": NOW - 7200, "txHash": tx("3e"), "account": 12,
             "detail": "Sell 5 TSLA 380 puts at %.2f" % row["bid"]}

    # the liquidation auction on account 12, started 11 minutes before the snapshot
    started = NOW - 660
    v12 = st12["equity"]
    auctions = [dict({"id": 1, "kind": "liquidation", "account": 12, "startedAt": started}, **AUCTION,
                     equity=v12, im=st12["im"], mm=st12["mm"], transferable=v12, underlyings=order12, status="active")]

    # ---- pools: the demo books for the two settled expiries, the demo maker on the other side
    books = {E_SEP18: {7: a7_hist[E_SEP18]}, E_SEP25: {7: a7_hist[E_SEP25], 12: list(A12_SEP25)}}
    for v in vdetails.values():
        for ep in v["epochs"]:
            if ep["expiry"] in books:
                books[ep["expiry"]].setdefault(v["address"], []).append((v["underlying"], ep["strike"], v["kind"] == "coveredCall", -ep["qty"]))
    pools, a1_hist = [], {}
    for e, accts in books.items():
        maker = [(sy, k, c, -q) for legs in accts.values() for sy, k, c, q in legs]
        a1_hist[e] = maker
        allb = dict(accts)
        allb[1] = maker
        paid = claims = bridged = short_qty = 0.0
        for who, legs in allb.items():
            net = sum(q * payoff(sy, k, c, e) for sy, k, c, q in legs)
            short_qty += sum(-q for sy, k, c, q in legs if q < 0)
            if net >= 0:
                claims += net
            elif who == 12:
                paid += d12["paidCash"] + d12["bridged"]
                bridged += d12["bridged"]
            else:
                vd = next((dd for vv in vdetails.values() if vv["address"] == who for dd in vv["deficits"] if dd["expiry"] == e), None)
                if vd:
                    paid += vd["paidCash"] + vd["bridged"]
                    bridged += vd["bridged"]
                else:
                    paid += -net
        prices = [dict(settle_of(s, e), symbol=s) for s in UND]
        pools.append({"expiry": e, "status": "closed", "prices": prices, "paidIn": round(paid, 6), "bridged": round(bridged, 6),
                      "pending": 0.0, "claims": round(claims, 6), "claimed": round(claims, 6), "unsettledShortQty": 0.0,
                      "shortQtySettled": round(short_qty, 6), "readyAt": settled_at[e] + 60, "accounts": len(allb),
                      "settledAt": settled_at[e]})
    a1 = account_expiries(a1_hist, {}, settled_at)

    # open expiry: short contracts across the demo books (account 7, account 12, the vaults, the maker)
    open_books = {7: [(p["underlying"], p["strike"], p["expiry"], p["isCall"], p["qty"]) for p in acct["positions"]],
                  12: legs12, 1: [(p["underlying"], p["strike"], p["expiry"], p["isCall"], p["qty"]) for p in mm["positions"]]}
    for v in vdetails.values():
        open_books[v["address"]] = [(o["underlying"], o["strike"], o["expiry"], o["isCall"], o["qty"]) for o in v["openSeries"]]
    oi = {s: {"underlying": s, "shortContracts": 0.0, "notionalUsd": 0.0} for s in UND}
    for legs in open_books.values():
        for sy, k, e, c, q in legs:
            if q < 0:
                oi[sy]["shortContracts"] += -q
                oi[sy]["notionalUsd"] += -q * UND[sy]["spot"]
    for o in oi.values():
        o["shortContracts"] = round(o["shortContracts"], 6)
        o["notionalUsd"] = round(o["notionalUsd"], 2)
    e0_short = sum(-q for legs in open_books.values() for sy, k, e, c, q in legs if q < 0 and e == EXPIRIES[0])
    pools.append({"expiry": EXPIRIES[0], "status": "open", "prices": [], "paidIn": 0.0, "bridged": 0.0, "pending": 0.0, "claims": 0.0,
                  "claimed": 0.0, "unsettledShortQty": round(e0_short, 6), "readyAt": None, "accounts": len(open_books), "settledAt": None})

    def projection(legs, cash):
        """What the open expiry pays or receives if it settled at today's spot."""
        rows = []
        net = 0.0
        for sy, k, e, c, q in legs:
            if e != EXPIRIES[0]:
                continue
            pay = max(0.0, (UND[sy]["spot"] - k) if c else (k - UND[sy]["spot"]))
            rows.append({"underlying": sy, "strike": k, "isCall": c, "qty": q, "settlePrice": UND[sy]["spot"], "payoff": round(q * pay, 6)})
            net += q * pay
        item = {"expiry": EXPIRIES[0], "status": "open", "net": round(net, 6), "legs": rows, "cash": cash}
        if net < 0:
            item["shortfall"] = round(max(0.0, -net - cash), 6)
        return item

    settlement = {
        "pools": pools,
        "accounts": {
            "7": [projection(open_books[7], acct["state"]["cash"])] + sorted(a7, key=lambda x: -x["expiry"]),
            "12": [projection(legs12, cash12)] + a12,
            "1": [projection(open_books[1], mm["state"]["cash"])] + sorted(a1, key=lambda x: -x["expiry"]),
        },
    }

    # ---- insurance fund: seeded at launch; every cover so far was repaid by its collateral sale
    seed = 25000.0
    ins_events.append({"at": 1782223200, "kind": "seed", "amount": seed, "who": "Deployer"})
    ins_events.sort(key=lambda x: x["at"])
    covered = sum(x["amount"] for x in ins_events if x["kind"] == "cover")
    recovered = sum(x["amount"] for x in ins_events if x["kind"] == "recover")
    insurance = {"balance": round(seed + recovered - covered, 6), "outstanding": round(covered - recovered, 6), "socialized": 0.0,
                 "cashIndex": 1.0, "events": ins_events}

    # ---- feeds and sessions
    feeds = []
    for sy in UND:
        fd = FEEDS[sy]
        feeds.append({
            "symbol": sy, "proxy": fd["proxy"], "description": fd["description"], "session": nyse.base_session(NOW),
            "spot": UND[sy]["spot"], "lastRound": fd["rounds"][-1][0], "band": list(H.BAND[sy]),
            "staleLimits": dict(H.STALE), "haltWindow": H.HALT_WINDOW,
            "uiMultiplier": H.TOKEN_STATE[sy]["uiMultiplier"], "lastMultiplierChange": H.TOKEN_STATE[sy]["effectiveAt"] or None,
            "oraclePaused": H.TOKEN_STATE[sy]["oraclePaused"], "paused": H.TOKEN_STATE[sy]["paused"],
            "corporateAction": H.CORPORATE_ACTIONS.get(sy), "halts": HALTS[sy],
            "historyFrom": fd["rounds"][0][2], "historyTo": READ_AT, "rounds": len(fd["rounds"]),
        })
    risk = {"feeds": feeds, "auctions": auctions, "insurance": insurance, "openInterest": list(oi.values()),
            "params": dict({"maxSettlementLag": H.MAX_SETTLEMENT_LAG, "fallbackAfter": H.FALLBACK_AFTER, "volStaleness": H.VOL_STALENESS}, **AUCTION)}

    # ---- the demo owner's wallet (account 7's owner)
    wallet = {"owner": acct["owner"], "tokens": {"NVDA": 12.5, "TSLA": 0.0, "USDG": 4800.0},
              "vaults": [
                  {"vault": VAULT_DEFS[0]["address"], "shares": 18.0, "lastReceive": NOW - 25 * 60, "pendingShares": 0.0},
                  {"vault": VAULT_DEFS[1]["address"], "shares": 2100.0, "lastReceive": NOW - 15 * DAY, "pendingShares": 400.0},
              ]}

    premium7d = sum(o["premium"] for v in vdetails.values() for o in v["openSeries"] if o["soldAt"] >= NOW - 7 * DAY)
    protocol = {"openInterestUsd": round(sum(o["notionalUsd"] for o in oi.values()), 2),
                "vaultTvlUsd": round(sum(v["tvl"] for v in vaults), 2), "insuranceFundUsd": insurance["balance"],
                "premium7dUsd": round(premium7d, 2), "liquidations7d": len(auctions), "socializedUsd": 0.0}
    return {"vaults": vaults, "vaultDetails": vdetails, "account12": account12, "settlement": settlement, "risk": risk,
            "wallet": wallet, "protocol": protocol, "ref12": ref12}


def agent_premium_refusal(chains):
    """hedge-bot buys 50 NVDA 215 calls at the ask: risk goes down, but the premium is over its 500 cap."""
    row = next(x for x in chains["NVDA"]["series"] if x["strike"] == 215 and x["isCall"] and x["expiry"] == EXPIRIES[0])
    prem = w_round(50 * row["ask"])
    order, tq, held = book7(None)
    out, _ = run_book(order, tq, [(s, k, EXPIRIES[0], c, q) for s, k, c, q in held] + [("NVDA", 215, EXPIRIES[0], True, 50.0)], "REGULAR")
    assert f(out["lossIM"]) <= AGENT_BUDGET and prem > AGENT_PREMIUM_CAP
    return {"code": "AgentPremiumExceeded", "message": "Premium exceeds the agent's per-trade cap.",
            "numbers": {"premium": prem, "cap": AGENT_PREMIUM_CAP}, "at": NOW - 5400, "txHash": tx("5a"), "account": 7,
            "agent": AGENT, "detail": "Buy 50 NVDA 215 calls at %.2f" % row["ask"]}


def main():
    os.makedirs(OUT, exist_ok=True)
    chains, ids = build_chain()
    acct, res, summary = build_account7(ids)
    whatif = build_whatif(ids, chains, acct, res)
    mm = build_mm(ids)

    underlyings = []
    for i, (sym, u) in enumerate(UND.items()):
        addr = "0x" + ("%02x" % (i + 1)) * 20
        underlyings.append({"address": addr, "symbol": sym, "name": u["name"], "spot": u["spot"],
                            "session": nyse.base_session(NOW), "markVol": u["vol"],
                            "uiMultiplier": u["ui"], "halted": False})

    world = build_world(ids, chains, acct, mm)
    protocol, vaults = world["protocol"], world["vaults"]
    wi = whatif["quote"]["refusal"]  # kernel-computed; shared by agents, feed and what-if
    assert wi["code"] == "AgentRiskBudgetExceeded", wi
    last_ref = {"code": wi["code"],
                "message": "Worst-case loss %.2f exceeds the risk budget of %.2f." % (
                    wi["numbers"]["worstLoss"], wi["numbers"]["budget"]),
                "numbers": dict(wi["numbers"]),
                "txHash": "0x" + "7c" * 32}
    # used: the account's current worst-case loss (lossIM), which the budget caps (spec 4.7).
    agents = {"7": [
        {"agent": AGENT, "label": "hedge-bot", "maxWorstLoss": AGENT_BUDGET,
         "maxPremiumPerTrade": AGENT_PREMIUM_CAP, "allowed": ["NVDA", "SPY"], "expiresAt": NOW + 30 * DAY,
         "used": acct["state"]["im"], "lastRefusal": last_ref},
        # demo: a second agent on the same account, connected over MCP; the budget caps the same lossIM
        {"agent": "0x" + "d3" * 20, "label": "mcp-desk", "maxWorstLoss": 1000.0, "maxPremiumPerTrade": 250.0,
         "allowed": ["NVDA", "TSLA"], "expiresAt": NOW + 7 * DAY, "used": acct["state"]["im"]},
        # demo: an expired grant; trades signed by it revert NotAuthorized until the owner grants again
        {"agent": "0x" + "e1" * 20, "label": "rebalancer", "maxWorstLoss": 800.0, "maxPremiumPerTrade": 150.0,
         "allowed": ["SPY"], "expiresAt": NOW - 9 * DAY, "used": acct["state"]["im"]},
    ]}
    halt = next(e for e in HALTS["NVDA"] if e["reason"] == "multiplier")
    refusals = sorted([
        dict(last_ref, at=NOW - 3600, account=7, agent=AGENT, detail="Sell 60 NVDA 200 calls through RFQ at %.2f" % (whatif["premium"] / 60)),
        agent_premium_refusal(chains),
        world["ref12"],
        {"code": "OpeningNotAllowed", "message": "Opening trades are closed while the underlying is halted.",
         "at": halt["from"] + 14 * 3600 + 5 * 60, "txHash": tx("2b"), "account": 1, "detail": "Buy 20 NVDA 230 calls",
         "haltReason": "multiplier", "effectiveAt": halt["detail"]["effectiveAt"]},
        {"code": "VaultNotLive", "message": "The vault is not live while its underlying is halted.",
         "at": halt["from"] + 15 * 3600 + 30 * 60, "txHash": tx("9d"), "detail": "Deposit 10 NVDA into nccNVDA",
         "vault": VAULT_DEFS[0]["address"], "haltReason": "multiplier", "effectiveAt": halt["detail"]["effectiveAt"]},
    ], key=lambda r: -r["at"])

    files = {
        "underlyings.json": underlyings,
        "chains.json": chains,
        "account7.json": {"account": acct, "grids": {s: {"cells": res[s]["grid"], "shockRange": res[s]["shockRange"], "im": res[s]["im"]} for s in res},
                          "summary": summary},
        "whatifs.json": [whatif],
        "market-maker.json": mm,
        "vaults.json": vaults,
        "agents.json": agents,
        "protocol.json": protocol,
        "refusals.json": refusals,
        "gas.json": gas_table(),
        "account12.json": world["account12"],
        "vault-details.json": world["vaultDetails"],
        "settlement.json": world["settlement"],
        "risk.json": world["risk"],
        "wallet.json": world["wallet"],
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
