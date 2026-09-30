"""Reproduce what `cargo stylus deploy` does, without cargo-stylus (stylus-tools 0.10.9 source):
 1. wasm -> wat -> wasm round trip   (utils/wasm.rs remove_dangling_references)
 2. strip all custom sections        (utils/wasm.rs strip_user_metadata)
 3. brotli quality 11, default window 22, no dictionary  (core/code/wasm.rs BROTLI_COMPRESSION_LEVEL)
 4. prefix 0xEFF00000               (core/code/mod.rs prefixes::EOF_NO_DICT)
 5. initcode = PUSH32 len, DUP1, PUSH1 43, PUSH1 0, CODECOPY, PUSH1 0, RETURN, 0x00 version byte, code
                                    (core/deployment/prelude.rs DeploymentCalldata::new)
 6. (free) dry-run activation: eth_call ArbWasm.activateProgram(addr) with state override code@addr
                                    (core/activation.rs data_fee)
python prep_stylus.py <in.wasm> <outdir> [rpc]
"""
import os
import secrets
import subprocess
import sys

import brotli
import requests
from eth_abi import decode, encode
from eth_utils import keccak

ARBWASM = "0x0000000000000000000000000000000000000071"


def main():
    src, outdir = sys.argv[1], sys.argv[2]
    rpc = sys.argv[3] if len(sys.argv) > 3 else None
    os.makedirs(outdir, exist_ok=True)
    wat = os.path.join(outdir, "contract.wat")
    rt = os.path.join(outdir, "contract.rt.wasm")
    final = os.path.join(outdir, "contract.final.wasm")
    subprocess.run(["wasm-tools", "print", src, "-o", wat], check=True)
    subprocess.run(["wasm-tools", "parse", wat, "-o", rt], check=True)
    subprocess.run(["wasm-tools", "strip", "--all", rt, "-o", final], check=True)
    wasm = open(final, "rb").read()
    comp = brotli.compress(wasm, mode=brotli.MODE_GENERIC, quality=11, lgwin=22)
    code = bytes.fromhex("EFF00000") + comp
    prelude = bytes([0x7F]) + len(code).to_bytes(32, "big") + bytes([0x80, 0x60, 43, 0x60, 0x00, 0x39, 0x60, 0x00, 0xF3, 0x00])
    assert len(prelude) == 43
    initcode = prelude + code
    open(os.path.join(outdir, "initcode.hex"), "w").write("0x" + initcode.hex())
    open(os.path.join(outdir, "code.hex"), "w").write("0x" + code.hex())
    print(f"raw wasm {os.path.getsize(src)} B -> processed {len(wasm)} B -> brotli {len(comp)} B -> onchain code {len(code)} B "
          f"(single-chunk limit 24576 B: {'OK' if len(code) <= 24576 else 'TOO BIG'}); initcode {len(initcode)} B")
    print("codehash", "0x" + keccak(code).hex())
    if rpc:
        addr = "0x" + secrets.token_hex(20)
        sender = "0x" + secrets.token_hex(20)
        data = keccak(text="activateProgram(address)")[:4] + encode(["address"], [addr])
        body = {"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [
            {"from": sender, "to": ARBWASM, "data": "0x" + data.hex(), "value": hex(10**18)}, "latest",
            {sender: {"balance": hex(2**200)}, addr: {"code": "0x" + code.hex()}}]}
        r = requests.post(rpc, json=body, timeout=120).json()
        if "result" in r:
            ver, fee = decode(["uint16", "uint256"], bytes.fromhex(r["result"][2:]))
            print(f"dry-run activation OK: stylus version {ver}, dataFee {fee} wei ({fee / 1e18:.8f} ETH)")
            open(os.path.join(outdir, "datafee.txt"), "w").write(str(fee))
        else:
            print("dry-run activation FAILED:", r.get("error"))


if __name__ == "__main__":
    main()
