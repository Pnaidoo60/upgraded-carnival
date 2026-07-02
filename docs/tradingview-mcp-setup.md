# TradingView MCP Server — Local Setup Guide

This guide sets up the [`tradesdontlie/tradingview-mcp`](https://github.com/tradesdontlie/tradingview-mcp)
server so Claude Code can analyze your **TradingView Desktop** charts.

> **Important — must be done locally.** This MCP server is a bridge that talks to
> a running **TradingView Desktop** app on your machine over the Chrome DevTools
> Protocol (CDP). It does **not** connect to TradingView's servers, and it cannot
> run in a cloud/headless session (no GUI, no desktop app, and `~/.claude/.mcp.json`
> in a cloud container does not reach your real machine). Run every step below on
> the computer where you use TradingView Desktop and the Claude Code CLI.

## Prerequisites

- **TradingView Desktop** installed (the native app, not the web version).
- **Node.js** (LTS) and **npm**.
- **Claude Code** CLI installed and used *locally* on this same machine.

## 1. Clone and install

```bash
git clone https://github.com/tradesdontlie/tradingview-mcp.git
cd tradingview-mcp
npm install
```

## 2. Launch TradingView with the debug port

The server connects to TradingView over CDP on `localhost:9222`. Launch the desktop
app with the standard Chromium debug flag using the bundled script for your OS:

```bash
# macOS
./scripts/launch_tv_debug_mac.sh

# Linux
./scripts/launch_tv_debug_linux.sh

# Windows (from the repo root)
scripts\launch_tv_debug.bat
```

Each script just starts TradingView Desktop with `--remote-debugging-port=9222`.
Leave TradingView running.

## 3. Add the server to your MCP config

Edit `~/.claude/.mcp.json` and add the `tradingview` entry. A ready-to-copy version
lives next to this file at [`tradingview.mcp.json`](./tradingview.mcp.json).

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/full/path/to/tradingview-mcp/src/server.js"]
    }
  }
}
```

Replace `/full/path/to/tradingview-mcp` with the absolute path where you cloned the
repo (e.g. `/Users/you/code/tradingview-mcp`). If `~/.claude/.mcp.json` already
exists, merge the `tradingview` key into your existing `mcpServers` object rather
than overwriting the file.

## 4. Restart Claude Code and verify

Restart the Claude Code CLI so it picks up the new MCP server, then run the health
check tool:

```
tv_health_check
```

A successful result confirms the server reached TradingView Desktop over CDP on
`localhost:9222`. If it fails, check that:

- TradingView Desktop is actually running and was launched via the debug script.
- Nothing else is already using port `9222`.
- The path in `~/.claude/.mcp.json` points at the real `src/server.js`.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `tv_health_check` fails to connect | TradingView not launched with `--remote-debugging-port=9222`; re-run the launch script. |
| Server not listed in Claude Code | `~/.claude/.mcp.json` malformed or Claude Code not restarted. |
| `ECONNREFUSED 127.0.0.1:9222` | The debug port isn't open, or another process took port 9222. |
| Works, but no chart data | Make sure a chart/tab is actually open in TradingView Desktop. |
