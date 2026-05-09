// src/lib/accounts/supabase-storage-adapter.ts

/**
 * Returns a `Storage`-compatible object suitable for passing to
 * `createClient(..., { auth: { storage } })`. Reads and writes are
 * transparently namespaced by the active account id resolved at every
 * call. When no account is active, gets return null and sets are no-ops.
 *
 * The Supabase client only writes a single key (typically `sb-<project>-auth-token`)
 * and reads it back during init / refresh. Because the namespace prefix is
 * resolved at call time (not at adapter construction), a session belonging
 * to account A is never mistakenly read for account B.
 */
export function createPerAccountStorage(
  getActiveAccountId: () => string | null,
): Storage {
  const namespace = (key: string): string | null => {
    const id = getActiveAccountId();
    if (!id) return null;
    return `notter:${id}:${key}`;
  };

  return {
    getItem(key: string): string | null {
      const ns = namespace(key);
      if (!ns) return null;
      return localStorage.getItem(ns);
    },
    setItem(key: string, value: string): void {
      const ns = namespace(key);
      if (!ns) return;
      localStorage.setItem(ns, value);
    },
    removeItem(key: string): void {
      const ns = namespace(key);
      if (!ns) return;
      localStorage.removeItem(ns);
    },
    // Storage interface stubs (Supabase doesn't use these but TS requires them):
    get length(): number { return 0; },
    clear(): void { /* no-op */ },
    key(_index: number): string | null { return null; },
  };
}
