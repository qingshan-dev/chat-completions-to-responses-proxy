#!/usr/bin/env bash
set -euo pipefail

restart=0
port="${PORT:-8787}"
host="${HOST:-127.0.0.1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart|-r)
      restart=1
      shift
      ;;
    --port)
      port="${2:?--port requires a value}"
      shift 2
      ;;
    --host)
      host="${2:?--host requires a value}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--restart] [--port 8787] [--host 127.0.0.1]" >&2
      exit 2
      ;;
  esac
done

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
proxy_script="$script_dir/chat-completions-to-responses-proxy.js"
request_log="$script_dir/chat-completions-to-responses-proxy.requests.jsonl"
raw_log="$script_dir/chat-completions-to-responses-proxy.upstream.jsonl"
pid_file="$script_dir/chat-proxy.pid"
stdout_log="$script_dir/chat-proxy.out.log"

upstream_responses_url="${UPSTREAM_RESPONSES_URL:-http://127.0.0.1:3000/v1/responses}"
# Fill this only if your upstream requires Authorization.
upstream_api_key=""
if [[ -z "$upstream_api_key" ]]; then
  upstream_api_key="${UPSTREAM_API_KEY:-}"
fi
local_api_key="${LOCAL_API_KEY:-}"

if [[ ! -f "$proxy_script" ]]; then
  echo "Proxy script not found: $proxy_script" >&2
  exit 1
fi

if [[ "$host" == "0.0.0.0" || "$host" == "::" ]] && [[ -z "$local_api_key" ]]; then
  echo "Refusing to listen on $host without LOCAL_API_KEY. Set local_api_key in this script or export LOCAL_API_KEY before starting." >&2
  exit 1
fi

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo "Node.js was not found in PATH." >&2
  exit 1
fi

listener_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1
  fi
}

health_json() {
  curl -fsS "http://127.0.0.1:$port/health" 2>/dev/null || true
}

existing_pid="$(listener_pid || true)"
if [[ "$restart" -eq 1 && -n "$existing_pid" ]]; then
  kill "$existing_pid" 2>/dev/null || true
  sleep 0.6
  existing_pid="$(listener_pid || true)"
fi

if [[ -n "$existing_pid" ]]; then
  printf 'status: already_running\n'
  printf 'pid: %s\n' "$existing_pid"
  printf 'health: %s\n' "$(health_json)"
  printf 'log_file: %s\n' "$request_log"
  exit 0
fi

env \
  PORT="$port" \
  HOST="$host" \
  UPSTREAM_MODE="responses" \
  UPSTREAM_RESPONSES_URL="$upstream_responses_url" \
  UPSTREAM_API_KEY="$upstream_api_key" \
  LOCAL_API_KEY="$local_api_key" \
  LOG_FILE="$request_log" \
  RAW_LOG_FILE="$raw_log" \
  "$node_bin" "$proxy_script" >"$stdout_log" 2>&1 &

proxy_pid=$!

health=""
for _ in $(seq 1 40); do
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    echo "Proxy process exited early. See $stdout_log" >&2
    exit 1
  fi

  health="$(health_json)"
  if [[ -n "$health" ]]; then
    break
  fi
  sleep 0.25
done

if [[ -z "$health" ]]; then
  echo "Proxy started, but health check did not respond. See $stdout_log" >&2
  exit 1
fi

printf '%s\n' "$proxy_pid" > "$pid_file"
printf 'status: started\n'
printf 'pid: %s\n' "$proxy_pid"
printf 'health: %s\n' "$health"
printf 'upstream_responses_url: %s\n' "$upstream_responses_url"
printf 'log_file: %s\n' "$request_log"
printf 'raw_log_file: %s\n' "$raw_log"
printf 'pid_file: %s\n' "$pid_file"
printf 'stdout_log: %s\n' "$stdout_log"
