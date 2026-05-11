// src/lib/mcp/index.ts
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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
 * Notify the Rust MCP server that an account has been REMOVED from the app
 * (hard revocation). Drops both the per-account access token slice AND the
 * bearer mapping. Used by AccountManager.remove. NOT by signOut — signOut
 * uses `notifyMcpAccountSignedOut` because the bearer must survive a
 * sign-out/sign-in cycle (it represents the account identity).
 */
export async function notifyMcpAccountRemoved(accountId: string): Promise<void> {
  try {
    await invoke('mcp_remove_account_token', { accountId });
  } catch (e) {
    console.warn('[mcp] notifyMcpAccountRemoved failed:', e);
  }
}

/**
 * Notify the Rust MCP server that the active session has ended (signOut).
 * Soft clear: drops the per-account access token but keeps the bearer
 * mapping. Next sign-in re-pushes the access token via the
 * `SIGNED_IN`/`TOKEN_REFRESHED` listener, no bearer churn needed.
 */
export async function notifyMcpAccountSignedOut(accountId: string): Promise<void> {
  try {
    await invoke('mcp_clear_account_access_token', { accountId });
  } catch (e) {
    console.warn('[mcp] notifyMcpAccountSignedOut failed:', e);
  }
}

/**
 * Push Supabase URL + anon key to the Rust MCP server. Called once at boot
 * from account-manager.bootstrap(). Vite's import.meta.env.VITE_* is bundled
 * into the front-end JS and is not visible to Rust, so the front-end must hand
 * it over explicitly.
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
 * Register a per-account bearer with the Rust server. Called by
 * `AccountManager.bootstrap()` (per known account) and by `AccountManager.add()`
 * for newly-added accounts. Replaces any existing bearer for the same account.
 */
export async function notifyMcpAccountRegistered(
  accountId: string,
  bearerToken: string,
): Promise<void> {
  try {
    await invoke('mcp_register_bearer', {
      args: { accountId, bearerToken },
    });
  } catch (e) {
    console.warn('[mcp] notifyMcpAccountRegistered failed:', e);
  }
}

/**
 * Read the per-account stable config file at
 * `<appLocalData>/notter-ai/mcp/<accountId>-config.json`.
 * Used by the "Copy MCP config" UI in McpConfigDialog.
 */
export interface McpAccountConfig {
  url: string;
  bearer_token: string;
  account_id: string;
  generated_at: string;
}

export async function readMcpConfigForAccount(
  accountId: string,
): Promise<McpAccountConfig | null> {
  try {
    return await invoke<McpAccountConfig>('mcp_read_account_config', {
      args: { accountId },
    });
  } catch (e) {
    console.warn('[mcp] readMcpConfigForAccount failed:', e);
    return null;
  }
}

// ─── Reactive auth recovery ───────────────────────────────────────────────
//
// Rust emits `mcp:auth-needed` whenever a tool call hits AuthPending (the
// access_token slice is empty or expired). The listener below calls
// supabase.auth.refreshSession() to force a TOKEN_REFRESHED event, which the
// auth-store listener catches and re-pushes the access token to Rust. The
// CLI's retry then succeeds.
//
// Debounced via the inFlight flag so a burst of failing tool calls doesn't
// stack N concurrent refresh attempts.

let mcpAuthInFlight = false;
let mcpAuthUnlisten: UnlistenFn | null = null;

/**
 * Setup the `mcp:auth-needed` listener. Idempotent — safe to call multiple
 * times; only the first call attaches. Returns immediately.
 */
export async function setupMcpAuthListener(): Promise<void> {
  if (mcpAuthUnlisten) return;
  const { supabase } = await import('@/lib/supabase');
  mcpAuthUnlisten = await listen<{ accountId: string }>('mcp:auth-needed', async (event) => {
    if (mcpAuthInFlight) return;
    mcpAuthInFlight = true;
    try {
      console.info('[mcp] auth-needed for', event.payload.accountId, '— refreshing session');
      await supabase.auth.refreshSession();
      // The TOKEN_REFRESHED handler in auth-store re-pushes the access token.
    } catch (e) {
      console.error('[mcp] refreshSession failed:', e);
    } finally {
      mcpAuthInFlight = false;
    }
  });
}

/** Teardown — currently used only in tests (the listener lives for the app's lifetime). */
export function teardownMcpAuthListener(): void {
  if (mcpAuthUnlisten) {
    mcpAuthUnlisten();
    mcpAuthUnlisten = null;
  }
  mcpAuthInFlight = false;
}
