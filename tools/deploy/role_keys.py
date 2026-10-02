"""Role keys derived from the deployer key, so no extra secret has to be stored:

    key(role) = keccak256(deployerKey || role)      role in {"guardian", "treasury"}

  python tools/deploy/role_keys.py            # prints the role addresses
  eval "$(python tools/deploy/role_keys.py --export)"   # export GUARDIAN=0x.. TREASURY=0x..

Only addresses are ever printed. The deployer key comes from env DEPLOYER_PRIVATE_KEY (or .env).
Anyone holding the deployer key can re-derive these keys: they separate the on-chain roles, not
the custody. Use role_account() from other tools to sign as a role.
"""
import argparse
import os

from eth_account import Account
from eth_utils import keccak

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ROLES = ("guardian", "treasury")


def deployer_key():
    key = os.environ.get("DEPLOYER_PRIVATE_KEY")
    if not key:
        p = os.path.join(ROOT, ".env")
        for line in open(p) if os.path.exists(p) else []:
            k, _, v = line.strip().partition("=")
            if k.strip() == "DEPLOYER_PRIVATE_KEY":
                key = v.strip().strip('"')
    if not key:
        raise SystemExit("DEPLOYER_PRIVATE_KEY not set")
    return bytes.fromhex(key[2:] if key.startswith("0x") else key)


def role_account(role):
    return Account.from_key(keccak(deployer_key() + role.encode()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", action="store_true", help="print shell export lines")
    a = ap.parse_args()
    for role in ROLES:
        addr = role_account(role).address
        print(f"export {role.upper()}={addr}" if a.export else f"{role} {addr}")


if __name__ == "__main__":
    main()
