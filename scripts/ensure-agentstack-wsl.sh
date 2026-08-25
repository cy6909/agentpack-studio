#!/usr/bin/env bash

set -euo pipefail

: "${AGENTPACK_AGENTSTACK_VERSION:?AGENTPACK_AGENTSTACK_VERSION is required}"
: "${AGENTPACK_WINDOWS_SYSTEM32:?AGENTPACK_WINDOWS_SYSTEM32 is required}"

WSL_EXE="${AGENTPACK_WINDOWS_SYSTEM32}/wsl.exe"
CMD_EXE="${AGENTPACK_WINDOWS_SYSTEM32}/cmd.exe"

if [[ ! -x "$WSL_EXE" ]] || ! grep -Eqi '(microsoft|wsl)' /proc/sys/kernel/osrelease; then
  printf 'Agent Stack WSL pre-import: not required on this host\n'
  exit 0
fi

if WSL_UTF8=1 WSLENV="${WSLENV:-}:WSL_UTF8" "$WSL_EXE" --list --quiet \
  | tr -d '\000\r' \
  | grep -Fxq agentstack; then
  printf 'Agent Stack WSL pre-import: distribution already exists\n'
  exit 0
fi

windows_profile="$(
  cd /mnt/c
  "$CMD_EXE" /d /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r' | tail -n 1
)"
if [[ ! "$windows_profile" =~ ^[A-Za-z]:\\ ]]; then
  printf 'Unable to resolve the Windows user profile: %s\n' "$windows_profile" >&2
  exit 71
fi

linux_profile="$(wslpath -u "$windows_profile")"
cache_root="${linux_profile}/.agentstack-bootstrap"
image_path="${cache_root}/microshift-vm-x86_64-v${AGENTPACK_AGENTSTACK_VERSION}.wsl"
install_parent="${cache_root}/instances"
install_path="${install_parent}/agentstack-v${AGENTPACK_AGENTSTACK_VERSION}"
image_url="https://github.com/i-am-bee/agentstack/releases/download/v${AGENTPACK_AGENTSTACK_VERSION}/microshift-vm-x86_64.wsl"

mkdir -p "$cache_root" "$install_parent"
if [[ ! -s "$image_path" ]]; then
  printf 'Downloading official Agent Stack WSL image: %s\n' "$image_url"
  curl --fail --location --retry 3 --retry-all-errors \
    --output "${image_path}.partial" "$image_url"
  mv -- "${image_path}.partial" "$image_path"
fi

if [[ -e "$install_path" ]]; then
  install_path="${install_path}-$(date -u +%Y%m%dT%H%M%SZ)"
fi

windows_image_path="$(wslpath -w "$image_path")"
windows_install_path="$(wslpath -w "$install_path")"

printf 'Agent Stack WSL image sha256: '
sha256sum "$image_path" | awk '{print $1}'
printf 'Pre-importing distribution with Windows paths: %s\n' "$windows_install_path"
WSL_UTF8=1 WSLENV="${WSLENV:-}:WSL_UTF8" "$WSL_EXE" \
  --import agentstack "$windows_install_path" "$windows_image_path"
printf 'Agent Stack WSL pre-import: complete\n'
