"""Proof transactions on the Robinhood Chain mainnet deployment (chain 4663), one step at a time.

  python tools/e2e/mainnet_proofs.py <step> [--rpc URL] [--qty 0.01] [--send]

Without --send a step only simulates (eth_call / eth_estimateGas) and prints what it would send;
nothing is signed. With --send it signs and sends, and appends every hash to
tools/e2e/out/<chainId>.json. Run the steps in this order (each needs the previous ones on chain):

  fund-keys      deployer -> throwaway maker and agent keys: gas money (--maker-eth, --agent-eth)
  setup          subaccounts U (user) and G (agent-run) for the deployer, K for the maker key;
                 USDG approval and deposits (--u-usdg, --g-usdg, --k-usdg)
  vault-deposit  the deployer deposits --nvda NVDA into the NVDA covered-call vault (ERC-4626)
  rfq            the maker key signs an RFQ quote, the deployer fills it: U sells --qty puts on the
                 later expiry (spot -5%) to K
  agent          grantAgent(G, agent key, risk budget = half the IM of one --qty call); the agent's
                 vault buy is refused on chain with AgentRiskBudgetExceeded
  vault-sale     the deployer buys --qty calls on the first expiry (spot +5%) from the vault for U
  withdraw-im    a USDG withdrawal 0.01 past U's margin room is refused with InsufficientMargin
  snapshot       accountState of U, G and the vault with the session and block (run it on Friday
                 in the regular session and again on Saturday for the weekend widening)
  pause-proof    optional: guardian pauseOpening, an opening RFQ fill refused with
                 OpeningNotAllowed, unpauseOpening (the gate a HALTED underlying uses)
  halt-proof     only while an underlying really reads HALTED (e.g. an ERC-8056 multiplier
                 window): an opening RFQ fill on it is refused with OpeningNotAllowed
  settle         after the first expiry: settleExpiry with the last round at or before it,
                 settleAccount for every account holding that expiry, claim what is claimable
  status         balances, accounts and series (read only)

Keys: DEPLOYER_PRIVATE_KEY from the env or .env. The maker and agent keys are generated once and
kept in E2E_KEYS_FILE (default: <temp>/novation-mainnet-keys.json), never in the repo, and never
printed. Reverts are confirmed by eth_call before sending and again by eth_call of the mined tx at
block-1 (the public RPC has no debug_traceTransaction and keeps only recent state, so the replay
runs right after the receipt).
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
W = 10**18
EXPLORERS = {4663: "https://robinhoodchain.blockscout.com", 46630: "https://explorer.testnet.chain.robinhood.com"}
SESSIONS = ["REGULAR", "EXTENDED", "WEEKEND", "HOLIDAY", "HALTED"]


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


ERC20_ABI = [
    {"type": "function", "name": n, "stateMutability": m, "inputs": i, "outputs": o}
    for n, m, i, o in [
        ("balanceOf", "view", [{"name": "a", "type": "address"}], [{"name": "", "type": "uint256"}]),
        ("allowance", "view", [{"name": "o", "type": "address"}, {"name": "s", "type": "address"}],
         [{"name": "", "type": "uint256"}]),
        ("approve", "nonpayable", [{"name": "s", "type": "address"}, {"name": "v", "type": "uint256"}],
         [{"name": "", "type": "bool"}]),
    ]
]
AGG_ABI = [
    {"type": "function", "name": "latestRoundData", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": n, "type": t} for n, t in
                 (("roundId", "uint80"), ("answer", "int256"), ("startedAt", "uint256"), ("updatedAt", "uint256"),
                  ("answeredInRound", "uint80"))]},
    {"type": "function", "name": "getRoundData", "stateMutability": "view", "inputs": [{"name": "id", "type": "uint80"}],
     "outputs": [{"name": n, "type": t} for n, t in
                 (("roundId", "uint80"), ("answer", "int256"), ("startedAt", "uint256"), ("updatedAt", "uint256"),
                  ("answeredInRound", "uint80"))]},
]


def selector(sig):
    return keccak(text=sig)[:4].hex()


def bs(spot, strike, tau_years, vol, call):
    if tau_years <= 0:
        return max(spot - strike, 0.0) if call else max(strike - spot, 0.0)
    s = vol * math.sqrt(tau_years)
    d1 = (math.log(spot / strike) + 0.5 * s * s) / s
    d2 = d1 - s
    n = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))  # noqa: E731
    return spot * n(d1) - strike * n(d2) if call else strike * n(-d2) - spot * n(-d1)


class Ctx:
    def __init__(self, a):
        load_env()
        rpc = a.rpc or os.environ.get("RH_MAINNET_RPC") or "https://rpc.mainnet.chain.robinhood.com"
        self.w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 120}))
        self.send_mode = a.send
        self.cid = self.w3.eth.chain_id
        self.explorer = EXPLORERS.get(self.cid, "")
        self.dep = json.load(open(os.path.join(ROOT, "contracts", "deployments", f"{self.cid}.json")))
        self.user = Account.from_key(os.environ["DEPLOYER_PRIVATE_KEY"])
        self.maker, self.agent = self._keys()
        self.out_path = os.path.join(ROOT, "tools", "e2e", "out", f"{self.cid}.json")
        self.out = json.load(open(self.out_path)) if os.path.exists(self.out_path) else {
            "chainId": self.cid, "kernel": self.dep["kernel"]["address"], "clearinghouse": self.dep["clearinghouse"],
            "actors": {"user": self.user.address, "maker": self.maker.address, "agent": self.agent.address},
            "txs": [], "revertReplay": {}, "snapshots": []}
        self.qty = int(round(a.qty * W))
        c = self.c
        self.ch = c(self.dep["clearinghouse"], "Clearinghouse")
        self.hub = c(self.dep["hub"], "MarketDataHub")
        self.reg = c(self.dep["registry"], "SeriesRegistry")
        self.rfq = c(self.dep["rfq"], "RfqVenue")
        self.params = c(self.dep["riskParams"], "RiskParams")
        self.vault = c(next(v["address"] for v in self.dep["vaults"]
                            if v["type"] == "coveredCall" and v["underlying"] == "NVDA"), "CoveredCallVault")
        self.usdg = self.w3.eth.contract(address=Web3.to_checksum_address(self.dep["tokens"]["USDG"]), abi=ERC20_ABI)
        self.nvda = self.w3.eth.contract(address=Web3.to_checksum_address(self.dep["tokens"]["NVDA"]), abi=ERC20_ABI)
        self.N = self.nvda.address

    def c(self, addr, name, file=None):
        return self.w3.eth.contract(address=Web3.to_checksum_address(addr), abi=abi(name, file))

    def _keys(self):
        p = os.environ.get("E2E_KEYS_FILE") or os.path.join(tempfile.gettempdir(), "novation-mainnet-keys.json")
        if os.path.exists(p):
            k = json.load(open(p))
        else:
            k = {"maker": Account.create().key.hex(), "agent": Account.create().key.hex()}
            json.dump(k, open(p, "w"))
        return Account.from_key(k["maker"]), Account.from_key(k["agent"])

    def save(self):
        os.makedirs(os.path.dirname(self.out_path), exist_ok=True)
        json.dump(self.out, open(self.out_path, "w"), indent=2, default=str)

    # ------------------------------------------------------------------ sending

    def send(self, acct, fn=None, *, to=None, value=0, gas=None, label, expect_revert=None, twin=None):
        """Simulates; with --send, sends and waits. expect_revert: the error signature the tx must
        revert with. It can't be estimated, so its gas limit is `gas`, or 1.3x the estimate of
        `twin` (sender, call): a call that runs the same path and succeeds. The revert is checked
        by eth_call with that gas limit before sending and at block-1 after, so a tx that ran out
        of gas can't pass for the expected revert."""
        w3 = self.w3
        if fn is not None:
            tx = fn.build_transaction({"from": acct.address, "value": value, "gas": 1})
            tx = {k: tx[k] for k in ("to", "data", "value")}
        else:
            tx = {"to": Web3.to_checksum_address(to), "data": "0x", "value": value}
        tx["from"] = acct.address
        if expect_revert:
            if gas is None:
                t_est = twin[1].estimate_gas({"from": twin[0].address}) if twin else 700_000
                gas = int(t_est * 1.3) + 50_000
            self.expect_call_revert(dict(tx, gas=gas), expect_revert)
            est = None
        else:
            est = w3.eth.estimate_gas(tx)
            if gas is None:
                gas = int(est * 1.25) + 30_000
        print(f"[{'send' if self.send_mode else 'dry-run'}] {label}: estimate {est} gas limit {gas}")
        if not self.send_mode:
            return None
        base = w3.eth.get_block("latest")["baseFeePerGas"]
        tx.update({"nonce": w3.eth.get_transaction_count(acct.address, "pending"), "gas": gas,
                   "maxFeePerGas": base * 2, "maxPriorityFeePerGas": 0, "chainId": self.cid, "type": 2})
        tx.pop("from")
        h = w3.eth.send_raw_transaction(acct.sign_transaction(tx).raw_transaction)
        rc = w3.eth.wait_for_transaction_receipt(h, timeout=300, poll_latency=0.5)
        hx = Web3.to_hex(h)
        ok = rc["status"] == 1
        rec = {"label": label, "tx": hx, "url": f"{self.explorer}/tx/{hx}", "status": "success" if ok else "reverted",
               "gasUsed": rc["gasUsed"], "gasUsedForL1": int(rc.get("gasUsedForL1", 0) or 0),
               "effectiveGasPrice": rc["effectiveGasPrice"], "block": rc["blockNumber"]}
        if expect_revert:
            rec["expectedError"] = expect_revert
            if ok:
                raise RuntimeError(f"{label}: expected a revert, got success ({hx})")
            replay = dict(tx, **{"from": acct.address})
            for k in ("nonce", "maxFeePerGas", "maxPriorityFeePerGas", "chainId", "type"):
                replay.pop(k, None)
            self.expect_call_revert(replay, expect_revert, block=rc["blockNumber"] - 1)
            self.out["revertReplay"][hx] = expect_revert
        elif not ok:
            raise RuntimeError(f"{label}: reverted ({hx})")
        self.out["txs"].append(rec)
        self.save()
        print(f"  {rec['status']} {hx} gas {rc['gasUsed']} ({rc['gasUsed'] * rc['effectiveGasPrice'] / 1e18:.8f} ETH)")
        return rc

    def expect_call_revert(self, tx, error_sig, block="latest"):
        try:
            self.w3.eth.call({k: tx[k] for k in ("from", "to", "data", "value", "gas") if k in tx}, block)
        except Exception as e:  # web3 raises ContractCustomError / ContractLogicError
            data = getattr(e, "data", None) or (e.args[1] if len(e.args) > 1 else None) or str(e)
            data = data if isinstance(data, str) else str(data)
            if selector(error_sig) not in data:
                raise RuntimeError(f"unexpected revert {data[:200]} (wanted {error_sig})")
            print(f"  eth_call at {block} reverts with {error_sig}")
            return
        raise RuntimeError(f"call at {block} did not revert (wanted {error_sig})")

    # ------------------------------------------------------------------ helpers

    def accounts(self):
        """U and G are the deployer's first two subaccounts, K the maker key's first."""
        mine = self.ch.functions.subaccountsOf(self.user.address).call()
        theirs = self.ch.functions.subaccountsOf(self.maker.address).call()
        return (mine[0] if mine else None, mine[1] if len(mine) > 1 else None, theirs[0] if theirs else None)

    def expiries(self):
        n = self.reg.functions.seriesCount().call()
        series = [(i, self.reg.functions.series(i).call()) for i in range(1, n + 1)]
        now = self.w3.eth.get_block("latest")["timestamp"]
        live = sorted({s[1] for _, s in series if s[0] == self.N and s[1] > now})
        return series, live

    def pick(self, expiry, call, pct):
        """The listed NVDA series on `expiry` nearest to spot * (1 +- pct%) on the OTM side."""
        series, _ = self.expiries()
        spot = self.hub.functions.spot(self.N).call()[0]
        target = spot * (100 + pct) // 100 if call else spot * (100 - pct) // 100
        cands = [(abs(s[3] - target), i, s) for i, s in series
                 if s[0] == self.N and s[1] == expiry and s[2] == call and ((s[3] > spot) == call)]
        if not cands:
            raise RuntimeError(f"no {'call' if call else 'put'} listed on {expiry}")
        return min(cands)[1:]

    def sync(self):
        """The vault's quote() view reverts VaultNotLive while the hub's vol is behind the feed;
        every vault operation syncs first, so a syncVol tx (permissionless) brings the view back."""
        if not self.vault.functions.isLive().call():
            self.send(self.user, self.hub.functions.syncVol(self.N), label="syncVol NVDA (vault quote view)")
            if not self.send_mode:
                sys.exit("(dry-run: the vault quote needs the syncVol above on chain first)")

    def tau(self, expiry):
        return (expiry - self.w3.eth.get_block("latest")["timestamp"]) / (365 * 86400)


# ---------------------------------------------------------------------- steps

def step_status(x, a):
    U, G, K = x.accounts()
    print("chain", x.cid, "block", x.w3.eth.block_number)
    for nm, who in (("deployer", x.user.address), ("maker", x.maker.address), ("agent", x.agent.address)):
        print(f"{nm:8s} {who} ETH {x.w3.eth.get_balance(who) / 1e18:.8f} USDG {x.usdg.functions.balanceOf(who).call() / 1e6}"
              f" NVDA {x.nvda.functions.balanceOf(who).call() / 1e18}")
    spot, sess, ok = x.hub.functions.spot(x.N).call()
    print("NVDA spot", spot / W, "session", SESSIONS[sess], "markVol", x.hub.functions.markVol(x.N).call() / W,
          "vault live", x.vault.functions.isLive().call())
    series, live = x.expiries()
    print("live expiries", live, [datetime.fromtimestamp(e, timezone.utc).isoformat() for e in live])
    for i, s in series:
        print("  series", i, "expiry", s[1], "call" if s[2] else "put", s[3] / W)
    for nm, id_ in (("U", U), ("G", G), ("K", K), ("vault", x.vault.functions.vaultId().call())):
        if id_:
            st = x.ch.functions.accountState(id_).call()
            print(f"{nm} #{id_}: cash {st[0] / W:.4f} equity {st[4] / W:.4f} im {st[5] / W:.4f} mm {st[6] / W:.4f}"
                  f" positions {x.ch.functions.positionsOf(id_).call()}")


def step_fund_keys(x, a):
    for who, eth in ((x.maker, a.maker_eth), (x.agent, a.agent_eth)):
        have = x.w3.eth.get_balance(who.address)
        want = int(eth * W)
        if have < want:
            x.send(x.user, to=who.address, value=want - have, label=f"fund {'maker' if who is x.maker else 'agent'} key gas")


def step_setup(x, a):
    U, G, K = x.accounts()
    if U is None:
        x.send(x.user, x.ch.functions.createSubaccount(), label="createSubaccount U (user)")
    if G is None:
        x.send(x.user, x.ch.functions.createSubaccount(), label="createSubaccount G (agent-run)")
    if K is None:
        x.send(x.maker, x.ch.functions.createSubaccount(), label="createSubaccount K (maker key)")
    if not x.send_mode:
        print("(dry-run: deposits need the subaccounts above on chain)")
        return
    U, G, K = x.accounts()
    total = int((a.u_usdg + a.g_usdg + a.k_usdg) * 1e6)
    if x.usdg.functions.allowance(x.user.address, x.ch.address).call() < total:
        x.send(x.user, x.usdg.functions.approve(x.ch.address, 2**256 - 1), label="approve USDG to the clearinghouse")
    for nm, id_, amt in (("U", U, a.u_usdg), ("G", G, a.g_usdg), ("K", K, a.k_usdg)):
        if amt > 0:
            x.send(x.user, x.ch.functions.deposit(id_, x.usdg.address, int(amt * 1e6)), label=f"deposit {amt} USDG into {nm}")
    x.out.update({"U": U, "G": G, "K": K})
    x.save()


def step_vault_deposit(x, a):
    amt = int(round(a.nvda * W))
    if x.nvda.functions.allowance(x.user.address, x.vault.address).call() < amt:
        x.send(x.user, x.nvda.functions.approve(x.vault.address, amt), label="approve NVDA to the vault")
        if not x.send_mode:
            return
    x.send(x.user, x.vault.functions.deposit(amt, x.user.address), label=f"deposit {a.nvda} NVDA into the covered-call vault")


def step_rfq(x, a):
    U, G, K = x.accounts()
    _, live = x.expiries()
    e = live[-1]
    sid, s = x.pick(e, False, 5)
    spot = x.hub.functions.spot(x.N).call()[0]
    vol = x.hub.functions.markVol(x.N).call()
    px = bs(spot / W, s[3] / W, x.tau(e), vol / W, False)
    now = x.w3.eth.get_block("latest")["timestamp"]
    q = (x.maker.address, K, sid, False, x.qty, int(px * 0.98 * 1e6) * 10**12, now + 3600, int(time.time()))
    sig = Account.unsafe_sign_hash(x.rfq.functions.hashQuote(q).call(), x.maker.key).signature
    x.send(x.user, x.rfq.functions.fill(q, sig, U, x.qty),
           label=f"RFQ fill: U sells {x.qty / W} NVDA {s[3] / W:g} puts ({e}) to the maker key")
    x.out["rfq"] = {"seriesId": sid, "strike": s[3], "expiry": e, "qty": x.qty, "price": q[5]}
    x.save()


def step_agent(x, a):
    U, G, K = x.accounts()
    x.sync()
    _, live = x.expiries()
    sid, s = x.pick(live[0], True, 5)
    prem = x.vault.functions.quote(sid, x.qty, True).call()
    im1 = x.ch.functions.marginAfter(G, sid, x.qty, -prem).call()[5]
    budget = im1 // 2
    idx = x.params.functions.underlying(x.N).call()[1]
    now = x.w3.eth.get_block("latest")["timestamp"]
    pol = x.ch.functions.agentPolicy(G, x.agent.address).call()
    if pol[0] != budget or pol[3] <= now:
        x.send(x.user, x.ch.functions.grantAgent(G, x.agent.address, (budget, 100 * W, 1 << idx, now + 3 * 86400)),
               label=f"grantAgent G -> agent key (risk budget {budget / W:.4f} USD, half the IM of one buy)")
        if not x.send_mode:
            return
    buy = x.vault.functions.buy(sid, x.qty, prem * 102 // 100, G)
    owner_buy = x.vault.functions.buy(sid, x.qty, prem * 102 // 100, G)  # the owner isn't budget-limited
    x.send(x.agent, buy, gas=a.revert_gas, label=f"agent buys {x.qty / W} NVDA {s[3] / W:g} calls for G (over budget)",
           expect_revert="AgentRiskBudgetExceeded(uint256,uint256,uint256)", twin=(x.user, owner_buy))
    x.out["agent"] = {"subaccount": G, "seriesId": sid, "maxWorstLoss": budget, "imAfterOneBuy": im1}
    x.save()


def step_vault_sale(x, a):
    U, G, K = x.accounts()
    x.sync()
    _, live = x.expiries()
    sid, s = x.pick(live[0], True, 5)
    prem = x.vault.functions.quote(sid, x.qty, True).call()
    x.send(x.user, x.vault.functions.buy(sid, x.qty, prem * 102 // 100, U),
           label=f"buy {x.qty / W} NVDA {s[3] / W:g} calls ({s[1]}) from the covered-call vault for U")
    x.out["vaultSale"] = {"seriesId": sid, "premiumQuote": prem, "qty": x.qty}
    x.save()


def step_withdraw_im(x, a):
    U, G, K = x.accounts()
    st = x.ch.functions.accountState(U).call()
    cash, equity, im = st[0], st[4], st[5]
    room = equity - im
    amt = max(room, 0) // 10**12 + 10_000  # 0.01 USDG past the margin room
    if im == 0 or amt * 10**12 > cash:
        raise RuntimeError(f"U not set up for the IM check: cash {cash} equity {equity} im {im}")
    within = x.ch.functions.withdraw(U, x.usdg.address, max(room // 10**12 - 10_000, 1), x.user.address)
    x.send(x.user, x.ch.functions.withdraw(U, x.usdg.address, amt, x.user.address), gas=a.revert_gas,
           label="withdraw 0.01 USDG past U's margin room", expect_revert="InsufficientMargin(uint256,int256,uint256)",
           twin=(x.user, within))
    x.out["withdraw"] = {"subaccount": U, "cash": cash, "equity": equity, "im": im, "amountUsdg": amt}
    x.save()


def step_snapshot(x, a):
    U, G, K = x.accounts()
    blk = x.w3.eth.get_block("latest")
    snap = {"block": blk["number"], "timestamp": blk["timestamp"],
            "utc": datetime.fromtimestamp(blk["timestamp"], timezone.utc).isoformat(),
            "session": SESSIONS[x.hub.functions.session(x.N).call()], "spot": x.hub.functions.spot(x.N).call()[0],
            "markVol": x.hub.functions.markVol(x.N).call(), "accounts": {}}
    for nm, id_ in (("U", U), ("G", G), ("vault", x.vault.functions.vaultId().call())):
        st = x.ch.functions.accountState(id_).call()
        snap["accounts"][nm] = {"id": id_, "equity": st[4], "im": st[5], "mm": st[6], "worstScenario": st[7]}
    print(json.dumps(snap, indent=1, default=str))
    x.out["snapshots"].append(snap)
    x.save()


def _rfq_open_fill(x, underlying):
    """An opening RFQ fill on `underlying` (U sells one minimum lot of a put to K)."""
    U, G, K = x.accounts()
    series, _ = x.expiries()
    now = x.w3.eth.get_block("latest")["timestamp"]
    cands = [(i, s) for i, s in series if s[0] == underlying and not s[2] and s[1] > now]
    if not cands:
        raise RuntimeError("no live put listed on that underlying")
    sid, s = cands[-1]
    q = (x.maker.address, K, sid, False, x.qty, 10**16, now + 3600, int(time.time()) + 7)
    sig = Account.unsafe_sign_hash(x.rfq.functions.hashQuote(q).call(), x.maker.key).signature
    return x.rfq.functions.fill(q, sig, U, x.qty)


def step_pause_proof(x, a):
    fill = _rfq_open_fill(x, x.N)
    gas = a.revert_gas or int(fill.estimate_gas({"from": x.user.address}) * 1.3) + 50_000
    if not x.send_mode:
        fill.call({"from": x.user.address})
        print("[dry-run] the fill passes while opening is not paused; with --send: pause, refused fill, unpause")
        return
    x.send(x.user, x.params.functions.pauseOpening(), label="guardian pauseOpening")
    try:
        x.send(x.user, fill, gas=gas, label="opening RFQ fill while opening is paused",
               expect_revert="OpeningNotAllowed(uint256)")
    finally:
        x.send(x.user, x.params.functions.unpauseOpening(), label="guardian unpauseOpening")


def step_halt_proof(x, a):
    n = x.params.functions.underlyingCount().call()
    halted = [x.params.functions.underlyingAt(i).call() for i in range(n)]
    halted = [u for u in halted if x.hub.functions.session(u).call() == 4]
    if not halted:
        sys.exit("no underlying reads HALTED right now; nothing to prove")
    u = halted[0]
    x.send(x.user, _rfq_open_fill(x, u), gas=a.revert_gas, label=f"opening RFQ fill on HALTED {u}",
           expect_revert="OpeningNotAllowed(uint256)")


def step_settle(x, a):
    U, G, K = x.accounts()
    feed = x.w3.eth.contract(address=Web3.to_checksum_address(x.dep["feeds"]["NVDA"]), abi=AGG_ABI)
    series, _ = x.expiries()
    now = x.w3.eth.get_block("latest")["timestamp"]
    expired = sorted({s[1] for _, s in series if s[0] == x.N and s[1] <= now})
    if not expired:
        sys.exit("no NVDA expiry has passed yet")
    e = a.expiry or expired[0]
    price, settled = x.reg.functions.settlementPriceOf(x.N, e).call()
    if not settled:
        rid = feed.functions.latestRoundData().call()[0]
        while feed.functions.getRoundData(rid).call()[3] > e:
            rid -= 1
        x.send(x.user, x.reg.functions.settleExpiry(x.N, e, rid), label=f"settleExpiry NVDA {e} (round {rid})")
        if not x.send_mode:
            return
    ids = [i for i in (U, G, K, x.vault.functions.vaultId().call()) if i]
    for id_ in ids:
        if any(x.reg.functions.series(p[0]).call()[1] == e for p in x.ch.functions.positionsOf(id_).call()):
            x.send(x.user, x.ch.functions.settleAccount(id_, e), label=f"settleAccount #{id_} for {e}")
    for id_ in ids:
        if x.ch.functions.claimable(id_, e).call() > 0:
            x.send(x.user, x.ch.functions.claim(id_, e), label=f"claim #{id_} for {e}")


STEPS = {"status": step_status, "fund-keys": step_fund_keys, "setup": step_setup, "vault-deposit": step_vault_deposit,
         "rfq": step_rfq, "agent": step_agent, "vault-sale": step_vault_sale, "withdraw-im": step_withdraw_im,
         "snapshot": step_snapshot, "pause-proof": step_pause_proof, "halt-proof": step_halt_proof,
         "settle": step_settle}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=list(STEPS))
    ap.add_argument("--rpc")
    ap.add_argument("--send", action="store_true", help="sign and send (default: simulate only)")
    ap.add_argument("--qty", type=float, default=0.01, help="contracts per trade (>= minTradeQty)")
    ap.add_argument("--nvda", type=float, default=0.01, help="NVDA for the vault deposit")
    ap.add_argument("--u-usdg", type=float, default=1.5)
    ap.add_argument("--g-usdg", type=float, default=0.2)
    ap.add_argument("--k-usdg", type=float, default=0.2)
    ap.add_argument("--maker-eth", type=float, default=0.00001)
    ap.add_argument("--agent-eth", type=float, default=0.00012)
    ap.add_argument("--revert-gas", type=int,
                    help="gas limit for a tx expected to revert (default: 1.3x the estimate of the same path "
                         "succeeding; the sender must hold limit x 2 x base fee)")
    ap.add_argument("--expiry", type=int, help="settle: the expiry (default: the first one passed)")
    a = ap.parse_args()
    x = Ctx(a)
    STEPS[a.step](x, a)


if __name__ == "__main__":
    main()
