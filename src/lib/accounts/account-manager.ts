// src/lib/accounts/account-manager.ts
import { readAccountIndex, writeAccountIndex, readActiveAccount, writeActiveAccount } from './account-storage';
import { secureSet, secureDelete, secureGet, secureRegisterKnownKeys, accountKeys } from './secure-store';
import { supabase, isSupabaseConfigured, _bindAccountManager } from '@/lib/supabase';
import { resetAllStores } from '@/lib/accounts/store-registry';
import { startRealtimeSync, stopRealtimeSync } from '@/lib/realtime';
import type { AccountSummary } from './types';

export interface AddAccountInput {
  id: string;
  email: string;
  displayName: string | null;
  refreshToken: string;
}

function generateMcpToken(): string {
  // 32 bytes → base64url, prefixed for human recognition.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `notter_acc_${b64}`;
}

export class AccountManager {
  private accounts: AccountSummary[] = [];
  private active: string | null = null;
  private booted = false;
  private listeners = new Set<() => void>();

  /** Subscribe to mutations (add/remove/setActive/switch). Returns an
   *  unsubscribe fn. AccountSwitcher uses this to re-render when sign-in
   *  registers a new account on a user.id transition that has already fired. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const l of this.listeners) {
      try { l(); } catch (e) { console.error('[account-manager] listener failed', e); }
    }
  }

  get activeAccountId(): string | null {
    return this.active;
  }

  list(): AccountSummary[] {
    return [...this.accounts];
  }

  get(id: string): AccountSummary | null {
    return this.accounts.find((a) => a.id === id) ?? null;
  }

  async bootstrap(): Promise<void> {
    if (this.booted) return;
    const idx = await readAccountIndex();
    const active = await readActiveAccount();
    this.accounts = idx.accounts;
    this.active = active.accountId;

    // Repopulate the Rust-side known-key index so secure_register_known_keys
    // returns sane results during this run.
    const keys: string[] = [];
    for (const a of this.accounts) {
      keys.push(accountKeys.refreshToken(a.id), accountKeys.mcpToken(a.id));
    }
    if (keys.length > 0) await secureRegisterKnownKeys(keys);

    // Wire the supabase storage adapter's lazy account-id getter. This MUST
    // happen before any supabase auth call (initialize/getSession), which is
    // why bootstrap() is awaited in App.tsx before initialize() runs.
    _bindAccountManager(() => this.active);

    this.booted = true;
  }

  async add(input: AddAccountInput): Promise<AccountSummary> {
    if (this.accounts.some((a) => a.id === input.id)) {
      throw new Error(`Account ${input.id} already added`);
    }
    await secureSet(accountKeys.refreshToken(input.id), input.refreshToken);
    await secureSet(accountKeys.mcpToken(input.id), generateMcpToken());

    const summary: AccountSummary = {
      id: input.id,
      email: input.email,
      displayName: input.displayName,
      addedAt: new Date().toISOString(),
    };
    this.accounts.push(summary);
    await writeAccountIndex({ accounts: this.accounts });
    this.notify();
    return summary;
  }

  async remove(id: string): Promise<void> {
    if (this.active === id) {
      throw new Error('Cannot remove the active account; switch to another account first.');
    }
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id !== id);
    if (this.accounts.length === before) return; // no-op
    await secureDelete(accountKeys.refreshToken(id));
    await secureDelete(accountKeys.mcpToken(id));
    await writeAccountIndex({ accounts: this.accounts });
    this.notify();
  }

  async switchAccount(targetId: string): Promise<void> {
    if (!isSupabaseConfigured) throw new Error('Supabase not configured');
    if (!this.accounts.some((a) => a.id === targetId)) {
      throw new Error(`Unknown account ${targetId}`);
    }
    if (this.active === targetId) return; // no-op

    // 1. Validate — read refresh token
    const refreshToken = await secureGet(accountKeys.refreshToken(targetId));
    if (!refreshToken) {
      throw new Error('session expired, please re-login this account');
    }

    // 2. Acquire — set the new session.
    const previousActive = this.active;
    this.active = targetId;
    const { data, error } = await supabase.auth.setSession({
      access_token: '',
      refresh_token: refreshToken,
    });
    if (error || !data.session) {
      this.active = previousActive;
      throw new Error(error?.message ?? 'setSession failed');
    }

    // 3. Commit — only after setSession succeeds.
    stopRealtimeSync();
    resetAllStores();
    const { syncOnLogin } = await import('@/stores/auth-store');
    await syncOnLogin(targetId);
    startRealtimeSync(targetId);

    // 4. Update active pointer LAST — canonical "switch happened" marker.
    await writeActiveAccount({ accountId: targetId });
    this.notify();
  }

  /**
   * Updates the active-pointer file and the in-memory state. Does NOT touch
   * Supabase, stores, or realtime — those steps live in switchAccount() and
   * are added in Phase H once Phase F (resets) is in place.
   */
  async setActiveAccountId(id: string | null): Promise<void> {
    this.active = id;
    await writeActiveAccount({ accountId: id });
    this.notify();
  }
}

// Singleton accessor — created lazily on first access; bootstrap is awaited
// from App.tsx before any auth / store work.
let _singleton: AccountManager | null = null;
export function getAccountManager(): AccountManager {
  if (!_singleton) _singleton = new AccountManager();
  return _singleton;
}
