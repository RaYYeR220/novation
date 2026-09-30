"""On-chain parity + gas check: Stylus kernel vs KernelReference (read from deployments/<chainId>.json).
python parity.py --rpc URL
"""
import argparse
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")
import requests
from eth_abi import encode
from eth_utils import keccak

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
P = "(uint256,int256,uint256,uint256)"
U = "(uint256,uint256,uint256,uint256,uint256,int256)"
K = "(uint256,bool,uint256,uint256,int256)"
W = 10**18
NOW = 1_790_000_000


def rpc(url, method, params):
    r = requests.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=300).json()
    return r


def book(np_, nu):
    us = [((100 + i * 10) * W, W // 2, W // 5, 4 * W // 10, 3 * W // 10, 0) for i in range(nu)]
    ps = []
    for i in range(np_):
        u = i % nu
        spot = (100 + u * 10) * W
        ps.append((u, i % 2 == 0, NOW + 7 * 86400, spot + 10 * W, 10 * W if i % 2 == 0 else -10 * W))
    return us, ps


def margin_data(np_, nu):
    us, ps = book(np_, nu)
    p = (NOW, 4 * W // 100, 3 * W // 10, W // 100)
    sig = f"margin({P},{U}[],{K}[])"
    return "0x" + (keccak(text=sig)[:4] + encode([P, U + "[]", K + "[]"], [p, us, ps])).hex()


def quote_data(spot, strike, tau, vol, rate, call):
    sig = "bsQuote(uint256,uint256,uint256,uint256,int256,bool)"
    return "0x" + (keccak(text=sig)[:4] + encode(["uint256", "uint256", "uint256", "uint256", "int256", "bool"],
                                                 [spot, strike, tau, vol, rate, call])).hex()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpc", required=True)
    a = ap.parse_args()
    cid = int(rpc(a.rpc, "eth_chainId", [])["result"], 16)
    dep = json.load(open(os.path.join(ROOT, "contracts", "deployments", f"{cid}.json")))
    st, ref = dep["kernel"]["address"], dep["kernelReference"]
    ok = True
    cases = [("bsQuote ATM call", quote_data(100 * W, 100 * W, 7 * 86400 * W // 31536000, W // 2, 4 * W // 100, True)),
             ("bsQuote OTM put", quote_data(250 * W, 200 * W, 30 * W // 365, 6 * W // 10, 0, False)),
             ("margin N=4", margin_data(4, 1)), ("margin N=8 (2 underlyings)", margin_data(8, 2)),
             ("margin N=32", margin_data(32, 1))]
    for name, data in cases:
        rs = rpc(a.rpc, "eth_call", [{"to": st, "data": data}, "latest"])
        rr = rpc(a.rpc, "eth_call", [{"to": ref, "data": data}, "latest"])
        same = "result" in rs and rs == rr or (rs.get("result") == rr.get("result") and "result" in rs)
        ok &= same
        print(f"{name}: {'EQUAL' if same else 'DIFF'} ({len(rs.get('result', ''))//2 - 1} B) stylus={str(rs.get('result') or rs.get('error'))[:66]}")
    print("PARITY", "OK" if ok else "FAIL")
    for label, np_, nu in [("N=32 x1", 32, 1), ("N=256 x1", 256, 1), ("32 (8x4)", 32, 8), ("N=64 (8x8)", 64, 8)]:
        data = margin_data(np_, nu)
        out = []
        for nm, addr in (("stylus", st), ("reference", ref)):
            r = rpc(a.rpc, "eth_estimateGas", [{"to": addr, "data": data}])
            out.append(f"{nm}={int(r['result'], 16) if 'result' in r else 'ERR ' + str(r['error'])[:70]}")
        print("estimateGas margin", label, *out)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
