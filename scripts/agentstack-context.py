#!/usr/bin/env python3

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import shlex
from pathlib import Path

from agentstack_cli.configuration import Configuration
from agentstack_sdk.platform.context import Context, Permissions
from agentstack_sdk.platform.provider import Provider


def parse_pairs(values: list[str], option: str) -> dict[str, str]:
    pairs: dict[str, str] = {}
    for value in values:
        alias, separator, target = value.partition("=")
        if not separator or not re.fullmatch(r"[a-z][a-z0-9-]*", alias) or not target:
            raise ValueError(f"{option} must use alias=value with a lowercase alias: {value}")
        if alias in pairs:
            raise ValueError(f"duplicate alias for {option}: {alias}")
        pairs[alias] = target
    return pairs


def secret_value(secret: object) -> str:
    getter = getattr(secret, "get_secret_value", None)
    if not callable(getter):
        raise TypeError("Agent Stack returned an unsupported context token type")
    value = getter()
    if not isinstance(value, str) or not value:
        raise ValueError("Agent Stack returned an empty context token")
    return value


async def create_context(args: argparse.Namespace) -> None:
    required = parse_pairs(args.provider, "--provider")
    sources = parse_pairs(args.source, "--source")
    unknown_sources = sorted(set(sources) - set(required))
    if unknown_sources:
        raise ValueError(f"--source aliases are absent from --provider: {', '.join(unknown_sources)}")

    configuration = Configuration()
    base_url = str(configuration.auth_manager.active_server or "").rstrip("/")
    if not base_url:
        raise RuntimeError("Agent Stack has no active server; run `agentstack server login` first")

    async with configuration.use_platform_client() as client:
        available = await Provider.list(client=client)
        selected: dict[str, Provider] = {}
        for alias, display_name in required.items():
            candidates = [provider for provider in available if provider.agent_card.name == display_name]
            expected_source = sources.get(alias)
            if expected_source is not None:
                candidates = [
                    provider
                    for provider in candidates
                    if expected_source in {provider.source, provider.origin}
                ]
            if not candidates:
                observed = sorted({provider.agent_card.name for provider in available})
                raise RuntimeError(
                    f"registered provider not found for {alias}={display_name}; observed={observed}"
                )
            selected[alias] = max(candidates, key=lambda provider: provider.created_at)

        context = await Context.create(
            metadata={"agentpack_scope": args.scope, "purpose": "AgentPack Studio technical piercing"},
            client=client,
        )
        provider_ids = {provider.id for provider in selected.values()}
        context_token = await context.generate_token(
            client=client,
            grant_global_permissions=Permissions(a2a_proxy=provider_ids, providers={"read"}),
        )

    token = secret_value(context_token.token)
    providers = {
        alias: {
            "id": provider.id,
            "name": provider.agent_card.name,
            "source": provider.source,
            "origin": provider.origin,
            "state": provider.state,
            "proxyUrl": f"{base_url}/api/v1/a2a/{provider.id}",
        }
        for alias, provider in selected.items()
    }
    evidence = {
        "agentStackVersion": "0.7.1",
        "server": base_url,
        "scope": args.scope,
        "contextId": context.id,
        "token": {
            "redacted": True,
            "length": len(token),
            "sha256": hashlib.sha256(token.encode()).hexdigest(),
        },
        "providers": providers,
    }

    env_lines = [
        f"export AGENTSTACK_TOKEN={shlex.quote(token)}",
        f"export AGENTSTACK_CONTEXT_ID={shlex.quote(context.id)}",
    ]
    for alias, provider in providers.items():
        prefix = f"AGENTSTACK_{alias.replace('-', '_').upper()}"
        env_lines.extend(
            [
                f"export {prefix}_PROVIDER_ID={shlex.quote(str(provider['id']))}",
                f"export {prefix}_URL={shlex.quote(str(provider['proxyUrl']))}",
            ]
        )

    env_path = Path(args.env_file).resolve()
    evidence_path = Path(args.evidence_file).resolve()
    env_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    env_path.write_text("\n".join(env_lines) + "\n", encoding="utf-8")
    env_path.chmod(0o600)
    evidence_path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(evidence, sort_keys=True))


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a scoped Agent Stack context token for registered Pack agents")
    parser.add_argument("--provider", action="append", default=[], required=True, help="alias=exact agent card name")
    parser.add_argument("--source", action="append", default=[], help="alias=exact registered source or origin")
    parser.add_argument("--scope", required=True)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--evidence-file", required=True)
    args = parser.parse_args()
    asyncio.run(create_context(args))


if __name__ == "__main__":
    main()
