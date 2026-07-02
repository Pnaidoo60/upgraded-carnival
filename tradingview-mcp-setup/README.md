# TradingView MCP Server Setup

Standalone setup for the [tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp)
bridge, which connects Claude Code to a locally running TradingView Desktop app via
Chrome DevTools Protocol (CDP). This lives alongside the rest of this repo as a
separate project — nothing here touches the existing applications.

> **Requires:** TradingView Desktop app (paid subscription for real-time data),
> Node.js 18+, and Claude Code with MCP support.

## Quick setup

Run the included script (clones outside this repo, installs deps, writes MCP config):

```bash
./tradingview-mcp-setup/setup.sh
```

Or do it manually:

### 1. Clone and install (as its own project, outside this repo)

```bash
git clone https://github.com/tradesdontlie/tradingview-mcp.git ~/tradingview-mcp
cd ~/tradingview-mcp
npm install
```

### 2. Add to Claude Code MCP config

Merge `mcp.json.example` into `~/.claude/.mcp.json`, replacing the path with the
actual clone location:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/absolute/path/to/tradingview-mcp/src/server.js"]
    }
  }
}
```

### 3. Launch TradingView with the debug port

TradingView Desktop must run with CDP enabled on port 9222:

```bash
# Mac
~/tradingview-mcp/scripts/launch_tv_debug_mac.sh
# Windows
~/tradingview-mcp/scripts/launch_tv_debug.bat
# Linux
~/tradingview-mcp/scripts/launch_tv_debug_linux.sh
# Or manually, any platform:
/path/to/TradingView --remote-debugging-port=9222
```

### 4. Verify

Ask Claude Code: *"Use tv_health_check to verify TradingView is connected."*
Expected result with the Desktop app running and a chart open:

```json
{
  "success": true,
  "cdp_connected": true,
  "api_available": true,
  "chart_symbol": "<your symbol>",
  "chart_resolution": "<your timeframe>"
}
```

`api_available: false` means CDP is reachable but the target is not the logged-in
Desktop app (e.g. the anonymous web page) or the chart hasn't finished loading.

## Verified

Setup was exercised end-to-end in a cloud session on 2026-07-02:

- `npm install` — clean, 2 runtime dependencies
- MCP server starts over stdio and registers **78 tools** (server `tradingview` v2.0.0)
- `tv_health_check` against a CDP target on port 9222 returned
  `success: true, cdp_connected: true`

The Desktop app itself can't run in a cloud container, so `api_available: true`
must be confirmed on a machine with TradingView Desktop installed and logged in.
