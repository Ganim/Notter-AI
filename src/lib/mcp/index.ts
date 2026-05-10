// src/lib/mcp/index.ts
import { invoke } from '@tauri-apps/api/core';

/**
 * Notify the Rust MCP server that an account's Supabase access token has
 * rotated. Front-end is the SOLE Supabase refresh owner per spec §6.2; the
 * Rust server is a passive consumer of these pushes.
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
 * Drops the per-account access-token slice and any active bearer mapping.
 */
export async function notifyMcpAccountRemoved(accountId: string): Promise<void> {
  try {
    await invoke('mcp_remove_account_token', { accountId });
  } catch (e) {
    console.warn('[mcp] notifyMcpAccountRemoved failed:', e);
  }
}

/**
 * Register a per-account Bearer token with the Rust server. Called from
 * AccountManager.bootstrap() and AccountManager.add() so the server knows
 * which Bearer corresponds to which account.
 */
export async function notifyMcpAccountAdded(
  accountId: string,
  bearerToken: string,
): Promise<void> {
  try {
    await invoke('mcp_register_bearer', { accountId, bearerToken });
  } catch (e) {
    console.warn('[mcp] notifyMcpAccountAdded failed:', e);
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

/**
 * Read the per-account stable config file at
 * `<appLocalData>/notter-ai/mcp/<accountId>-config.json`.
 * Used by the "Copy MCP config" UI in Phase J. The backing Tauri command
 * (`mcp_read_account_config`) is added in Phase K — until then this returns
 * null, and the UI surfaces a "MCP unavailable" state.
 */
export interface McpConfig {
  url: string;
  bearer_token: string;
  generated_at: string;
}

export async function readMcpConfigForAccount(
  accountId: string,
): Promise<McpConfig | null> {
  try {
    return await invoke<McpConfig>('mcp_read_account_config', { accountId });
  } catch (e) {
    console.warn('[mcp] readMcpConfigForAccount failed:', e);
    return null;
  }
}
