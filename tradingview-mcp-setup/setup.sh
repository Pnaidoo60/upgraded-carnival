#!/usr/bin/env bash
# Set up the tradingview-mcp server as a separate project and register it
# with Claude Code. Safe to re-run; does not modify anything in this repo.
set -euo pipefail

CLONE_DIR="${TV_MCP_DIR:-$HOME/tradingview-mcp}"
MCP_CONFIG="$HOME/.claude/.mcp.json"

echo "==> Cloning tradingview-mcp to $CLONE_DIR"
if [ -d "$CLONE_DIR/.git" ]; then
  git -C "$CLONE_DIR" pull --ff-only
else
  git clone https://github.com/tradesdontlie/tradingview-mcp.git "$CLONE_DIR"
fi

echo "==> Installing dependencies"
(cd "$CLONE_DIR" && npm install)

echo "==> Registering MCP server in $MCP_CONFIG"
mkdir -p "$(dirname "$MCP_CONFIG")"
node - "$MCP_CONFIG" "$CLONE_DIR" <<'EOF'
const fs = require('fs');
const [configPath, cloneDir] = process.argv.slice(2);
let config = {};
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}
config.mcpServers = config.mcpServers || {};
config.mcpServers.tradingview = {
  command: 'node',
  args: [`${cloneDir}/src/server.js`],
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
console.log(`    tradingview -> ${cloneDir}/src/server.js`);
EOF

echo "==> Done. Next steps:"
echo "    1. Launch TradingView Desktop with the debug port:"
case "$(uname -s)" in
  Darwin) echo "       $CLONE_DIR/scripts/launch_tv_debug_mac.sh" ;;
  Linux)  echo "       $CLONE_DIR/scripts/launch_tv_debug_linux.sh" ;;
  *)      echo "       $CLONE_DIR/scripts/launch_tv_debug.bat" ;;
esac
echo "    2. Restart Claude Code, then ask it to run tv_health_check."
