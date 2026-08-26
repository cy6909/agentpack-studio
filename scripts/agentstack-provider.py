#!/usr/bin/env python3

from __future__ import annotations

import argparse
import asyncio
import json

from agentstack_cli.configuration import Configuration
from agentstack_sdk.platform.provider import Provider


def normalized_location(value: object) -> str:
    return str(value).rstrip("/")


async def verify_provider(name: str, source: str, wait_online_seconds: int) -> None:
    configuration = Configuration()
    deadline = asyncio.get_running_loop().time() + wait_online_seconds
    provider = None
    while True:
        async with configuration.use_platform_client() as client:
            providers = await Provider.list(client=client)
        matches = [
            candidate
            for candidate in providers
            if candidate.agent_card.name == name
            and normalized_location(source)
            in {normalized_location(candidate.source), normalized_location(candidate.origin)}
        ]
        if not matches:
            raise RuntimeError(f"Agent Stack has no exact provider match for name={name!r}, source={source!r}")
        provider = max(matches, key=lambda candidate: candidate.created_at)
        if wait_online_seconds == 0 or str(provider.state) == "online":
            break
        if asyncio.get_running_loop().time() >= deadline:
            raise RuntimeError(
                f"Agent Stack provider did not become online within {wait_online_seconds}s: "
                f"name={name!r}, source={source!r}, state={provider.state!s}"
            )
        await asyncio.sleep(2)

    print(
        json.dumps(
            {
                "event": (
                    "agentpack.agentstack.provider.ready"
                    if wait_online_seconds > 0
                    else "agentpack.agentstack.provider.reused"
                ),
                "id": str(provider.id),
                "name": provider.agent_card.name,
                "source": str(provider.source),
                "origin": str(provider.origin),
                "state": str(provider.state),
            },
            sort_keys=True,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify an exact pre-existing Agent Stack provider")
    parser.add_argument("--name", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--wait-online-seconds", type=int, default=0)
    args = parser.parse_args()
    if args.wait_online_seconds < 0:
        parser.error("--wait-online-seconds must be non-negative")
    asyncio.run(verify_provider(args.name, args.source, args.wait_online_seconds))


if __name__ == "__main__":
    main()
