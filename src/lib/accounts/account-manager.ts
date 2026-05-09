// src/lib/accounts/account-manager.ts
import { readAccountIndex, writeAccountIndex, readActiveAccount, writeActiveAccount } from './account-storage';
import { secureSet, secureDelete, secureRegisterKnownKeys, accountKeys } from './secure-store';
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
  }

  /**
   * Updates the active-pointer file and the in-memory state. Does NOT touch
   * Supabase, stores, or realtime — those steps live in switchAccount() and
   * are added in Phase H once Phase F (resets) is in place.
   */
  async setActiveAccountId(id: string | null): Promise<void> {
    this.active = id;
    await writeActiveAccount({ accountId: id });
  }
}

// Singleton accessor — created lazily on first access; bootstrap is awaited
// from App.tsx before any auth / store work.
let _singleton: AccountManager | null = null;
export function getAccountManager(): AccountManager {
  if (!_singleton) _singleton = new AccountManager();
  return _singleton;
}
