// src/lib/mcp/index.ts
import { invoke } from '@tauri-apps/api/core';

/**
 * Notify the Rust MCP server that an account's Supabase access token has
 * rotated. Front-end is the SOLE Supabase refresh owner per spec §6.2; the
 * Rust server is a passive consumer of these pushes. Access tokens stay
 * per-account — they're tied to the Supabase user session, not to a
 * particular workspace.
 */
export async function notifyMcpAccountTokenChanged(
  accountId: string,
  accessToken: string,
  expiresAt: number, // unix seconds
): Promise<void> {
  try {
    await invoke('mcp_update_account_token', {
      args: { accountId, accessToken, expiresAt },
    });
  } catch (e) {
    // Non-fatal — the MCP server may be disabled (bind failed).
    console.warn('[mcp] notifyMcpAccountTokenChanged failed:', e);
  }
}

/**
 * Notify the Rust MCP server that an account has been removed (or signed out).
 * Drops the per-account access-token slice AND every bearer mapping (across
 * all workspaces) belonging to that account. Still called from
 * AccountManager.remove and from signOut.
 */
export async function notifyMcpAccountRemoved(accountId: string): Promise<void> {
  try {
    await invoke('mcp_remove_account_token', { accountId });
  } catch (e) {
    console.warn('[mcp] notifyMcpAccountRemoved failed:', e);
  }
}

/**
 * Push Supabase URL + anon key to the Rust MCP server. Called once at boot
 * from account-manager.bootstrap(). Replaces the std::env stopgap in the plan
 * — Vite's import.meta.env.VITE_* is bundled into the front-end JS and is not
 * visible to Rust, so the front-end must hand it over explicitly.
 */
export async function pushMcpSupabaseConfig(
  url: string,
  anonKey: string,
): Promise<void> {
  try {
    await invoke('mcp_set_supabase_config', { args: { url, anonKey } });
  } catch (e) {
    console.warn('[mcp] pushMcpSupabaseConfig failed:', e);
  }
}

// ─── Workspace-aware MCP bridge (Phase H) ─────────────────────────────────

/**
 * Register a per-workspace bearer token with the Rust server. Called by
 * `WorkspaceManager.bootstrap()` (once per known workspace) and by
 * `WorkspaceManager.add()` (for newly created workspaces).
 */
export async function notifyMcpWorkspaceAdded(
  accountId: string,
  workspaceId: string,
  bearerToken: string,
): Promise<void> {
  try {
    await invoke('mcp_register_bearer', {
      args: { accountId, workspaceId, bearerToken },
    });
  } catch (e) {
    console.warn('[mcp] notifyMcpWorkspaceAdded failed:', e);
  }
}

/**
 * Revoke a single bearer in the Rust map. Used by `WorkspaceManager.remove()`
 * so the deleted workspace's CLI immediately 401s.
 */
export async function notifyMcpWorkspaceRemoved(
  bearerToken: string,
): Promise<void> {
  try {
    await invoke('mcp_revoke_bearer', { args: { bearerToken } });
  } catch (e) {
    console.warn('[mcp] notifyMcpWorkspaceRemoved failed:', e);
  }
}

/**
 * Read the per-workspace stable config file at
 * `<appLocalData>/notter-ai/mcp/<accountId>-<workspaceId>-config.json`.
 * Used by the "Copy MCP config" UI in `WorkspaceManagerDialog`.
 */
export interface McpWorkspaceConfig {
  url: string;
  bearer_token: string;
  account_id: string;
  workspace_id: string;
  generated_at: string;
}

export async function readMcpConfigForWorkspace(
  accountId: string,
  workspaceId: string,
): Promise<McpWorkspaceConfig | null> {
  try {
    return await invoke<McpWorkspaceConfig>('mcp_read_workspace_config', {
      args: { accountId, workspaceId },
    });
  } catch (e) {
    console.warn('[mcp] readMcpConfigForWorkspace failed:', e);
    return null;
  }
}
