#!/usr/bin/env bash
#
# Install whatsapp-claude-bridge as a launchd service (macOS) so it starts on
# login, runs in the background, and restarts itself if it crashes.
#
# Usage:  npm run install-service
#         (re-run any time to update paths / reload)
#
set -euo pipefail

LABEL="co.aimakers.whatsapp-claude-bridge"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer is for macOS (launchd). For Linux, see CLAUDE.md (systemd)." >&2
  exit 1
fi

NODE="$(command -v node || true)"
TSX="$REPO/node_modules/.bin/tsx"
[[ -x "$NODE" ]] || { echo "node not found on PATH. Install Node >=20 first." >&2; exit 1; }
[[ -f "$TSX"  ]] || { echo "Dependencies missing. Run 'npm install' in $REPO first." >&2; exit 1; }

# PATH the service runs with: node's dir + claude's dir + system dirs, so the
# bridge can spawn the `claude` CLI.
NODE_DIR="$(dirname "$NODE")"
CLAUDE_BIN="$(command -v claude || true)"
CLAUDE_DIR="$([[ -n "$CLAUDE_BIN" ]] && dirname "$CLAUDE_BIN" || echo "$HOME/.local/bin")"
SVC_PATH="$NODE_DIR:$CLAUDE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$REPO/logs" "$HOME/Library/LaunchAgents"

# Stop any instance already running (manual `npm start` or a previous service)
# so we never have two connections fighting over the same WhatsApp session.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -f "tsx src/index.ts" 2>/dev/null || true

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$TSX</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$SVC_PATH</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$REPO/logs/service.log</string>
  <key>StandardErrorPath</key>
  <string>$REPO/logs/service.log</string>
</dict>
</plist>
PLISTEOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true

echo "✅ Installed and started: $LABEL"
echo "   Plist:  $PLIST"
echo "   Logs:   $REPO/logs/service.log  (app log: $REPO/logs/bridge.log)"
echo
echo "It now runs in the background and on every login."
echo "Status:    launchctl print gui/$(id -u)/$LABEL | grep state"
echo "Stop:      npm run uninstall-service"
