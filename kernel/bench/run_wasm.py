"""Run the release wasm of the kernel the way Stylus does, on the host, with wasmtime.

The hostio imports are stubbed (calldata in, result out, zero msg.value, not reentrant),
calldata is ABI-encoded with eth_abi from the IRiskKernel signatures, and every call is
checked against contracts/test/vectors/kernel.json. wasmtime fuel counts executed wasm
instructions, which the instruction-count benchmark prints per book size.

    python kernel/bench/run_wasm.py [path/to/novation_kernel.wasm]
"""

import json
import os
import sys

import wasmtime
from eth_abi import decode, encode
from eth_utils import keccak

HERE = os.path.dirname(os.path.abspath(__file__))
KERNEL = os.path.dirname(HERE)
WASM = os.path.join(KERNEL, "target", "wasm32-unknown-unknown", "release", "novation_kernel.wasm")
VECTORS = os.path.join(KERNEL, "..", "contracts", "test", "vectors", "kernel.json")

P = "(uint256,int256,uint256,uint256)"
U = "(uint256,uint256,uint256,uint256,uint256,int256)"
Q = "(uint256,bool,uint256,uint256,int256)"
SIG = {
    "margin": (f"margin({P},{U}[],{Q}[])", [P, f"{U}[]", f"{Q}[]"], [
        "(int256,uint256,uint256,uint256,uint256,uint256)", "int256[]"]),
    "scenarioGrid": (f"scenarioGrid({P},{U}[],{Q}[])", [P, f"{U}[]", f"{Q}[]"], ["int256[]"]),
    "bsQuote": ("bsQuote(uint256,uint256,uint256,uint256,int256,bool)",
                ["uint256", "uint256", "uint256", "uint256", "int256", "bool"],
                ["uint256", "int256", "uint256", "uint256", "int256"]),
    "ewmaUpdate": ("ewmaUpdate(uint256,uint256,uint256,uint256[],uint256[],uint256)",
                   ["uint256", "uint256", "uint256", "uint256[]", "uint256[]", "uint256"], ["uint256", "uint256"]),
}


class Program:
    def __init__(self, path):
        cfg = wasmtime.Config()
        cfg.consume_fuel = True
        self.engine = wasmtime.Engine(cfg)
        self.module = wasmtime.Module.from_file(self.engine, path)

    def call(self, data):
        """Returns (status, returndata, fuel, pages grown)."""
        store = wasmtime.Store(self.engine)
        store.set_fuel(10**13)
        mem = {}
        out = {"r": b"", "pages": 0}
        i32 = wasmtime.ValType.i32()

        def read_args(ptr):
            mem["m"].write(store, data, ptr)

        def write_result(ptr, ln):
            out["r"] = bytes(mem["m"].read(store, ptr, ptr + ln))

        def pay_for_memory_grow(pages):
            out["pages"] += pages

        def msg_value(ptr):
            mem["m"].write(store, b"\x00" * 32, ptr)

        hooks = {
            "read_args": wasmtime.Func(store, wasmtime.FuncType([i32], []), read_args),
            "write_result": wasmtime.Func(store, wasmtime.FuncType([i32, i32], []), write_result),
            "pay_for_memory_grow": wasmtime.Func(store, wasmtime.FuncType([i32], []), pay_for_memory_grow),
            "msg_reentrant": wasmtime.Func(store, wasmtime.FuncType([], [i32]), lambda: 0),
            "msg_value": wasmtime.Func(store, wasmtime.FuncType([i32], []), msg_value),
            "storage_flush_cache": wasmtime.Func(store, wasmtime.FuncType([i32], []), lambda c: None),
        }
        inst = wasmtime.Instance(store, self.module, [hooks[i.name] for i in self.module.imports])
        mem["m"] = inst.exports(store)["memory"]
        status = inst.exports(store)["user_entrypoint"](store, len(data))
        return status, out["r"], 10**13 - store.get_fuel(), out["pages"]


def calldata(fn, args):
    sig, types, _ = SIG[fn]
    return keccak(text=sig)[:4] + encode(types, args)


def ints(xs):
    return [int(x) for x in xs]


def books(v):
    b = v["books"]
    ou = op = 0
    for i in range(len(b["n_us"])):
        nu, np_ = int(b["n_us"][i]), int(b["n_ps"][i])
        p = (int(b["p_nowTs"][i]), int(b["p_rate"][i]), int(b["p_credit"][i]), int(b["p_shortMin"][i]))
        us = [tuple(int(b[f"us_{f}"][j]) for f in ("spot", "vol", "shockRange", "volUp", "volDown", "tokenQty"))
              for j in range(ou, ou + nu)]
        ps = [(int(b["ps_u"][j]), bool(b["ps_isCall"][j]), int(b["ps_expiry"][j]), int(b["ps_strike"][j]),
               int(b["ps_qty"][j])) for j in range(op, op + np_)]
        out = tuple(int(b[f"out_{f}"][i]) for f in ("mtm", "lossIM", "lossCorr", "lossIndep", "shortMin",
                                                   "worstScenario"))
        yield p, us, ps, out, ints(b["out_perUnderlyingWorst"][ou:ou + nu]), ints(b["out_scenarioGrid"][39 * i:39 * i + 39])
        ou += nu
        op += np_


def check_vectors(prog, v):
    n = 0
    fuel_by_n = {}
    for i, (p, us, ps, out, puw, grid) in enumerate(books(v)):
        st, r, fuel, pages = prog.call(calldata("margin", [p, us, ps]))
        assert st == 0, f"margin book {i} reverted: {r.hex()}"
        got = decode(SIG["margin"][2], r)
        assert tuple(got[0]) == out and list(got[1]) == puw, f"margin book {i}"
        fuel_by_n.setdefault(len(ps), []).append((fuel, pages, len(us)))
        st, r, _, _ = prog.call(calldata("scenarioGrid", [p, us, ps]))
        assert st == 0 and list(decode(["int256[]"], r)[0]) == grid, f"scenarioGrid book {i}"
        n += 1
    e = v["ewma"]
    off = 0
    for c in range(len(e["n"])):
        k = int(e["n"][c])
        args = [int(e["prevR2"][c]), int(e["prevDt"][c]), int(e["lastPrice"][c]), ints(e["prices"][off:off + k]),
                ints(e["dts"][off:off + k]), int(e["lambda"][c])]
        off += k
        st, r, _, _ = prog.call(calldata("ewmaUpdate", args))
        assert st == 0 and decode(SIG["ewmaUpdate"][2], r) == (int(e["out_r2"][c]), int(e["out_dt"][c])), f"ewma {c}"
    q = v["bsQuote"]
    for i in range(len(q["spot"])):
        args = [int(q["spot"][i]), int(q["strike"][i]), int(q["tau"][i]), int(q["vol"][i]), int(q["rate"][i]),
                bool(q["isCall"][i])]
        st, r, _, _ = prog.call(calldata("bsQuote", args))
        want = tuple(int(q[f][i]) for f in ("price", "delta", "gamma", "vega", "theta"))
        assert st == 0 and decode(SIG["bsQuote"][2], r) == want, f"bsQuote {i}"
    print(f"wasm parity: {n} books (margin + scenarioGrid), {len(e['n'])} ewma, {len(q['spot'])} bsQuote: all exact")
    return fuel_by_n


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else WASM
    prog = Program(path)
    v = json.load(open(VECTORS))
    fuel_by_n = check_vectors(prog, v)

    # instruction counts: the largest book (256 positions) and its prefixes
    big = max(books(v), key=lambda b: len(b[2]))
    p, us, ps = big[0], big[1], big[2]
    print(f"\nmargin() instruction counts, one {len(us)}-underlying book, first N positions:")
    print(f"{'N':>5} {'wasm instr':>12} {'per position':>13} {'pages grown':>12}")
    base = None
    for n in (0, 1, 8, 32, 64, 128, 256):
        st, r, fuel, pages = prog.call(calldata("margin", [p, us, ps[:n]]))
        assert st == 0
        per = "" if base is None or n == 0 else f"{(fuel - base) / n:,.0f}"
        if n == 0:
            base = fuel
        print(f"{n:>5} {fuel:>12,} {per:>13} {pages:>12}")
    q = v["bsQuote"]
    st, r, fuel, _ = prog.call(calldata("bsQuote", [int(q[f][0]) if f != "isCall" else bool(q[f][0])
                                                     for f in ("spot", "strike", "tau", "vol", "rate", "isCall")]))
    print(f"bsQuote (one case): {fuel:,} wasm instructions")


if __name__ == "__main__":
    main()
