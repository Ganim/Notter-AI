# AgentTrack Architecture Spike

Standalone spike to validate Claude Code CLI + MCP integration for the
autonomous pipeline design. See
`docs/superpowers/specs/2026-04-08-autonomous-pipeline-design.md` §15.

## Setup

    cd spike
    npm install

## Scripts

- `npm run mcp-server` — run the minimal MCP server standalone (stdio)
- `npm run runner` — spawn Claude Code with the MCP server and execute the spike
- `npm run token-probe` — run each of the three CLIs with a tiny prompt and
  save output to `fixtures/` for parsing discovery

## Results

Results are documented in
`docs/superpowers/specs/2026-04-08-spike-results.md`.
