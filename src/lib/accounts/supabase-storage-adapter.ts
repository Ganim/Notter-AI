// src/lib/accounts/supabase-storage-adapter.ts

export const PENDING_NAMESPACE = '__pending__';

/**
 * Returns a `Storage`-compatible object suitable for passing to
 * `createClient(..., { auth: { storage } })`. Reads and writes are
 * transparently namespaced by the active account id resolved at every
 * call. When no account is active, falls back to a `__pending__` namespace
 * so pre-account writes (PKCE code_verifier during first sign-in) survive
 * until the account is registered. After the deep-link callback runs and
 * E3's re-`setSession` writes under the new namespace, the pending entries
 * are stale but harmless; `clearPendingStorage()` can be called to clean up.
 *
 * The Supabase client only writes a single key (typically `sb-<project>-auth-token`)
 * and reads it back during init / refresh. Because the namespace prefix is
 * resolved at call time (not at adapter construction), a session belonging
 * to account A is never mistakenly read for account B.
 */
export function createPerAccountStorage(
  getActiveAccountId: () => string | null,
): Storage {
  const namespace = (key: string): string => {
    const id = getActiveAccountId() ?? PENDING_NAMESPACE;
    return `notter:${id}:${key}`;
  };

  return {
    getItem(key: string): string | null {
      return localStorage.getItem(namespace(key));
    },
    setItem(key: string, value: string): void {
      localStorage.setItem(namespace(key), value);
    },
    removeItem(key: string): void {
      localStorage.removeItem(namespace(key));
    },
    // Storage interface stubs (Supabase doesn't use these but TS requires them):
    get length(): number { return 0; },
    clear(): void { /* no-op */ },
    key(_index: number): string | null { return null; },
  };
}

/** Removes any keys under the pending namespace. Call after a successful
 *  sign-in once the new account's session has been re-persisted. */
export function clearPendingStorage(): void {
  const prefix = `notter:${PENDING_NAMESPACE}:`;
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) toRemove.push(k);
  }
  for (const k of toRemove) localStorage.removeItem(k);
}
