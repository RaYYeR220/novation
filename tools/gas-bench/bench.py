"""Gas benchmark. python bench.py <rpc> <label> <address> [--arb] [--cap GAS] [--ns 1,8,64] > results.json
For each N in NS: eth_estimateGas(worstLoss) ; on Arbitrum also NodeInterface.gasEstimateComponents (L1 split)
and an inner-execution probe (gasleft() delta around the CALL) injected via eth_call state override (free).
"""
import json
import math
import os
import random
import sys
import time

import requests
from eth_abi import decode, encode
from eth_utils import keccak

SIG_BS = "bsPrice(uint256,uint256,uint256,uint256,int256,bool)"
SIG_WL = "worstLoss((uint256,uint64,bool,int256)[],int256,uint256,uint256,uint256,int256)"
SIG_WM = "worstLossMulti((uint256,uint256,int256,uint256)[],(uint8,uint256,uint64,bool,int256)[],uint256,int256)"


def sel(sig):
    return keccak(text=sig)[:4]

WAD = 10**18
NOW = 1_790_000_000
NODE_IF = "0x00000000000000000000000000000000000000C8"
PROBE_ADDR = "0x00000000000000000000000000000000000Fa11E"
FROM = "0xbB91Fe38652991f0E9735dc139601bD637ae4d66"


def w(x):
    return int(round(x * 1e6)) * 10**12


def portfolio(n, seed=7, spot=3000.0):
    rng = random.Random(seed)
    ps = []
    for i in range(n):
        K = spot * math.exp(rng.gauss(0, 0.2))
        days = rng.choice([7, 14, 30, 60, 90, 180, 365])
        ps.append((w(K), NOW + days * 86400, i % 2 == 0, w(rng.uniform(-20, 20))))
    return ps


def cd_wl(n):
    return sel(SIG_WL) + encode(
        ["(uint256,uint64,bool,int256)[]", "int256", "uint256", "uint256", "uint256", "int256"],
        [portfolio(n), w(-5.0), w(3000.0), w(0.65), NOW, w(0.04)],
    )


def cd_bs():
    return sel(SIG_BS) + encode(["uint256", "uint256", "uint256", "uint256", "int256", "bool"], [w(3000), w(3200), w(0.25), w(0.65), w(0.04), True])


def cd_wm(nu, npu, beta_spread=True):
    rng = random.Random(11)
    unds, ps = [], []
    for u in range(nu):
        spot = [3000.0, 65000.0, 150.0, 1.0, 600.0, 20.0, 0.5, 2500.0][u % 8]
        beta = 1.0 + (0.15 * u if beta_spread else 0.0)
        unds.append((w(spot), w(0.5 + 0.05 * u), w(rng.uniform(-10, 10)), w(beta)))
        for i, p in enumerate(portfolio(npu, seed=100 + u, spot=spot)):
            ps.append((u,) + p)
    return sel(SIG_WM) + encode(
        ["(uint256,uint256,int256,uint256)[]", "(uint8,uint256,uint64,bool,int256)[]", "uint256", "int256"],
        [unds, ps, NOW, w(0.04)],
    )


def cd_ping():
    return sel("ping()")


def rpc(url, method, params):
    for attempt in range(6):
        try:
            r = requests.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=120).json()
            return r
        except Exception as e:  # noqa
            print("retry", attempt, repr(e)[:150], file=sys.stderr)
            time.sleep(2 + 3 * attempt)
    raise RuntimeError("rpc failed")


PROBE_RUNTIME = None


def probe_gas(url, to, data, gas_cap):
    """inner execution gas of CALL(to, data) measured with gasleft() in an injected probe contract"""
    pd = sel("probe(address,bytes)") + encode(["address", "bytes"], [to, data])
    r = rpc(url, "eth_call", [{"from": FROM, "to": PROBE_ADDR, "data": "0x" + pd.hex(), "gas": hex(gas_cap)}, "latest",
                              {PROBE_ADDR: {"code": PROBE_RUNTIME}}])
    if "error" in r:
        return None, r["error"]
    used, ok, _ = decode(["uint256", "bool", "bytes"], bytes.fromhex(r["result"][2:]))
    return used, ok


def measure(url, to, data, arb, gas_cap):
    out = {"calldata_bytes": len(data)}
    r = rpc(url, "eth_estimateGas", [{"from": FROM, "to": to, "data": "0x" + data.hex()}])
    out["estimateGas"] = int(r["result"], 16) if "result" in r else ("ERR " + json.dumps(r.get("error"))[:160])
    if arb:
        gd = sel("gasEstimateComponents(address,bool,bytes)") + encode(["address", "bool", "bytes"], [to, False, data])
        r = rpc(url, "eth_call", [{"from": FROM, "to": NODE_IF, "data": "0x" + gd.hex()}, "latest"])
        if "result" in r:
            g, gl1, basefee, l1base = decode(["uint64", "uint64", "uint256", "uint256"], bytes.fromhex(r["result"][2:]))
            out["nodeIf_total"] = g
            out["nodeIf_L1"] = gl1
            out["L2_only"] = g - gl1
        else:
            out["nodeIf"] = "ERR " + json.dumps(r.get("error"))[:160]
    used, ok = probe_gas(url, to, data, gas_cap)
    out["inner_exec_gas"] = used
    out["inner_ok"] = ok
    return out


def main():
    global PROBE_RUNTIME
    url, label, addr = sys.argv[1], sys.argv[2], sys.argv[3]
    arb = "--arb" in sys.argv
    gas_cap = 32_000_000
    for i, a in enumerate(sys.argv):
        if a == "--cap":
            gas_cap = int(sys.argv[i + 1])
    j = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "Probe.sol", "Probe.json")))
    PROBE_RUNTIME = j["deployedBytecode"]["object"]
    res = {"label": label, "address": addr}
    res["ping"] = measure(url, addr, cd_ping(), arb, gas_cap)
    res["bsPrice"] = measure(url, addr, cd_bs(), arb, gas_cap)
    ns = [1, 4, 8, 16, 32, 48, 64, 96, 128, 256, 320, 336, 352]
    for i, a in enumerate(sys.argv):
        if a == '--ns':
            ns = [int(x) for x in sys.argv[i + 1].split(',')]
    for n in ns:
        res[f"worstLoss_N{n}"] = measure(url, addr, cd_wl(n), arb, gas_cap)
        print(label, n, res[f"worstLoss_N{n}"], file=sys.stderr)
    res["multi_8x8_beta"] = measure(url, addr, cd_wm(8, 8, True), arb, gas_cap)
    res["multi_8x8_beta1"] = measure(url, addr, cd_wm(8, 8, False), arb, gas_cap)
    res["multi_4x4_beta"] = measure(url, addr, cd_wm(4, 4, True), arb, gas_cap)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
