"""End-to-end proof on a live Novation deployment (RH testnet by default, Stylus kernel).

  python tools/e2e/scenario.py [--rpc URL]

Reads contracts/deployments/<chainId>.json and the forge ABIs in contracts/out, sends real
transactions and writes every hash to tools/e2e/out/<chainId>.json:
  1. the user (the deployer key) opens a subaccount and deposits mock USDG + NVDA;
  2. syncs NVDA vol and buys a call from the NVDA covered-call vault;
  3. fills an RFQ quote signed by a throwaway maker key (the maker buys puts from the user);
  4. grants an agent (throwaway key) a risk budget on a second subaccount: an in-budget trade
     passes, an over-budget one is sent with a manual gas limit and reverts on-chain with
     AgentRiskBudgetExceeded;
  5. a withdrawal that would leave the user's account below initial margin reverts on-chain with
     InsufficientMargin;
plus the gas proof: eth_estimateGas of kernel.margin for a 256-position book under the 32M
transaction cap, Stylus kernel vs the Solidity KernelReference.

Keys: DEPLOYER_PRIVATE_KEY from the env or .env. The maker and agent keys are generated once and
kept in E2E_KEYS_FILE (default: the system temp dir), never in the repo, and never printed.
"""
import argparse
import json
import math
import os
import sys
import tempfile
import time
import warnings
from datetime import datetime, timezone

warnings.filterwarnings("ignore")
from eth_account import Account  # noqa: E402
from eth_utils import keccak  # noqa: E402
from web3 import Web3  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools", "stylus-deploy"))
from parity import margin_data  # noqa: E402

W = 10**18
TX_CAP = 32_000_000
EXPLORER = "https://explorer.testnet.chain.robinhood.com"


def load_env():
    p = os.path.join(ROOT, ".env")
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


def abi(name, file=None):
    p = os.path.join(ROOT, "contracts", "out", f"{file or name}.sol", f"{name}.json")
    return json.load(open(p))["abi"]


def selector(sig):
    return "0x" + keccak(text=sig)[:4].hex()


class Runner:
    def __init__(self, w3, out):
        self.w3 = w3
        self.out = out
        self.spent = {}

    def send(self, acct, fn=None, *, to=None, value=0, gas=None, label, expect_revert=None):
        """Sends a tx and waits for it. With expect_revert, the tx must fail on-chain."""
        w3 = self.w3
        tx = {"from": acct.address, "value": value}
        if fn is not None:
            tx = fn.build_transaction({"from": acct.address, "value": value, "gas": 1})
            tx.pop("gas", None)
        else:
            tx["to"] = to
        base = w3.eth.gas_price
        if gas is None:
            gas = int(w3.eth.estimate_gas({k: tx[k] for k in ("from", "to", "data", "value") if k in tx}) * 1.3) + 100_000
        tx.update({
            "nonce": w3.eth.get_transaction_count(acct.address, "pending"),
            "gas": gas,
            "maxFeePerGas": base * 2,
            "maxPriorityFeePerGas": 0,
            "chainId": w3.eth.chain_id,
            "type": 2,
        })
        for k in ("gasPrice",):
            tx.pop(k, None)
        signed = acct.sign_transaction(tx)
        h = w3.eth.send_raw_transaction(signed.raw_transaction)
        rc = w3.eth.wait_for_transaction_receipt(h, timeout=300, poll_latency=0.5)
        hx = "0x" + bytes(h).hex() if not str(h.hex()).startswith("0x") else h.hex()
        cost = rc["gasUsed"] * rc["effectiveGasPrice"]
        self.spent[acct.address] = self.spent.get(acct.address, 0) + cost
        ok = rc["status"] == 1
        rec = {"label": label, "tx": hx, "url": f"{EXPLORER}/tx/{hx}", "status": "success" if ok else "reverted",
               "gasUsed": rc["gasUsed"], "block": rc["blockNumber"]}
        if expect_revert:
            rec["expectedError"] = expect_revert
            if ok:
                raise RuntimeError(f"{label}: expected a revert, got success ({hx})")
        elif not ok:
            raise RuntimeError(f"{label}: reverted ({hx})")
        self.out["txs"].append(rec)
        print(f"{label}: {rec['status']} {hx} gas {rc['gasUsed']}")
        return rc


def expect_call_revert(w3, fn, sender, error_sig):
    """eth_call must revert with `error_sig`; returns the revert data."""
    try:
        fn.call({"from": sender})
    except Exception as e:  # web3 raises ContractCustomError / ContractLogicError
        data = getattr(e, "data", None) or (e.args[1] if len(e.args) > 1 else None) or str(e)
        data = data if isinstance(data, str) else str(data)
        if selector(error_sig)[2:] not in data:
            raise RuntimeError(f"unexpected revert {data[:200]} (wanted {error_sig})")
        return data
    raise RuntimeError(f"call did not revert (wanted {error_sig})")


def bs_put(spot, strike, tau_years, vol):
    if tau_years <= 0:
        return max(strike - spot, 0.0)
    s = vol * math.sqrt(tau_years)
    d1 = (math.log(spot / strike) + 0.5 * s * s) / s
    d2 = d1 - s
    n = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))  # noqa: E731
    return strike * n(-d2) - spot * n(-d1)


def keys_file():
    return os.environ.get("E2E_KEYS_FILE") or os.path.join(tempfile.gettempdir(), "novation-e2e-keys.json")


def throwaway_keys():
    p = keys_file()
    if os.path.exists(p):
        k = json.load(open(p))
    else:
        k = {"maker": Account.create().key.hex(), "agent": Account.create().key.hex()}
        json.dump(k, open(p, "w"))
    return Account.from_key(k["maker"]), Account.from_key(k["agent"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpc", default=None)
    a = ap.parse_args()
    load_env()
    rpc = a.rpc or os.environ.get("RH_TESTNET_RPC") or "https://rpc.testnet.chain.robinhood.com"
    w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 120}))
    cid = w3.eth.chain_id
    dep = json.load(open(os.path.join(ROOT, "contracts", "deployments", f"{cid}.json")))
    user = Account.from_key(os.environ["DEPLOYER_PRIVATE_KEY"])
    maker, agent = throwaway_keys()
    out = {"chainId": cid, "date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "kernel": dep["kernel"]["address"], "clearinghouse": dep["clearinghouse"],
           "actors": {"user": user.address, "maker": maker.address, "agent": agent.address}, "txs": []}
    r = Runner(w3, out)
    bal0 = w3.eth.get_balance(user.address)

    c = lambda addr, name, file=None: w3.eth.contract(address=Web3.to_checksum_address(addr), abi=abi(name, file))  # noqa: E731
    ch = c(dep["clearinghouse"], "Clearinghouse")
    hub = c(dep["hub"], "MarketDataHub")
    reg = c(dep["registry"], "SeriesRegistry")
    rfq = c(dep["rfq"], "RfqVenue")
    params = c(dep["riskParams"], "RiskParams")
    usdg = c(dep["tokens"]["USDG"], "MockUSDG")
    nvda = c(dep["tokens"]["NVDA"], "MockStockToken")
    cc = c(next(v["address"] for v in dep["vaults"] if v["type"] == "coveredCall" and v["underlying"] == "NVDA"),
           "CoveredCallVault")
    N = nvda.address

    # ---- 0. gas for the throwaway keys
    for who in (maker, agent):
        if w3.eth.get_balance(who.address) < 50_000_000_000_000:
            r.send(user, to=who.address, value=150_000_000_000_000, gas=100_000, label=f"fund {who is maker and 'maker' or 'agent'} gas")

    # ---- 1. user subaccount, deposits
    r.send(user, ch.functions.createSubaccount(), label="1 createSubaccount (user)")
    uid = ch.functions.subaccountsOf(user.address).call()[-1]
    r.send(user, usdg.functions.mint(user.address, 3_000 * 10**6), label="1 mint USDG")
    r.send(user, nvda.functions.mint(user.address, W), label="1 mint NVDA")
    r.send(user, usdg.functions.approve(ch.address, 2**256 - 1), label="1 approve USDG")
    r.send(user, nvda.functions.approve(ch.address, 2**256 - 1), label="1 approve NVDA")
    r.send(user, ch.functions.deposit(uid, usdg.address, 2_000 * 10**6), label="1 deposit 2000 USDG")
    r.send(user, ch.functions.deposit(uid, N, W), label="1 deposit 1 NVDA")
    out["userSubaccount"] = uid

    # ---- 2. buy a call from the covered-call vault
    r.send(user, hub.functions.syncVol(N), label="2 syncVol NVDA")
    spot = hub.functions.spot(N).call()[0]
    vol = hub.functions.markVol(N).call()
    expiries = sorted({s[1] for s in (reg.functions.series(i).call() for i in range(1, reg.functions.seriesCount().call() + 1))
                       if s[0] == N})
    call_sid = None
    for e in expiries:
        for pct in (5, 10, 15, 20):
            k = (spot * (100 + pct) // 100 + 5 * W // 2) // (5 * W) * (5 * W)
            sid = reg.functions.seriesId(N, e, k, True).call()
            if sid == 0:
                continue
            try:
                cc.functions.buy(sid, W, 2**255, uid).call({"from": user.address})
                call_sid = sid
                break
            except Exception:
                continue
        if call_sid:
            break
    if not call_sid:
        raise RuntimeError("no NVDA call the vault sells right now")
    q = cc.functions.quote(call_sid, W, True).call()
    r.send(user, cc.functions.buy(call_sid, W, q * 102 // 100, uid), label="2 buy 1 NVDA call from the covered-call vault")
    out["callSeries"] = {"id": call_sid, "series": reg.functions.series(call_sid).call(), "premiumQuote": q}

    # ---- 3. RFQ: the maker buys 5 puts from the user
    r.send(maker, ch.functions.createSubaccount(), label="3 createSubaccount (maker)")
    mid = ch.functions.subaccountsOf(maker.address).call()[-1]
    r.send(user, usdg.functions.mint(user.address, 2_000 * 10**6), label="3 mint USDG for the maker")
    r.send(user, ch.functions.deposit(mid, usdg.address, 2_000 * 10**6), label="3 deposit 2000 USDG into the maker account")
    put_sid, put_k, put_e = None, None, None
    for e in reversed(expiries):
        k = (spot * 95 // 100 + 5 * W // 2) // (5 * W) * (5 * W)
        sid = reg.functions.seriesId(N, e, k, False).call()
        if sid:
            put_sid, put_k, put_e = sid, k, e
            break
    now = w3.eth.get_block("latest")["timestamp"]
    px = bs_put(spot / W, put_k / W, (put_e - now) / (365 * 86400), vol / W)
    quote = {"signer": maker.address, "makerId": mid, "seriesId": put_sid, "makerSells": False, "maxQty": 5 * W,
             "price": int(px * 0.98 * 1e6) * 10**12, "deadline": now + 3600, "nonce": int(time.time())}
    qt = tuple(quote[k] for k in ("signer", "makerId", "seriesId", "makerSells", "maxQty", "price", "deadline", "nonce"))
    h = rfq.functions.hashQuote(qt).call()
    sig = Account.unsafe_sign_hash(h, maker.key).signature
    r.send(user, rfq.functions.fill(qt, sig, uid, 5 * W), label="3 RFQ fill: user sells 5 NVDA puts to the maker")
    out["rfq"] = {"makerSubaccount": mid, "seriesId": put_sid, "strike": put_k, "expiry": put_e, "qty": 5 * W,
                  "price": quote["price"]}

    # ---- 4. agent budget on a second subaccount
    r.send(user, ch.functions.createSubaccount(), label="4 createSubaccount (agent-run)")
    aid = ch.functions.subaccountsOf(user.address).call()[-1]
    r.send(user, ch.functions.deposit(aid, usdg.address, 500 * 10**6), label="4 deposit 500 USDG (agent-run)")
    q1 = cc.functions.quote(call_sid, W, True).call()
    im1 = ch.functions.marginAfter(aid, call_sid, W, -q1).call()[5]
    budget = im1 * 3 // 2
    idx = params.functions.underlying(N).call()[1]
    policy = (budget, 200 * W, 1 << idx, now + 2 * 86400)
    r.send(user, ch.functions.grantAgent(aid, agent.address, policy), label="4 grantAgent (risk budget 1.5x one call)")
    r.send(agent, cc.functions.buy(call_sid, W, q1 * 102 // 100, aid), label="4 agent buys 1 call (in budget)")
    q3 = cc.functions.quote(call_sid, 3 * W, True).call()
    over = cc.functions.buy(call_sid, 3 * W, q3 * 102 // 100, aid)
    expect_call_revert(w3, over, agent.address, "AgentRiskBudgetExceeded(uint256,uint256,uint256)")
    r.send(agent, over, gas=3_000_000, label="4 agent buys 3 more calls (over budget)",
           expect_revert="AgentRiskBudgetExceeded")
    out["agent"] = {"subaccount": aid, "maxWorstLoss": budget, "imAfterOneCall": im1}

    # ---- 5. withdrawal below initial margin
    st = ch.functions.accountState(uid).call()
    cash, equity, im = st[0], st[4], st[5]
    room = equity - im
    if room < 0 or cash <= room:
        raise RuntimeError(f"account not set up for the IM check: cash {cash} equity {equity} im {im}")
    amt = room // 10**12 + 10**6  # 1 USDG past the margin room
    wd = ch.functions.withdraw(uid, usdg.address, amt, user.address)
    expect_call_revert(w3, wd, user.address, "InsufficientMargin(uint256,int256,uint256)")
    r.send(user, wd, gas=3_000_000, label="5 withdraw past initial margin", expect_revert="InsufficientMargin")
    out["withdraw"] = {"subaccount": uid, "cash": cash, "equity": equity, "im": im, "amountUsdg": amt}

    # ---- gas proof: margin for a 256-position book under the 32M cap
    data = margin_data(256, 1)
    proof = {}
    for nm, addr in (("stylus", dep["kernel"]["address"]), ("solidityReference", dep["kernelReference"])):
        try:
            proof[nm] = {"address": addr, "estimateGas": w3.eth.estimate_gas({"to": addr, "data": data, "gas": TX_CAP})}
        except Exception as e:
            proof[nm] = {"address": addr, "error": str(e)[:160]}
    out["gasProof"] = {"book": "margin(), 256 positions on one underlying (KernelGas.t.sol inputs)", "txGasCap": TX_CAP,
                       **proof}
    print("gas proof", proof)

    bal1 = w3.eth.get_balance(user.address)
    out["ethSpentByDeployer"] = (bal0 - bal1) / 1e18
    out["ethSpentByThrowawayKeys"] = {k: v / 1e18 for k, v in r.spent.items() if k != user.address}
    p = os.path.join(ROOT, "tools", "e2e", "out", f"{cid}.json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(out, open(p, "w"), indent=2, default=str)
    print("wrote", p, "deployer spent", out["ethSpentByDeployer"], "ETH")


if __name__ == "__main__":
    main()
