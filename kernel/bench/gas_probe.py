"""Measure the kernel's gas on Robinhood Chain testnet without deploying anything.

One eth_call per measurement, with state overrides that place (a) the compressed Stylus
program and (b) GasProbe at fresh addresses. GasProbe activates the program inside the
call (ArbWasm.activateProgram, paying the data fee from the overridden balance) and then
measures a single staticcall with gasleft(). The Solidity KernelReference is measured the
same way on identical calldata (no activation), and the two return datas are compared.

Nothing is broadcast and no funds are needed. Requires foundry (forge), wasm-tools and the
Python packages in run_wasm.py plus brotli and requests.

    python kernel/bench/gas_probe.py [rpc]
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile

import requests
from eth_abi import decode, encode
from eth_utils import keccak

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_wasm  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
KERNEL = os.path.dirname(HERE)
ROOT = os.path.dirname(KERNEL)
RPC = sys.argv[1] if len(sys.argv) > 1 else "https://rpc.testnet.chain.robinhood.com"
SOL_FILES = ["types/Types.sol", "interfaces/IRiskKernel.sol", "libraries/FixedPointMath.sol",
             "libraries/BlackScholes.sol", "kernel/KernelReference.sol"]
CALL_GAS = 50_000_000  # the RPC's eth_call gas cap


def build_solidity(tmp):
    """Compile GasProbe and KernelReference with the repo's compiler settings; return runtime code."""
    proj = os.path.join(tmp, "sol")
    for f in SOL_FILES:
        dst = os.path.join(proj, "src", f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy(os.path.join(ROOT, "contracts", "src", f), dst)
    shutil.copy(os.path.join(HERE, "GasProbe.sol"), os.path.join(proj, "src", "GasProbe.sol"))
    with open(os.path.join(proj, "foundry.toml"), "w") as fh:
        fh.write('[profile.default]\nsrc = "src"\nout = "out"\nsolc_version = "0.8.30"\n'
                 'evm_version = "prague"\nvia_ir = true\noptimizer = true\noptimizer_runs = 200\n')
    subprocess.run(["forge", "build", "--root", proj], check=True, capture_output=True)

    def runtime(name):
        art = json.load(open(os.path.join(proj, "out", f"{name}.sol", f"{name}.json")))
        return art["deployedBytecode"]["object"]

    return runtime("GasProbe"), runtime("KernelReference")


def build_stylus(tmp):
    """Compressed program code (0xEFF00000 || brotli(wasm)) and the activation data fee."""
    wasm = os.path.join(KERNEL, "target", "wasm32-unknown-unknown", "release", "novation_kernel.wasm")
    out = os.path.join(tmp, "stylus")
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "stylus-deploy", "prep_stylus.py"), wasm, out, RPC],
                   check=True, capture_output=True)
    code = open(os.path.join(out, "code.hex")).read().strip()
    fee = int(open(os.path.join(out, "datafee.txt")).read())
    return code, fee


class Chain:
    def __init__(self, probe_code, stylus_code, fee, sol_code):
        self.sender = "0x" + secrets.token_hex(20)
        self.probe = "0x" + secrets.token_hex(20)
        self.stylus = "0x" + secrets.token_hex(20)
        self.sol = "0x" + secrets.token_hex(20)
        self.fee = fee
        self.overrides = {
            self.sender: {"balance": hex(10**30)},
            self.probe: {"code": probe_code},
            self.stylus: {"code": stylus_code},
            self.sol: {"code": sol_code},
        }

    def measure(self, target, data):
        fee = self.fee if target == self.stylus else 0
        sel = keccak(text="measure(address,uint256,bytes)")[:4]
        payload = sel + encode(["address", "uint256", "bytes"], [target, fee, data])
        body = {"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [
            {"from": self.sender, "to": self.probe, "data": "0x" + payload.hex(), "value": hex(fee),
             "gas": hex(CALL_GAS)}, "latest", self.overrides]}
        r = requests.post(RPC, json=body, timeout=300).json()
        if "result" not in r:
            return None, None, r.get("error")
        ok, gas, ret = decode(["bool", "uint256", "bytes"], bytes.fromhex(r["result"][2:]))
        return ok, gas, ret


def main():
    tmp = tempfile.mkdtemp(prefix="kernel-gas-")
    try:
        probe_code, sol_code = build_solidity(tmp)
        stylus_code, fee = build_stylus(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    chain = Chain(probe_code, stylus_code, fee, sol_code)
    print(f"RPC {RPC}; program {len(stylus_code) // 2 - 1} B, activation data fee {fee} wei")

    v = json.load(open(run_wasm.VECTORS))
    big = max(run_wasm.books(v), key=lambda b: len(b[2]))
    p, us, ps = big[0], big[1], big[2]
    local = run_wasm.Program(run_wasm.WASM)
    print(f"\nmargin(), one {len(us)}-underlying book, first N positions (gas of the staticcall, uncached program)")
    print(f"{'N':>5} {'Stylus':>11} {'Solidity ref':>13} {'ratio':>7}  result")
    for n in (0, 1, 8, 32, 64, 128, 256):
        data = run_wasm.calldata("margin", [p, us, ps[:n]])
        ok, g_st, ret = chain.measure(chain.stylus, data)
        st, want, _, _ = local.call(data)
        assert ok and st == 0 and ret == want, f"N={n}: on-chain Stylus result differs from the local wasm run"
        g_sol = "-"
        note = "Stylus == local wasm"
        if n <= 32:
            ok2, g, ret2 = chain.measure(chain.sol, data)
            if ok2 is not None:
                assert ok2 and ret2 == ret, f"N={n}: Solidity and Stylus results differ"
                g_sol = g
                note += " == Solidity"
        ratio = f"{g_sol / g_st:.1f}x" if isinstance(g_sol, int) else ""
        print(f"{n:>5} {g_st:>11,} {g_sol if isinstance(g_sol, str) else f'{g_sol:,}':>13} {ratio:>7}  {note}")

    q = v["bsQuote"]
    data = run_wasm.calldata("bsQuote", [int(q["spot"][0]), int(q["strike"][0]), int(q["tau"][0]), int(q["vol"][0]),
                                          int(q["rate"][0]), bool(q["isCall"][0])])
    _, g_st, r1 = chain.measure(chain.stylus, data)
    _, g_sol, r2 = chain.measure(chain.sol, data)
    assert r1 == r2
    print(f"\nbsQuote: Stylus {g_st:,}  Solidity ref {g_sol:,}")
    e = v["ewma"]
    k = int(e["n"][0])
    data = run_wasm.calldata("ewmaUpdate", [int(e["prevR2"][0]), int(e["prevDt"][0]), int(e["lastPrice"][0]),
                                             run_wasm.ints(e["prices"][:k]), run_wasm.ints(e["dts"][:k]),
                                             int(e["lambda"][0])])
    _, g_st, r1 = chain.measure(chain.stylus, data)
    _, g_sol, r2 = chain.measure(chain.sol, data)
    assert r1 == r2
    print(f"ewmaUpdate ({k} samples): Stylus {g_st:,}  Solidity ref {g_sol:,}")


if __name__ == "__main__":
    main()
