#!/usr/bin/env bash
#
# One-command setup: checks prerequisites, installs deps, creates .env, and
# starts the bridge so the pairing QR opens. After you scan it, optionally run
# `npm run install-service` to keep it running 24/7.
#
# Usage:  npm run setup
#
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

echo "▸ Checking Node…"
if ! node -e 'process.exit(parseInt(process.versions.node,10) >= 20 ? 0 : 1)' 2>/dev/null; then
  echo "  ✗ Need Node >= 20 (have: $(node -v 2>/dev/null || echo 'none')). Install it and re-run." >&2
  exit 1
fi
echo "  ✓ $(node -v)"

echo "▸ Checking Claude Code CLI…"
if command -v claude >/dev/null 2>&1; then
  echo "  ✓ claude found ($(claude --version 2>/dev/null | head -1))"
else
  echo "  ⚠ 'claude' CLI not on PATH. The bridge runs tasks by calling it, so install"
  echo "    Claude Code and run 'claude' once to log in — otherwise every task will fail."
fi

echo "▸ Installing dependencies…"
[ -d node_modules ] && [ -x node_modules/.bin/tsx ] || npm install

if [ ! -f .env ]; then
  cp .env.example .env
  echo "▸ Created .env — edit WORKDIR to the project you want Claude to work on."
  echo "  (Left unset, it operates on this bridge folder itself.)"
fi

echo
echo "▸ Starting the bridge. A QR image will open — scan it with:"
echo "    WhatsApp → Settings → Linked Devices → Link a Device"
echo "  Then, to run it forever:  npm run install-service"
echo
exec npm start
