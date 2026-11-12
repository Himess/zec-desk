"""Runs a command (forge, cast) with DEPLOYER_PRIVATE_KEY set from ZEC Desk's gitignored .env.sepolia, in the child's
environment only: never on a command line, never printed. Sepolia only.

    python scripts/with-deployer-key.py forge script script/DeployRelay.s.sol --rpc-url <sepolia rpc> --broadcast
"""

import os
import pathlib
import re
import subprocess
import sys

ENV_FILE = pathlib.Path(__file__).resolve().parent.parent / ".env.sepolia"


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    values = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            values[k.strip()] = v.strip()
    key = values.get("ZEC_DESK_DEPLOYER_KEY", "")
    if not re.fullmatch(r"0x[0-9a-fA-F]{64}", key):
        print(".env.sepolia has no ZEC_DESK_DEPLOYER_KEY: run scripts/keys.ts", file=sys.stderr)
        return 2
    env = dict(os.environ, DEPLOYER_PRIVATE_KEY=key)
    return subprocess.run(sys.argv[1:], env=env).returncode


if __name__ == "__main__":
    sys.exit(main())
