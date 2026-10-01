"""Replays the real Chainlink round history from Robinhood Chain (data/rh_rounds.json) through the
contract rules the app shows:

- MarketDataHub halts: NyseCalendar sessions, per-session staleness limits, the plausibility band,
  answer <= 0 and the ERC-8056 multiplier window;
- MarketDataHub.settlementPrice: the last print at or before the weekly close, with its proof, or
  the 72 h fallback;
- the option vaults' weekly strategy (OptionVaultBase quote formula, covered-call and
  cash-secured-put cover rules), marked with Black-Scholes at mark vol (fpmath, bit-exact).

Deployment parameters are not on chain yet; the values below are the test fixture's defaults
(contracts/test/utils/Fixture.sol, VaultFixture.sol) and are labelled demo in the app.
"""

import bisect
import json
import math
import os

import fpmath as F
import nyse

HERE = os.path.dirname(os.path.abspath(__file__))
WAD = 10**18
DAY = 86400
HOUR = 3600

# MarketDataHub / RiskParams demo deployment (Fixture.sol defaults).
STALE = {"REGULAR": 93600, "EXTENDED": 93600, "CLOSED": 345600}
HALT_WINDOW = 86400
MULTIPLIER_AFTER = 3600
MAX_SETTLEMENT_LAG = 87300
FALLBACK_AFTER = 72 * HOUR
VOL_STALENESS = 172800
# Plausibility band [minPrice, maxPrice] per underlying (USD), about a tenth to ten times the price.
BAND = {"NVDA": (20.0, 2000.0), "TSLA": (30.0, 3000.0), "SPY": (70.0, 7000.0), "AAPL": (30.0, 3000.0)}

# Token state read on-chain on 2026-09-25: uiMultiplier and the effectiveAt
# of the last multiplier change. No change was pending (newUIMultiplier == uiMultiplier).
TOKEN_STATE = {
    "NVDA": {"uiMultiplier": 1.000775159164630595, "effectiveAt": 1788998430, "oraclePaused": False, "paused": False},
    "TSLA": {"uiMultiplier": 1.0, "effectiveAt": 0, "oraclePaused": False, "paused": False},
    "SPY": {"uiMultiplier": 1.001717991187472003, "effectiveAt": 1789690233, "oraclePaused": False, "paused": False},
    "AAPL": {"uiMultiplier": 1.000566080061092436, "effectiveAt": 1786720366, "oraclePaused": False, "paused": False},
}
# Robinhood corporate-actions API, read 2026-09-25: NVDA cash dividend $0.25, IN_PROGRESS, process date 2026-10-01.
CORPORATE_ACTIONS = {
    "NVDA": {"kind": "Cash dividend", "amount": 0.25, "status": "In progress", "processDate": "2026-10-01"},
}


# ---------------------------------------------------------------- rounds


def load_feeds():
    with open(os.path.join(HERE, "data", "rh_rounds.json"), encoding="utf-8") as fh:
        d = json.load(fh)
    feeds = {}
    for sym, f in d["feeds"].items():
        rows = sorted(((r[0], r[1], r[2]) for r in f["rounds"]), key=lambda r: (r[2], r[0]))
        feeds[sym] = {
            "proxy": f["proxy"],
            "description": f["description"],
            "decimals": f["decimals"],
            "rounds": rows,
            "times": [r[2] for r in rows],
        }
    return d["readAt"], feeds


def px(feed, r):
    return r[1] / 10 ** feed["decimals"]


def wad(feed, r):
    return r[1] * 10 ** (18 - feed["decimals"])


def in_band(sym, price):
    lo, hi = BAND[sym]
    return price > 0 and lo <= price <= hi


def last_at_or_before(feed, ts):
    i = bisect.bisect_right(feed["times"], ts) - 1
    return feed["rounds"][i] if i >= 0 else None


def first_after(feed, ts):
    i = bisect.bisect_right(feed["times"], ts)
    return feed["rounds"][i] if i < len(feed["rounds"]) else None


def spot_at(feed, ts):
    r = last_at_or_before(feed, ts)
    return px(feed, r) if r else None


# ---------------------------------------------------------------- calendar helpers


def utc_of(day, sec):
    """UTC timestamp of ET-local `sec` seconds into ET day `day` (same DST rule as close_timestamp)."""
    base = day * DAY + sec
    cand = base + 4 * HOUR
    return cand if nyse.is_dst(cand) else base + 5 * HOUR


def session_class(ts):
    s = nyse.base_session(ts)
    return s if s in ("REGULAR", "EXTENDED") else "CLOSED"


def next_open(ts):
    """First 09:30 ET on a trading day at or after ts."""
    day = nyse.et_parts(ts)[0]
    for d in range(day, day + 10):
        if not nyse.is_trading_day(d):
            continue
        t = utc_of(d, 34200)
        if t >= ts:
            return t
    raise RuntimeError("no open within 10 days")


def _boundaries(a, b):
    d0 = nyse.et_parts(a)[0] - 1
    d1 = nyse.et_parts(b)[0] + 1
    out = set()
    for d in range(d0, d1 + 1):
        for sec in (0, 34200, 46800, 57600, 72000):
            t = utc_of(d, sec)
            if a < t < b:
                out.add(t)
    return sorted(out)


# ---------------------------------------------------------------- halts


def halt_history(sym, feed, end):
    """HALTED episodes the hub would have reported between the feed's first round and `end`."""
    rounds = feed["rounds"]
    eps = []

    # Implausible prints (outside the band) and answer <= 0: from the bad round to the next good one.
    i = 0
    while i < len(rounds):
        if not in_band(sym, px(feed, rounds[i])):
            j = i
            while j < len(rounds) and not in_band(sym, px(feed, rounds[j])):
                j += 1
            to = rounds[j][2] if j < len(rounds) else end
            worst = max(px(feed, r) for r in rounds[i:j])
            eps.append({
                "reason": "implausible",
                "from": rounds[i][2],
                "to": to,
                "detail": {"firstRound": rounds[i][0], "lastRound": rounds[j - 1][0], "rounds": j - i,
                           "price": round(worst, 2), "band": list(BAND[sym]),
                           "resumedRound": rounds[j][0] if j < len(rounds) else None},
            })
            i = j
        else:
            i += 1

    # Stale feed: age of the last print above the current session's limit.
    for k, r in enumerate(rounds):
        u = r[2]
        nxt = rounds[k + 1][2] if k + 1 < len(rounds) else end
        if nxt <= u:
            continue
        cuts = [u] + _boundaries(u, nxt) + [nxt]
        run = None
        for a, b in zip(cuts, cuts[1:]):
            limit = STALE[session_class(a)]
            h0 = max(a, u + limit + 1)
            if h0 < b:
                if run and run["to"] == h0:
                    run["to"] = b
                else:
                    run = {"reason": "stale", "from": h0, "to": b,
                           "detail": {"lastRound": r[0], "lastAt": u, "limit": limit,
                                      "session": session_class(a), "nextRound": rounds[k + 1][0] if k + 1 < len(rounds) else None}}
                    eps.append(run)
    # A stale run inside an implausible run adds nothing.
    bad = [e for e in eps if e["reason"] == "implausible"]
    eps = [e for e in eps if e["reason"] != "stale" or not any(b["from"] <= e["from"] and e["to"] <= b["to"] for b in bad)]

    # Multiplier change: [effectiveAt - haltWindow, effectiveAt + 1h].
    ea = TOKEN_STATE[sym]["effectiveAt"]
    if ea:
        eps.append({"reason": "multiplier", "from": ea - HALT_WINDOW, "to": ea + MULTIPLIER_AFTER,
                    "detail": {"effectiveAt": ea, "uiMultiplier": TOKEN_STATE[sym]["uiMultiplier"], "haltWindow": HALT_WINDOW}})
    eps.sort(key=lambda e: e["from"])
    for e in eps:
        e["symbol"] = sym
    return eps


def halted_at(eps, ts):
    for e in eps:
        if e["from"] <= ts < e["to"]:
            return e
    return None


# ---------------------------------------------------------------- settlement


def settlement(sym, feed, expiry, now, keeper_delay=180):
    """MarketDataHub.settlementPrice as a keeper would call it: right after the close with the
    latest-round proof, else with the next round, else the 72 h fallback."""
    pre = last_at_or_before(feed, expiry)
    t = expiry + keeper_delay
    ok = pre is not None and in_band(sym, px(feed, pre)) and expiry - pre[2] <= MAX_SETTLEMENT_LAG
    if ok:
        after = first_after(feed, expiry)
        if after is None or after[2] > t:
            proof = {"kind": "latest"}
        else:
            proof = {"kind": "next", "round": after[0], "at": after[2]}
        return {"symbol": sym, "method": "last print", "round": pre[0], "price": px(feed, pre), "priceWad": str(wad(feed, pre)),
                "updatedAt": pre[2], "lag": expiry - pre[2], "proof": proof, "settledAt": t}
    after = first_after(feed, expiry)
    if after is not None and in_band(sym, px(feed, after)) and now >= expiry + FALLBACK_AFTER:
        why = "stale" if pre is not None and expiry - pre[2] > MAX_SETTLEMENT_LAG else "implausible"
        return {"symbol": sym, "method": "fallback", "round": after[0], "price": px(feed, after), "priceWad": str(wad(feed, after)),
                "updatedAt": after[2], "lag": (expiry - pre[2]) if pre else None, "reason": why,
                "proof": {"kind": "fallback", "preRound": pre[0] if pre else None, "preAt": pre[2] if pre else None},
                "settledAt": max(after[2], expiry + FALLBACK_AFTER) + keeper_delay}
    return {"symbol": sym, "method": "waiting", "round": None, "price": None, "updatedAt": None}


# ---------------------------------------------------------------- vaults


VAULT_CFG = {  # VaultFixture.sol defaults
    "minOtm": 0.05, "maxTenorDays": 35, "skewSlope": 0.5, "utilSlope": 0.3, "spread": 0.02,
    "sessionVolAdd": {"REGULAR": 0.0, "EXTENDED": 0.05, "WEEKEND": 0.15, "HOLIDAY": 0.1},
    "maxTradeQty": 500.0, "maxOpenSeries": 24, "minDelta": 0.05, "maxDelta": 0.5, "minNewSeriesQty": 1.0,
}
EXIT_COOLDOWN = HOUR
DEFICIT_SALE_DISCOUNT = 0.02  # assumed: a bidder takes the deficit sale at the opening discount


def bs(S, K, tau, vol, is_call):
    return F.price(int(round(S * WAD)), int(round(K * WAD)), max(0, int(tau)), int(round(vol * WAD)), 0, is_call) / WAD


def delta(S, K, tau, vol, is_call):
    if tau <= 0:
        return 1.0 if (is_call and S > K) else (-1.0 if (not is_call and S < K) else 0.0)
    return F.greeks(int(round(S * WAD)), int(round(K * WAD)), int(tau), int(round(vol * WAD)), 0, is_call)[0] / WAD


def pick_strike(S, tau, vol, step, is_call):
    cfg = VAULT_CFG
    if is_call:
        k = math.ceil(S * (1 + cfg["minOtm"]) / step) * step
        for _ in range(20):
            d = abs(delta(S, k, tau, vol, True))
            if d > cfg["maxDelta"]:
                k += step
            elif d < cfg["minDelta"]:
                return None
            else:
                return k
    else:
        k = math.floor(S * (1 - cfg["minOtm"]) / step) * step
        for _ in range(20):
            d = abs(delta(S, k, tau, vol, False))
            if d > cfg["maxDelta"]:
                k -= step
            elif d < cfg["minDelta"]:
                return None
            else:
                return k
    return None


def replay_vault(v, feed, settle_of, halts, now, now_spot):
    """Runs one vault week by week. `v`: kind, underlying, vol, step, launch, deposit (asset units),
    util (share of capacity takers buy at each roll). Returns history and the state at `now`."""
    is_call = v["kind"] == "coveredCall"
    sym, vol, step = v["underlying"], v["vol"], v["step"]
    tokens = v["deposit"] if is_call else 0.0
    cash = 0.0 if is_call else v["deposit"]
    s0 = spot_at(feed, v["launch"])
    shares = v["deposit"]  # 24-decimal shares: one share per asset unit at launch
    pos = []  # open shorts: dict(expiry, strike, qty, premium, soldAt, spot)
    epochs, deficits, marks = [], [], []
    t = v["launch"]
    epoch = 0

    def equity_at(ts, S):
        val = tokens * S + cash
        for p in pos:
            tau = p["expiry"] - ts
            val -= p["qty"] * (bs(S, p["strike"], tau, vol, is_call) if tau > 0 else max(0.0, (S - p["strike"]) if is_call else (p["strike"] - S)))
        return val

    def navps(ts, S):
        e = equity_at(ts, S)
        return (e / S if is_call else e) / shares

    sale_at = v["launch"]
    while True:
        expiry = nyse.next_weekly_expiry(sale_at)
        if expiry > now + 14 * DAY:
            break
        # marks every day at 20:00 UTC until the sale (between rolls)
        S = spot_at(feed, sale_at) if sale_at <= now else now_spot
        h = halted_at(halts, sale_at)
        if h is not None:  # not live: sell at the first moment after the halt
            sale_at = next_open(h["to"])
            continue
        tau = expiry - sale_at
        k = pick_strike(S, tau, vol, step, is_call)
        if k is None:
            raise RuntimeError("no strike in the offer band")
        if is_call:
            qty = math.floor(v["util"] * tokens)
            util = qty / tokens
        else:
            qty = math.floor(v["util"] * cash / k)
            util = qty * k / cash
        sess = nyse.base_session(sale_at)
        volq = vol * (1 + VAULT_CFG["skewSlope"] * abs(math.log(k / S)) + VAULT_CFG["utilSlope"] * util) + VAULT_CFG["sessionVolAdd"][sess]
        price = bs(S, k, tau, volq, is_call)
        premium = round(qty * price * (1 + VAULT_CFG["spread"]), 6)
        cash += premium
        nav_before = navps(sale_at, S)
        pos.append({"expiry": expiry, "strike": k, "qty": qty, "premium": premium, "soldAt": sale_at, "spot": S,
                    "vol": round(volq, 6), "util": round(util, 6), "price": round(price, 6)})
        if expiry > now:
            break
        st = settle_of(sym, expiry)
        P = st["price"]
        payout = qty * max(0.0, (P - k) if is_call else (k - P))
        paid_cash = min(cash, payout)
        cash -= paid_cash
        short = payout - paid_cash
        sold_tokens = 0.0
        if short > 1e-9:
            bridged = math.ceil(short)  # bridge rounded up to a whole USDG unit
            sale_price = P * (1 - DEFICIT_SALE_DISCOUNT)
            sold_tokens = bridged / sale_price
            tokens -= sold_tokens
            cash += bridged - short  # the round-up stays with the account as cash
            deficits.append({"expiry": expiry, "owed": round(payout, 6), "paidCash": round(paid_cash, 6), "bridged": bridged,
                             "soldTokens": round(sold_tokens, 6), "salePrice": round(sale_price, 6), "settledAt": st["settledAt"]})
        pos.pop()
        epoch += 1
        epochs.append({
            "epoch": epoch, "expiry": expiry, "strike": k, "qty": qty, "premium": premium, "soldAt": sale_at,
            "spotAtSale": round(S, 6), "volQuoted": round(volq, 6), "settlePrice": round(P, 6), "settleRound": st["round"],
            "payout": round(payout, 6), "deficit": round(short, 6), "navBefore": round(nav_before, 9),
            "navAfter": round(navps(st["settledAt"], spot_at(feed, st["settledAt"])), 9),
        })
        sale_at = next_open(st["settledAt"])

    return {"tokens": tokens, "cash": cash, "shares": shares, "positions": pos, "epochs": epochs, "deficits": deficits,
            "launchSpot": s0}


def nav_series(v, feed, res, sample_times, now, now_spot):
    """NAV per share at each sample time, re-running the book from the epoch log."""
    is_call = v["kind"] == "coveredCall"
    vol = v["vol"]
    out = []
    # book timeline: each epoch holds its short from soldAt to settlement; deficits change tokens at settlement
    legs = [dict(e, settledAt=e["expiry"] + 180) for e in res["epochs"]]
    open_leg = res["positions"][-1] if res["positions"] else None
    defs = {d["expiry"]: d for d in res["deficits"]}
    for ts in sample_times:
        S = now_spot if ts >= now else spot_at(feed, ts)
        if S is None:
            continue
        tokens = v["deposit"] if is_call else 0.0
        cash = 0.0 if is_call else v["deposit"]
        shorts = []
        for e in legs:
            if e["soldAt"] > ts:
                break
            cash += e["premium"]
            if ts >= e["settledAt"]:
                paid = e["payout"] - e["deficit"]
                cash -= paid
                d = defs.get(e["expiry"])
                if d:
                    tokens -= d["soldTokens"]
                    cash += d["bridged"] - (d["owed"] - d["paidCash"])
            else:
                shorts.append(e)
        if open_leg and open_leg["soldAt"] <= ts and not any(e["expiry"] == open_leg["expiry"] for e in legs):
            cash += open_leg["premium"]
            shorts.append(open_leg)
        val = tokens * S + cash
        for e in shorts:
            tau = e["expiry"] - ts
            intrinsic = max(0.0, (S - e["strike"]) if is_call else (e["strike"] - S))
            val -= e["qty"] * (bs(S, e["strike"], tau, vol, is_call) if tau > 0 else intrinsic)
        nav = (val / S if is_call else val) / res["shares"]
        out.append({"t": ts, "nav": round(nav, 9), "tvl": round(val, 2), "spot": round(S, 6)})
    return out
