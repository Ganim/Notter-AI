# MCP providers — manual install checklist (2026-05-14)

For each OS × provider, sign into Notter, open Settings → MCP, click "Conectar"
on the provider, verify the entry shows up where expected, and that the client
can actually call a Notter tool.

## Windows

- [ ] Claude Code CLI — entry visible in `claude mcp list`; `claude mcp call notter-<slug>.list_workspaces` returns rows
- [ ] Claude Desktop — entry visible in `%APPDATA%\Claude\claude_desktop_config.json`; after restarting Claude Desktop, calling a tool via Claude UI works
- [ ] Codex CLI — entry visible in `%USERPROFILE%\.codex\config.toml`
- [ ] Cursor — entry visible in `%USERPROFILE%\.cursor\mcp.json`; Cursor side panel "MCP" lists Notter

## macOS

- [ ] Claude Code CLI — `claude mcp list` shows entry
- [ ] Claude Desktop — entry in `~/Library/Application Support/Claude/claude_desktop_config.json`
- [ ] Codex CLI — entry in `~/.codex/config.toml`
- [ ] Cursor — entry in `~/.cursor/mcp.json`

## Linux

- [ ] Claude Code CLI — entry in `claude mcp list`
- [ ] Claude Desktop — entry in `~/.config/Claude/claude_desktop_config.json`
- [ ] Codex CLI — entry in `~/.codex/config.toml`
- [ ] Cursor — entry in `~/.cursor/mcp.json`

## Disconnect

For each row above: click "Desconectar"; verify the entry is removed from the file (or `claude mcp list` no longer shows it).
