"""Deploy a Stylus program (manual recipe, no cargo-stylus).

  python deploy.py --check-size kernel.wasm
  python deploy.py --deploy kernel.wasm --rpc $RH_TESTNET_RPC [--key-name kernel]

Steps (stylus-tools 0.10.9): wasm-tools roundtrip + strip, brotli q11 lgwin22, 0xEFF00000 prefix,
init code prelude, free dry-run of ArbWasm.activateProgram, CREATE, activateProgram with fee*1.2.
The key is read from env DEPLOYER_PRIVATE_KEY (or ../../.env) and is never printed.
Writes contracts/deployments/<chainId>.json -> kernel {address,type,codehash,wasmSha256}.
"""
import argparse
import hashlib
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time

import brotli
import requests
from eth_abi import decode, encode
from eth_account import Account
from eth_utils import keccak, to_checksum_address

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ARBWASM = "0x0000000000000000000000000000000000000071"
MAX_CODE = 24576


def load_env():
    p = os.path.join(ROOT, ".env")
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


def rpc(url, method, params):
    for attempt in range(6):
        try:
            r = requests.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=120).json()
        except Exception as e:  # network hiccup
            print("retry", attempt, repr(e)[:120], file=sys.stderr)
            time.sleep(2 + 3 * attempt)
            continue
        if "error" in r:
            raise RuntimeError(r["error"])
        return r["result"]
    raise RuntimeError("rpc failed")


def process_wasm(src, workdir):
    wat, rt, final = (os.path.join(workdir, n) for n in ("c.wat", "c.rt.wasm", "c.final.wasm"))
    subprocess.run(["wasm-tools", "print", src, "-o", wat], check=True)
    subprocess.run(["wasm-tools", "parse", wat, "-o", rt], check=True)
    subprocess.run(["wasm-tools", "strip", "--all", rt, "-o", final], check=True)
    wasm = open(final, "rb").read()
    comp = brotli.compress(wasm, mode=brotli.MODE_GENERIC, quality=11, lgwin=22)
    code = bytes.fromhex("EFF00000") + comp
    return wasm, code


def initcode_for(code):
    prelude = bytes([0x7F]) + len(code).to_bytes(32, "big") + bytes([0x80, 0x60, 43, 0x60, 0x00, 0x39, 0x60, 0x00, 0xF3, 0x00])
    assert len(prelude) == 43
    return prelude + code


def check_size(src):
    with tempfile.TemporaryDirectory() as d:
        wasm, code = process_wasm(src, d)
    ok = len(code) <= MAX_CODE
    print(f"raw {os.path.getsize(src)} B -> processed {len(wasm)} B -> on-chain code {len(code)} B "
          f"(limit {MAX_CODE}: {'OK' if ok else 'TOO BIG'})")
    return code, ok


def send(url, acct, to, data, value=0):
    chain_id = int(rpc(url, "eth_chainId", []), 16)
    nonce = int(rpc(url, "eth_getTransactionCount", [acct.address, "pending"]), 16)
    base = int(rpc(url, "eth_gasPrice", []), 16)
    call = {"from": acct.address, "data": data, "value": hex(value)}
    if to:
        call["to"] = to
    est = int(rpc(url, "eth_estimateGas", [call]), 16)
    gas = int(est * 1.25) + 50_000
    tx = {"chainId": chain_id, "nonce": nonce, "gas": gas, "maxFeePerGas": base * 3, "maxPriorityFeePerGas": 0,
          "data": data, "value": value, "type": 2}
    if to:
        tx["to"] = to
    raw = acct.sign_transaction(tx).raw_transaction.hex()
    h = rpc(url, "eth_sendRawTransaction", [raw if raw.startswith("0x") else "0x" + raw])
    for _ in range(180):
        rc = rpc(url, "eth_getTransactionReceipt", [h])
        if rc:
            used = int(rc["gasUsed"], 16)
            cost = used * int(rc.get("effectiveGasPrice", "0x0"), 16) + value
            if int(rc["status"], 16) != 1:
                raise RuntimeError(f"tx {h} reverted")
            return h, rc, used, cost
        time.sleep(1)
    raise RuntimeError(f"no receipt for {h}")


def deploy(src, url):
    load_env()
    key = os.environ.get("DEPLOYER_PRIVATE_KEY")
    if not key:
        sys.exit("DEPLOYER_PRIVATE_KEY not set")
    acct = Account.from_key(key)
    with tempfile.TemporaryDirectory() as d:
        wasm, code = process_wasm(src, d)
    if len(code) > MAX_CODE:
        sys.exit(f"code {len(code)} B exceeds {MAX_CODE}")
    codehash = "0x" + keccak(code).hex()
    wasm_sha = hashlib.sha256(open(src, "rb").read()).hexdigest()
    print(f"code {len(code)} B, codehash {codehash}")

    sel = keccak(text="activateProgram(address)")[:4]
    rnd, sender = "0x" + secrets.token_hex(20), "0x" + secrets.token_hex(20)
    dry = rpc(url, "eth_call", [{"from": sender, "to": ARBWASM, "data": "0x" + (sel + encode(["address"], [rnd])).hex(),
                                 "value": hex(10**18)}, "latest",
                                {sender: {"balance": hex(2**200)}, rnd: {"code": "0x" + code.hex()}}])
    ver, fee = decode(["uint16", "uint256"], bytes.fromhex(dry[2:]))
    print(f"dry-run activation OK: version {ver}, dataFee {fee} wei")

    total = 0
    h, rc, used, cost = send(url, acct, None, "0x" + initcode_for(code).hex())
    addr = to_checksum_address(rc["contractAddress"])
    total += cost
    print(f"CREATE tx {h} gasUsed {used} -> {addr}")
    h2, _, used2, cost2 = send(url, acct, ARBWASM, "0x" + (sel + encode(["address"], [addr])).hex(), value=int(fee * 1.2))
    total += cost2
    print(f"activate tx {h2} gasUsed {used2}")
    print(f"total spent {total / 1e18:.8f} ETH (incl. data fee)")

    chain_id = int(rpc(url, "eth_chainId", []), 16)
    path = os.path.join(ROOT, "contracts", "deployments", f"{chain_id}.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    dep = json.load(open(path)) if os.path.exists(path) else {}
    dep["chainId"] = chain_id
    dep["kernel"] = {"address": addr, "type": "stylus", "codehash": codehash, "wasmSha256": wasm_sha}
    json.dump(dep, open(path, "w"), indent=2)
    print("wrote", path)
    print("kernel", addr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check-size", metavar="WASM")
    ap.add_argument("--deploy", metavar="WASM")
    ap.add_argument("--rpc")
    a = ap.parse_args()
    if a.check_size:
        check_size(a.check_size)
    elif a.deploy:
        if not a.rpc:
            sys.exit("--rpc required")
        deploy(a.deploy, a.rpc)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
