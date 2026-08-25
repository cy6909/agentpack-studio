#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIRECTORY}/.." && pwd)"
source "${SCRIPT_DIRECTORY}/remote-env.sh"
cd "$PROJECT_ROOT"

: "${QWEN_API_KEY:?QWEN_API_KEY is required for the real model at 10.89.2.200}"

AGENTPACK_AGENTSTACK_USERNAME=agentpack-poc
AGENTPACK_AGENTSTACK_PASSWORD="$(openssl rand -hex 24)"

if [[ -n "$(git status --porcelain)" ]]; then
  printf 'Remote worktree must be clean before the PoC run\n' >&2
  git status --short >&2
  exit 65
fi

git fetch origin main
git merge --ff-only origin/main

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_ROOT="${PROJECT_ROOT}/.agentpack/evidence/${RUN_ID}"
RUNTIME_ROOT="${PROJECT_ROOT}/.runtime/${RUN_ID}"
mkdir -p "$EVIDENCE_ROOT" "$RUNTIME_ROOT"

PACK_PIDS=()
AGENTSTACK_VALUES_FILE=""
cleanup() {
  local pid
  for pid in "${PACK_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${PACK_PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  rm -f -- "${RUNTIME_ROOT}/agentstack-leaf.env" "${RUNTIME_ROOT}/agentstack-all.env"
  if [[ -n "$AGENTSTACK_VALUES_FILE" ]]; then
    rm -f -- "$AGENTSTACK_VALUES_FILE"
  fi
}
trap cleanup EXIT INT TERM

run_agentstack() {
  sudo -u cy -H env \
    PATH="${AGENTPACK_WINDOWS_SYSTEM32}:${AGENTPACK_TOOL_ROOT}/bin:/usr/local/bin:/usr/bin:/bin" \
    AGENTSTACK__USERNAME="$AGENTPACK_AGENTSTACK_USERNAME" \
    AGENTSTACK__PASSWORD="$AGENTPACK_AGENTSTACK_PASSWORD" \
    "$AGENTPACK_AGENTSTACK_BIN" "$@"
}

agentstack_python() {
  local executable
  executable="$(readlink -f "$AGENTPACK_AGENTSTACK_BIN")"
  printf '%s/python\n' "$(dirname "$executable")"
}

assert_port_free() {
  local port="$1"
  if ss -H -ltn | awk '{print $4}' | grep -Eq ":${port}$"; then
    printf 'Required PoC port is already in use: %s\n' "$port" >&2
    exit 69
  fi
}

wait_for_health() {
  local url="$1"
  local label="$2"
  local deadline=$((SECONDS + 180))
  until curl --fail --silent --show-error "${url}/healthz" >/dev/null; do
    if (( SECONDS >= deadline )); then
      printf 'Timed out waiting for %s at %s\n' "$label" "$url" >&2
      exit 70
    fi
    sleep 1
  done
}

start_pack() {
  local name="$1"
  local pack_path="$2"
  local target_path="$3"
  local port="$4"
  shift 4
  local endpoint="http://10.89.2.12:${port}"
  assert_port_free "$port"
  mkdir -p "${EVIDENCE_ROOT}/agentstack/logs" "${EVIDENCE_ROOT}/agentstack/traces"
  env "$@" "$AGENTPACK_NODE_HOME/bin/node" dist/server-main.js \
    --pack "$pack_path" \
    --target "$target_path" \
    --port "$port" \
    --output "${RUNTIME_ROOT}/${name}" \
    --trace "${EVIDENCE_ROOT}/agentstack/traces/${name}.jsonl" \
    --public-url "$endpoint" \
    --project-root "$PROJECT_ROOT" \
    >"${EVIDENCE_ROOT}/agentstack/logs/${name}.stdout.log" \
    2>"${EVIDENCE_ROOT}/agentstack/logs/${name}.stderr.log" &
  PACK_PIDS+=("$!")
  wait_for_health "$endpoint" "$name"
}

printf '%s\n' "$RUN_ID" >"${EVIDENCE_ROOT}/run-id.txt"
git rev-parse HEAD >"${EVIDENCE_ROOT}/source-commit.txt"
git status --porcelain=v1 >"${EVIDENCE_ROOT}/source-status-before.txt"
"$AGENTPACK_NODE_HOME/bin/node" --version >"${EVIDENCE_ROOT}/node-version.txt"
"$AGENTPACK_NODE_HOME/bin/pnpm" --version >"${EVIDENCE_ROOT}/pnpm-version.txt"

"$AGENTPACK_NODE_HOME/bin/pnpm" install --frozen-lockfile 2>&1 | tee "${EVIDENCE_ROOT}/pnpm-install.log"
"$AGENTPACK_NODE_HOME/bin/pnpm" build 2>&1 | tee "${EVIDENCE_ROOT}/build.log"

assert_port_free 8299
"$AGENTPACK_NODE_HOME/bin/node" dist/model-policy-proxy-main.js \
  --host 127.0.0.1 \
  --port 8299 \
  --upstream http://10.89.2.200:12345 \
  --audit "${EVIDENCE_ROOT}/model-policy-proxy.jsonl" \
  >"${EVIDENCE_ROOT}/model-policy-proxy.stdout.log" \
  2>"${EVIDENCE_ROOT}/model-policy-proxy.stderr.log" &
PACK_PIDS+=("$!")
wait_for_health http://127.0.0.1:8299 model-policy-proxy

"$AGENTPACK_NODE_HOME/bin/node" dist/cli.js versions >"${EVIDENCE_ROOT}/version-lock.json"
"$AGENTPACK_NODE_HOME/bin/node" dist/cli.js validate --all 2>&1 | tee "${EVIDENCE_ROOT}/pack-validation.jsonl"
"$AGENTPACK_NODE_HOME/bin/node" dist/cli.js compile --all --target targets/qwen-dsh.poc.json \
  2>&1 | tee "${EVIDENCE_ROOT}/pack-compilation.jsonl"
"$AGENTPACK_NODE_HOME/bin/node" dist/cli.js probe-model \
  --target targets/qwen-dsh.poc.json \
  --output "${EVIDENCE_ROOT}/model-probe.json" \
  2>&1 | tee "${EVIDENCE_ROOT}/model-probe.log"

"$AGENTPACK_NODE_HOME/bin/pnpm" test:unit 2>&1 | tee "${EVIDENCE_ROOT}/test-unit.log"
"$AGENTPACK_NODE_HOME/bin/pnpm" test:contract 2>&1 | tee "${EVIDENCE_ROOT}/test-contract.log"
"$AGENTPACK_NODE_HOME/bin/pnpm" test:integration 2>&1 | tee "${EVIDENCE_ROOT}/test-integration.log"
AGENTPACK_EVIDENCE_ROOT="${EVIDENCE_ROOT}/qwen-real" \
  "$AGENTPACK_NODE_HOME/bin/pnpm" test:remote:qwen 2>&1 | tee "${EVIDENCE_ROOT}/test-qwen-real.log"

bash scripts/ensure-agentstack-wsl.sh 2>&1 | tee "${EVIDENCE_ROOT}/agentstack-wsl-bootstrap.log"
AGENTSTACK_PYTHON="$(agentstack_python)"
AGENTSTACK_VALUES_FILE="/home/cy/.agentpack-poc/${RUN_ID}-values.json"
AGENTPACK_AGENTSTACK_USERNAME="$AGENTPACK_AGENTSTACK_USERNAME" \
AGENTPACK_AGENTSTACK_PASSWORD="$AGENTPACK_AGENTSTACK_PASSWORD" \
  "$AGENTSTACK_PYTHON" scripts/agentstack-auth-values.py --output "$AGENTSTACK_VALUES_FILE"
chown cy:cy "$(dirname "$AGENTSTACK_VALUES_FILE")" "$AGENTSTACK_VALUES_FILE"
run_agentstack platform start --skip-login -f "$AGENTSTACK_VALUES_FILE" \
  2>&1 | tee "${EVIDENCE_ROOT}/agentstack-platform-start.log"

AGENTSTACK__HOME=/home/cy/.agentstack \
AGENTSTACK__USERNAME="$AGENTPACK_AGENTSTACK_USERNAME" \
AGENTSTACK__PASSWORD="$AGENTPACK_AGENTSTACK_PASSWORD" \
  "$AGENTSTACK_PYTHON" scripts/agentstack-activate.py http://127.0.0.1:8333 \
  >"${EVIDENCE_ROOT}/agentstack-activate.log"
chown cy:cy /home/cy/.agentstack/auth.json

run_agentstack --version >"${EVIDENCE_ROOT}/agentstack-version.txt"
run_agentstack self version >"${EVIDENCE_ROOT}/agentstack-self-version.txt"

start_pack wardrobe packs/stylemuse-wardrobe/pack.json targets/qwen-dsh.poc.json 8101 \
  QWEN_API_KEY="$QWEN_API_KEY" \
  AGENTPACK_WARDROBE_MCP_AUDIT_PATH="${EVIDENCE_ROOT}/agentstack/traces/wardrobe-mcp.jsonl"
start_pack parenting packs/parenting-safety/pack.json targets/qwen-dsh.poc.json 8102 \
  QWEN_API_KEY="$QWEN_API_KEY" \
  AGENTPACK_PARENTING_MCP_AUDIT_PATH="${EVIDENCE_ROOT}/agentstack/traces/parenting-mcp.jsonl"

run_agentstack add http://10.89.2.12:8101 --yes 2>&1 | tee "${EVIDENCE_ROOT}/agentstack-add-wardrobe.log"
run_agentstack add http://10.89.2.12:8102 --yes 2>&1 | tee "${EVIDENCE_ROOT}/agentstack-add-parenting.log"

AGENTSTACK__HOME=/home/cy/.agentstack \
AGENTSTACK__USERNAME="$AGENTPACK_AGENTSTACK_USERNAME" \
AGENTSTACK__PASSWORD="$AGENTPACK_AGENTSTACK_PASSWORD" \
  "$AGENTSTACK_PYTHON" scripts/agentstack-context.py \
  --provider 'wardrobe=StyleMuse Wardrobe Advisor' \
  --provider 'parenting=Parenting Safety Advisor' \
  --source 'wardrobe=http://10.89.2.12:8101' \
  --source 'parenting=http://10.89.2.12:8102' \
  --scope agentpack-leaf-composition \
  --env-file "${RUNTIME_ROOT}/agentstack-leaf.env" \
  --evidence-file "${EVIDENCE_ROOT}/agentstack-leaf-context.json" \
  >"${EVIDENCE_ROOT}/agentstack-leaf-context.log"

set -a
source "${RUNTIME_ROOT}/agentstack-leaf.env"
set +a
start_pack family packs/family-trip-planner/pack.json targets/qwen-dsh-agentstack.poc.json 8103 \
  QWEN_API_KEY="$QWEN_API_KEY" \
  WARDROBE_AGENT_URL="$AGENTSTACK_WARDROBE_URL" \
  PARENTING_AGENT_URL="$AGENTSTACK_PARENTING_URL" \
  AGENTSTACK_TOKEN="$AGENTSTACK_TOKEN" \
  AGENTPACK_TRAVEL_MCP_AUDIT_PATH="${EVIDENCE_ROOT}/agentstack/traces/travel-mcp.jsonl"

run_agentstack add http://10.89.2.12:8103 --yes 2>&1 | tee "${EVIDENCE_ROOT}/agentstack-add-family.log"
run_agentstack list 2>&1 | tee "${EVIDENCE_ROOT}/agentstack-list.log"

AGENTSTACK__HOME=/home/cy/.agentstack \
AGENTSTACK__USERNAME="$AGENTPACK_AGENTSTACK_USERNAME" \
AGENTSTACK__PASSWORD="$AGENTPACK_AGENTSTACK_PASSWORD" \
  "$AGENTSTACK_PYTHON" scripts/agentstack-context.py \
  --provider 'wardrobe=StyleMuse Wardrobe Advisor' \
  --provider 'parenting=Parenting Safety Advisor' \
  --provider 'family=Family Trip Planner' \
  --source 'wardrobe=http://10.89.2.12:8101' \
  --source 'parenting=http://10.89.2.12:8102' \
  --source 'family=http://10.89.2.12:8103' \
  --scope agentpack-end-to-end \
  --env-file "${RUNTIME_ROOT}/agentstack-all.env" \
  --evidence-file "${EVIDENCE_ROOT}/agentstack-all-context.json" \
  >"${EVIDENCE_ROOT}/agentstack-all-context.log"

set -a
source "${RUNTIME_ROOT}/agentstack-all.env"
set +a
UNAUTHENTICATED_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "${AGENTSTACK_WARDROBE_URL}/.well-known/agent-card.json")"
printf '%s\n' "$UNAUTHENTICATED_STATUS" >"${EVIDENCE_ROOT}/agentstack-unauthenticated-status.txt"
if [[ "$UNAUTHENTICATED_STATUS" == 401 || "$UNAUTHENTICATED_STATUS" == 403 ]]; then
  export AGENTSTACK_AUTH_REQUIRED=1
else
  export AGENTSTACK_AUTH_REQUIRED=0
fi

"$AGENTPACK_NODE_HOME/bin/pnpm" test:remote:agentstack 2>&1 | tee "${EVIDENCE_ROOT}/test-agentstack-real.log"
git status --porcelain=v1 >"${EVIDENCE_ROOT}/source-status-after.txt"

printf 'AgentPack PoC evidence: %s\n' "$EVIDENCE_ROOT"
