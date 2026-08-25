#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIRECTORY}/remote-env.sh"

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'scripts/bootstrap-remote.sh must run as root on %s\n' "$AGENTPACK_REQUIRED_ADDRESS" >&2
  exit 77
fi

NODE_ARCHIVE="node-${AGENTPACK_NODE_VERSION}-linux-x64.tar.xz"
NODE_ARCHIVE_SHA256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647

if [[ ! -x "${AGENTPACK_NODE_HOME}/bin/node" ]]; then
  BOOTSTRAP_DIRECTORY="$(mktemp -d /tmp/agentpack-bootstrap.XXXXXXXX)"
  trap 'rm -rf -- "$BOOTSTRAP_DIRECTORY"' EXIT
  curl --fail --show-error --location \
    "https://nodejs.org/dist/${AGENTPACK_NODE_VERSION}/${NODE_ARCHIVE}" \
    --output "${BOOTSTRAP_DIRECTORY}/${NODE_ARCHIVE}"
  printf '%s  %s\n' "$NODE_ARCHIVE_SHA256" "${BOOTSTRAP_DIRECTORY}/${NODE_ARCHIVE}" | sha256sum --check --status
  install -d -m 0755 /opt/agentpack-poc
  tar --extract --xz --file "${BOOTSTRAP_DIRECTORY}/${NODE_ARCHIVE}" --directory /opt/agentpack-poc
fi

if [[ ! -x "${AGENTPACK_NODE_HOME}/bin/pnpm" ]] \
  || [[ "$("${AGENTPACK_NODE_HOME}/bin/pnpm" --version)" != 11.7.0 ]]; then
  "${AGENTPACK_NODE_HOME}/bin/npm" install --global pnpm@11.7.0
fi

if ! id cy >/dev/null 2>&1; then
  printf 'The dedicated remote Agent Stack user cy is missing\n' >&2
  exit 77
fi

if [[ ! -x "$AGENTPACK_UV_BIN" ]]; then
  sudo -u cy -H sh -c 'curl -LsSf https://astral.sh/uv/install.sh | UV_PRINT_QUIET=1 sh'
fi

sudo -u cy -H "$AGENTPACK_UV_BIN" python install \
  --quiet \
  --python-preference=only-managed \
  --no-bin \
  3.14

sudo -u cy -H "$AGENTPACK_UV_BIN" tool install \
  --quiet \
  --python-preference=only-managed \
  --python=3.14 \
  --prerelease=if-necessary-or-explicit \
  --with "agentstack-sdk==${AGENTPACK_AGENTSTACK_VERSION}" \
  "agentstack-cli==${AGENTPACK_AGENTSTACK_VERSION}" \
  --force

printf 'node=%s\n' "$("${AGENTPACK_NODE_HOME}/bin/node" --version)"
printf 'pnpm=%s\n' "$("${AGENTPACK_NODE_HOME}/bin/pnpm" --version)"
printf 'agentstack=%s\n' "$(sudo -u cy -H env PATH="${AGENTPACK_WINDOWS_SYSTEM32}:/home/cy/.local/bin:/usr/local/bin:/usr/bin:/bin" "$AGENTPACK_AGENTSTACK_BIN" --version)"
