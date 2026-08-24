#!/bin/bash
# Sentry AI monitoring hook for Claude Code
# Reads hook event JSON from stdin, forwards to Node collector.
#
# Supports two modes (set via config or CLAUDE_SENTRY_MODE env var):
#   batch    (default) — logs events to JSONL, processes at session end
#   realtime          — POSTs events to a local collector server

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Exit silently when node is missing or older than the SDK supports (Node 18+),
# so the hook never blocks Claude Code on a host without a usable runtime.
if ! command -v node >/dev/null 2>&1; then
  cat >/dev/null
  exit 0
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  cat >/dev/null
  exit 0
fi

# Auto-install dependencies on first run
if [ ! -d "${SCRIPT_DIR}/node_modules/@sentry/node" ]; then
  (cd "$SCRIPT_DIR" && npm install --no-fund --no-audit --silent 2>/dev/null) || true
fi

# Read hook event JSON from stdin
INPUT=$(cat)

# Forward to Node collector (it handles config loading, DSN check, everything)
echo "$INPUT" | node "$SCRIPT_DIR/collector.js" 2>/dev/null || true
