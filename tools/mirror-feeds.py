"""Mirror RH mainnet Chainlink rounds into the testnet MockAggregators.

python tools/mirror-feeds.py            # one shot
python tools/mirror-feeds.py --loop 300 # every 300 s

For each of NVDA/TSLA/AAPL/SPY: read the mainnet proxy's latestRoundData; if its updatedAt is newer than
the testnet mock's, call pushRound(answer, updatedAt). Key: env DEPLOYER_PRIVATE_KEY (or repo .env).
Feed addresses come from contracts/deployments/46630.json. Weekends produce no new rounds, like mainnet.
"""
import argparse
import json
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")
import requests
from eth_abi import decode, encode
from eth_account import Account
from eth_utils import keccak, to_checksum_address

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MAINNET_PROXIES = {
    "NVDA": "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
    "TSLA": "0x4A1166a659A55625345e9515b32adECea5547C38",
    "AAPL": "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0",
    "SPY": "0x319724394D3A0e3669269846abE664Cd621f9f6A",
}
LATEST = keccak(text="latestRoundData()")[:4]
PUSH = keccak(text="pushRound(int256,uint256)")[:4]


def load_env():
    p = os.path.join(ROOT, ".env")
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


def rpc(url, method, params):
    for attempt in range(5):
        try:
            r = requests.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=60).json()
        except Exception as e:
            print("rpc retry", attempt, repr(e)[:100], file=sys.stderr)
            time.sleep(2 + 2 * attempt)
            continue
        if "error" in r:
            raise RuntimeError(r["error"])
        return r["result"]
    raise RuntimeError("rpc failed")


def latest(url, addr):
    out = rpc(url, "eth_call", [{"to": addr, "data": "0x" + LATEST.hex()}, "latest"])
    _, answer, _, updated, _ = decode(["uint80", "int256", "uint256", "uint256", "uint80"], bytes.fromhex(out[2:]))
    return answer, updated


def once(args, acct, feeds):
    chain_id = int(rpc(args.testnet_rpc, "eth_chainId", []), 16)
    for sym, proxy in MAINNET_PROXIES.items():
        mock = to_checksum_address(feeds[sym])
        m_ans, m_upd = latest(args.mainnet_rpc, proxy)
        t_ans, t_upd = latest(args.testnet_rpc, mock)
        if m_upd <= t_upd:
            print(f"{sym}: up to date (updatedAt {t_upd})")
            continue
        data = "0x" + (PUSH + encode(["int256", "uint256"], [m_ans, m_upd])).hex()
        nonce = int(rpc(args.testnet_rpc, "eth_getTransactionCount", [acct.address, "pending"]), 16)
        base = int(rpc(args.testnet_rpc, "eth_gasPrice", []), 16)
        est = int(rpc(args.testnet_rpc, "eth_estimateGas", [{"from": acct.address, "to": mock, "data": data}]), 16)
        tx = {"chainId": chain_id, "nonce": nonce, "gas": int(est * 1.3) + 20_000, "maxFeePerGas": base * 3,
              "maxPriorityFeePerGas": 0, "to": mock, "data": data, "value": 0, "type": 2}
        raw = acct.sign_transaction(tx).raw_transaction.hex()
        h = rpc(args.testnet_rpc, "eth_sendRawTransaction", [raw if raw.startswith("0x") else "0x" + raw])
        for _ in range(120):
            rc = rpc(args.testnet_rpc, "eth_getTransactionReceipt", [h])
            if rc:
                break
            time.sleep(1)
        status = int(rc["status"], 16) if rc else None
        print(f"{sym}: pushed answer {m_ans} updatedAt {m_upd} (was {t_upd}) tx {h} status {status}")


def main():
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--loop", type=int, metavar="SECONDS")
    ap.add_argument("--testnet-rpc", default=os.environ.get("RH_TESTNET_RPC", "https://rpc.testnet.chain.robinhood.com"))
    ap.add_argument("--mainnet-rpc", default=os.environ.get("RH_MAINNET_RPC", "https://rpc.mainnet.chain.robinhood.com"))
    args = ap.parse_args()
    key = os.environ.get("DEPLOYER_PRIVATE_KEY")
    if not key:
        sys.exit("DEPLOYER_PRIVATE_KEY not set")
    acct = Account.from_key(key)
    cid = int(rpc(args.testnet_rpc, "eth_chainId", []), 16)
    feeds = json.load(open(os.path.join(ROOT, "contracts", "deployments", f"{cid}.json")))["feeds"]
    while True:
        try:
            once(args, acct, feeds)
        except Exception as e:
            print("mirror error:", repr(e)[:200], file=sys.stderr)
            if not args.loop:
                raise
        if not args.loop:
            break
        time.sleep(args.loop)


if __name__ == "__main__":
    main()
