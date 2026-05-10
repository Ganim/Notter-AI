// src/lib/workspaces/mcp-token.ts
//
// 32 random bytes → base64url, prefixed `notter_ws_` to distinguish from the
// M1-era `notter_acc_` tokens at a glance in MCP configs. The same crypto
// routine as `generateMcpToken` in account-manager.ts — extracted so both
// managers share a single source of truth.

export function generateWorkspaceMcpToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `notter_ws_${b64}`;
}
