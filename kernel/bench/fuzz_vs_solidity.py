"""Differential fuzz: the release wasm (run locally, as in run_wasm.py) against the Solidity
KernelReference (on a local anvil), on random inputs whose magnitudes range from realistic to
2^256. Every call must give the same outcome: identical return data, or a revert with
identical revert data (custom error or Panic code).

    python kernel/bench/fuzz_vs_solidity.py [cases] [seed] [extreme]

`extreme` is the probability that a field leaves its realistic range (default 0.3).
"""

import os
import random
import socket
import subprocess
import sys
import tempfile
import time
import shutil

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gas_probe  # noqa: E402
import run_wasm  # noqa: E402

WAD = 10**18
NOW = 1_790_000_000
U256_MAX = 2**256 - 1
EXTREME = [0.3]


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Anvil:
    def __init__(self, code):
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.proc = subprocess.Popen(["anvil", "--port", str(self.port), "--silent", "--gas-limit", "4000000000",
                                      "--code-size-limit", "100000"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                self.rpc("eth_chainId", [])
                break
            except requests.ConnectionError:
                if self.proc.poll() is not None:
                    raise RuntimeError("anvil exited")
                time.sleep(0.1)
        self.addr = "0x" + "11" * 20
        self.rpc("anvil_setCode", [self.addr, code])

    def rpc(self, method, params):
        return requests.post(self.url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                             timeout=120).json()

    def call(self, data):
        """(status, data): status 0 = success, 1 = revert, None = could not evaluate (e.g. out of gas)."""
        r = self.rpc("eth_call", [{"to": self.addr, "data": "0x" + data.hex(), "gas": hex(3_000_000_000)}, "latest"])
        if "result" in r:
            return 0, bytes.fromhex(r["result"][2:])
        err = r.get("error", {})
        d = err.get("data")
        if isinstance(d, str) and d.startswith("0x"):
            return 1, bytes.fromhex(d[2:])
        if "revert" in err.get("message", "") and "out of gas" not in err.get("message", ""):
            return 1, b""
        return None, err

    def close(self):
        self.proc.kill()


def mag(rng, realistic, signed=False):
    """A value that is realistic most of the time and otherwise anywhere up to 2^256."""
    r = rng.random()
    x = EXTREME[0]
    if r < 1 - x:
        v = realistic()
    elif r < 1 - 2 * x / 3:
        v = rng.choice([0, 1, 2**127 - 1, 2**127, 2**128, 2**255 - 1, 2**255, U256_MAX, 10**38, 10**40])
    else:
        v = rng.getrandbits(rng.randint(1, 256))
    if signed:
        v &= U256_MAX
        v = v - 2**256 if v >= 2**255 else v
        if rng.random() < 0.5 and r >= 1 - x:
            v = -v if -2**255 <= -v < 2**255 else v
    return v


def rand_book(rng):
    nu = rng.randint(0, 3)
    us = []
    for _ in range(nu):
        spot = mag(rng, lambda: rng.randint(1, 5000) * WAD)
        us.append((spot,
                   mag(rng, lambda: rng.randint(0, 3 * WAD)),
                   mag(rng, lambda: rng.randint(0, 9 * WAD // 10)) if rng.random() < 0.3 else rng.randint(0, 9 * WAD // 10),
                   mag(rng, lambda: rng.randint(0, WAD)),
                   rng.randint(0, WAD - 1) if rng.random() < 0.9 else mag(rng, lambda: WAD),
                   mag(rng, lambda: rng.randint(0, 100 * WAD), signed=True)))
    ps = []
    for _ in range(rng.randint(0, 4)):
        u = rng.randint(0, max(nu - 1, 0)) if rng.random() < 0.95 else mag(rng, lambda: nu)
        ps.append((u, rng.random() < 0.5,
                   NOW + rng.randint(-86400, 400 * 86400) if rng.random() < 0.8 else mag(rng, lambda: NOW),
                   mag(rng, lambda: rng.randint(1, 8000) * WAD),
                   mag(rng, lambda: rng.randint(-50 * WAD, 50 * WAD), signed=True)))
    p = (NOW if rng.random() < 0.9 else mag(rng, lambda: NOW),
         mag(rng, lambda: rng.choice([0, 4 * WAD // 100, -2 * WAD // 100]), signed=True),
         mag(rng, lambda: rng.randint(0, WAD // 2)),
         mag(rng, lambda: rng.randint(0, WAD // 20)))
    return p, us, ps


def main():
    cases = int(sys.argv[1]) if len(sys.argv) > 1 else 1500
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    EXTREME[0] = float(sys.argv[3]) if len(sys.argv) > 3 else 0.3
    rng = random.Random(seed)
    tmp = tempfile.mkdtemp(prefix="kernel-fuzz-")
    try:
        _, sol_code = gas_probe.build_solidity(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    anvil = Anvil(sol_code)
    wasm = run_wasm.Program(run_wasm.WASM)
    stats = {"same result": 0, "same revert": 0, "skipped (solidity out of gas)": 0}
    kinds = {}
    try:
        for i in range(cases):
            kind = rng.choice(["margin", "margin", "scenarioGrid", "bsQuote", "ewmaUpdate"])
            if kind in ("margin", "scenarioGrid"):
                args = list(rand_book(rng))
            elif kind == "bsQuote":
                args = [mag(rng, lambda: rng.randint(1, 5000) * WAD), mag(rng, lambda: rng.randint(1, 8000) * WAD),
                        mag(rng, lambda: rng.randint(0, 400 * 86400)), mag(rng, lambda: rng.randint(0, 3 * WAD)),
                        mag(rng, lambda: rng.choice([0, 5 * WAD // 100]), signed=True), rng.random() < 0.5]
            else:
                n = rng.randint(0, 6)
                m = n if rng.random() < 0.95 else rng.randint(0, 6)
                args = [mag(rng, lambda: rng.randint(0, WAD // 50)), mag(rng, lambda: rng.randint(0, WAD // 10)),
                        mag(rng, lambda: rng.randint(1, 2000) * WAD),
                        [mag(rng, lambda: rng.randint(1, 2000) * WAD) for _ in range(n)],
                        [rng.choice([0, 216000, rng.randint(60, 7 * 86400)]) if rng.random() < 0.8 else
                         mag(rng, lambda: 3600) for _ in range(m)],
                        mag(rng, lambda: rng.randint(9 * WAD // 10, 995 * WAD // 1000))]
            data = run_wasm.calldata(kind, args)
            want = anvil.call(data)
            if want[0] is None:
                stats["skipped (solidity out of gas)"] += 1
                continue
            st, got, _, _ = wasm.call(data)
            assert (st, got) == want, f"case {i} {kind} {args}: stylus {(st, got.hex())} vs solidity {(want[0], want[1].hex())}"
            key = "same result" if st == 0 else "same revert"
            stats[key] += 1
            tag = got[:4].hex() if st == 1 else "ok"
            kinds[(kind, tag)] = kinds.get((kind, tag), 0) + 1
    finally:
        anvil.close()
    print(f"fuzz vs Solidity (seed {seed}, extreme {EXTREME[0]}): {stats}")
    for (kind, tag), n in sorted(kinds.items()):
        print(f"  {kind:13} {tag:10} {n}")


if __name__ == "__main__":
    main()
