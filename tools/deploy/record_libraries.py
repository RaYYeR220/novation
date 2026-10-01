"""Adds the logic libraries forge linked into the Clearinghouse, and the deploy block, from the
Deploy.s.sol broadcast to contracts/deployments/<chainId>.json.

  python tools/deploy/record_libraries.py [--chain 46630]
"""
import argparse
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chain", default="46630")
    a = ap.parse_args()
    run = os.path.join(ROOT, "contracts", "broadcast", "Deploy.s.sol", a.chain, "run-latest.json")
    path = os.path.join(ROOT, "contracts", "deployments", f"{a.chain}.json")
    b = json.load(open(run))
    dep = json.load(open(path))
    libs = {}
    for entry in b.get("libraries", []):
        _, name, addr = entry.rsplit(":", 2)
        libs[name] = addr
    dep["libraries"] = libs
    blocks = [int(r["blockNumber"], 16) for r in b.get("receipts", []) if r.get("blockNumber")]
    if blocks:
        dep["block"] = min(blocks)
    json.dump(dep, open(path, "w"), indent=2)
    print("libraries", libs, "block", dep.get("block"))


if __name__ == "__main__":
    main()
