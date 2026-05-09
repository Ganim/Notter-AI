// src/lib/synced-store.ts
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth-store';
import type { RealtimeChannel } from '@supabase/supabase-js';

/**
 * Upsert rows into a per-user table keyed by (user_id, id). Replaces the
 * destructive delete-then-insert pattern that previously created a window
 * where a concurrent reader could observe an empty table.
 */
export async function upsertUserRows<TLocal, TRow extends { id: string; user_id: string }>(
  table: string,
  userId: string,
  rows: TLocal[],
  toRow: (r: TLocal) => TRow,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  if (rows.length === 0) return;
  try {
    const mapped = rows.map(toRow);
    const { error } = await supabase
      .from(table)
      .upsert(mapped, { onConflict: 'user_id,id' });
    if (error) console.error(`[synced-store] upsert ${table} failed:`, error);
    // Note: explicit `userId` arg is used by the call site to construct toRow.
    void userId;
  } catch (e) {
    console.error(`[synced-store] upsert ${table} threw:`, e);
  }
}

/**
 * Explicit single-row delete. Required because upsertUserRows no longer
 * deletes server rows that disappeared locally — every store's local-delete
 * reducer must call this to propagate the deletion.
 */
export async function deleteUserRow(table: string, userId: string, id: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq('user_id', userId)
      .eq('id', id);
    if (error) console.error(`[synced-store] delete ${table}:${id} failed:`, error);
  } catch (e) {
    console.error(`[synced-store] delete ${table}:${id} threw:`, e);
  }
}

/**
 * Subscribe to postgres_changes for a per-user table. The supplied
 * `refetchAndApply` is called with no arguments on every change event;
 * implementations re-fetch the full row set and apply it to the matching
 * Zustand store.
 */
export function subscribeUserTable(
  channel: RealtimeChannel,
  table: string,
  userId: string,
  refetchAndApply: () => Promise<void>,
): RealtimeChannel {
  return channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table, filter: `user_id=eq.${userId}` },
    () => {
      refetchAndApply().catch((e) =>
        console.error(`[synced-store] refetch ${table} failed:`, e),
      );
    },
  );
}

/**
 * Debounced "schedule -> push" with a `flush()` for window-close handlers.
 * The callback receives the current active user id at fire time, not at
 * schedule time, so a payload scheduled before account-switch fires under
 * the new user (or no-ops if no user is active).
 */
export function makeDebouncedSync<T>(
  pushFn: (userId: string, payload: T) => Promise<void>,
  ms: number,
): { schedule(payload: T): void; flush(): Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | null = null;
  let hasPending = false;

  const fire = async () => {
    timer = null;
    if (!hasPending) return;
    const payload = pending as T;
    pending = null;
    hasPending = false;
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;
    try {
      await pushFn(userId, payload);
    } catch (e) {
      console.error('[synced-store] debounced push failed:', e);
    }
  };

  return {
    schedule(payload: T) {
      pending = payload;
      hasPending = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void fire(); }, ms);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await fire();
    },
  };
}

/**
 * Run an async fn at most once per key. The flag flips AFTER successful
 * resolution, so a failed init can be retried by calling runOnce again with
 * the same key.
 */
const onceFlags = new Map<string, Promise<void>>();
export async function runOnce(key: string, fn: () => Promise<void>): Promise<void> {
  const existing = onceFlags.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      await fn();
    } catch (e) {
      onceFlags.delete(key); // allow retry
      throw e;
    }
  })();
  onceFlags.set(key, p);
  return p;
}

/**
 * Test-only: reset the runOnce key registry between tests.
 */
export function _resetRunOnceForTests(): void {
  onceFlags.clear();
}
