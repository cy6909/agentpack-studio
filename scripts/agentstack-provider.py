#!/usr/bin/env python3

from __future__ import annotations

import argparse
import asyncio
import json

from agentstack_cli.configuration import Configuration
from agentstack_sdk.platform.provider import Provider


def normalized_location(value: object) -> str:
    return str(value).rstrip("/")


async def verify_provider(name: str, source: str) -> None:
    configuration = Configuration()
    async with configuration.use_platform_client() as client:
        providers = await Provider.list(client=client)
    matches = [
        provider
        for provider in providers
        if provider.agent_card.name == name
        and normalized_location(source)
        in {normalized_location(provider.source), normalized_location(provider.origin)}
    ]
    if not matches:
        raise RuntimeError(f"Agent Stack has no exact provider match for name={name!r}, source={source!r}")
    provider = max(matches, key=lambda candidate: candidate.created_at)
    print(
        json.dumps(
            {
                "event": "agentpack.agentstack.provider.reused",
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
    args = parser.parse_args()
    asyncio.run(verify_provider(args.name, args.source))


if __name__ == "__main__":
    main()
