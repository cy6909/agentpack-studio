#!/usr/bin/env python3

from __future__ import annotations

import argparse

from agentstack_cli.configuration import Configuration


def main() -> None:
    parser = argparse.ArgumentParser(description="Select an Agent Stack server for non-interactive Basic authentication")
    parser.add_argument("server")
    args = parser.parse_args()

    server = args.server.rstrip("/")
    configuration = Configuration()
    configuration.auth_manager.save_auth_info(server=server)
    configuration.auth_manager.active_server = server
    configuration.auth_manager.active_auth_server = None
    print(f"Activated Agent Stack server: {server}")


if __name__ == "__main__":
    main()
