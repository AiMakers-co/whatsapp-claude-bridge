#!/usr/bin/env bash
#
# Remove the whatsapp-claude-bridge launchd service.
# Usage:  npm run uninstall-service
#
set -euo pipefail

LABEL="co.aimakers.whatsapp-claude-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "✅ Stopped and removed: $LABEL"
echo "   (Your WhatsApp link in auth/ is untouched — reinstall any time.)"
