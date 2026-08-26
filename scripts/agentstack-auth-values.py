#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description="Write ephemeral Agent Stack PoC authentication values")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    values = {
        "auth": {"enabled": True, "basic": {"enabled": True}},
        "keycloak": {
            "auth": {
                "seedAgentstackUsers": [
                    {
                        "username": required_environment("AGENTPACK_AGENTSTACK_USERNAME"),
                        "password": required_environment("AGENTPACK_AGENTSTACK_PASSWORD"),
                        "firstName": "AgentPack",
                        "lastName": "PoC",
                        # Agent Stack v0.7.1's unmanaged-provider health job always
                        # patches providers as the built-in admin@beeai.dev user.
                        # Mapping the ephemeral PoC login to that existing subject
                        # keeps authenticated registrations visible to the job.
                        "email": "admin@beeai.dev",
                        "enabled": True,
                        "roles": ["agentstack-admin"],
                    }
                ]
            }
        },
    }
    output = Path(args.output)
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    output.write_text(json.dumps(values), encoding="utf-8")
    output.chmod(0o600)


if __name__ == "__main__":
    main()
