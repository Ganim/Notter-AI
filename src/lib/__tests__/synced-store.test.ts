// src/lib/__tests__/synced-store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  upsertUserRows,
  deleteUserRow,
  makeDebouncedSync,
  runOnce,
  // subscribeUserTable is exercised via realtime tests later
} from '@/lib/synced-store';

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'test-user-id' } }),
  },
}));

vi.mock('@/lib/supabase', () => {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const eqTerminal = vi.fn().mockResolvedValue({ error: null });
  const eqFirst = vi.fn().mockReturnValue({ eq: eqTerminal });
  const del = vi.fn().mockReturnValue({ eq: eqFirst });
  const from = vi.fn(() => ({ upsert, delete: del }));
  return {
    supabase: { from },
    isSupabaseConfigured: true,
  };
});

describe('upsertUserRows', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts rows keyed by (user_id, id) — never destructively deletes', async () => {
    const { supabase } = await import('@/lib/supabase');
    type Local = { id: string; name: string };
    type Row = { id: string; user_id: string; name: string };
    const toRow = (r: Local): Row => ({ id: r.id, user_id: 'u1', name: r.name });

    await upsertUserRows<Local, Row>('agent_profiles', 'u1', [{ id: 'p1', name: 'A' }], toRow);

    expect(supabase.from).toHaveBeenCalledWith('agent_profiles');
    const fromMock = (supabase.from as any).mock.results[0].value;
    expect(fromMock.upsert).toHaveBeenCalledWith(
      [{ id: 'p1', user_id: 'u1', name: 'A' }],
      { onConflict: 'user_id,id' },
    );
    expect(fromMock.delete).not.toHaveBeenCalled();
  });

  it('no-ops on empty rows', async () => {
    const { supabase } = await import('@/lib/supabase');
    await upsertUserRows('actions', 'u1', [], (x) => x);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe('deleteUserRow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes a single row scoped by user_id and id', async () => {
    const { supabase } = await import('@/lib/supabase');
    await deleteUserRow('actions', 'u1', 'a1');
    expect(supabase.from).toHaveBeenCalledWith('actions');
    const fromMock = (supabase.from as any).mock.results[0].value;
    expect(fromMock.delete).toHaveBeenCalled();
    const delResult = (fromMock.delete as any).mock.results[0].value;
    expect(delResult.eq).toHaveBeenCalledWith('user_id', 'u1');
    const firstEqResult = (delResult.eq as any).mock.results[0].value;
    expect(firstEqResult.eq).toHaveBeenCalledWith('id', 'a1');
  });
});

describe('makeDebouncedSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('coalesces rapid schedule() calls into one push after the delay', async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const sync = makeDebouncedSync<{ count: number }>((_uid, p) => push(p), 100);
    // active-user lookup is mocked separately in the implementation; for now
    // the helper should accept an explicit (userId, payload) push signature.
    sync.schedule({ count: 1 });
    sync.schedule({ count: 2 });
    sync.schedule({ count: 3 });
    expect(push).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ count: 3 });
  });

  it('flush() forces immediate push and clears the timer', async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const sync = makeDebouncedSync<number>((_uid, n) => push(n), 1000);
    sync.schedule(42);
    await sync.flush();
    expect(push).toHaveBeenCalledWith(42);
    await vi.advanceTimersByTimeAsync(1000);
    expect(push).toHaveBeenCalledTimes(1); // not double-fired
  });

  it('flush() with no pending payload is a no-op', async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const sync = makeDebouncedSync<number>((_uid, n) => push(n), 1000);
    await sync.flush();
    expect(push).not.toHaveBeenCalled();
  });

  it('flush() during an in-flight fire does not double-submit', async () => {
    let resolvePush: (() => void) | null = null as (() => void) | null;
    const push = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolvePush = resolve; }),
    );
    const sync = makeDebouncedSync<number>((_uid, n) => push(n), 100);
    sync.schedule(1);
    await vi.advanceTimersByTimeAsync(100); // timer fires; push is in-flight
    expect(push).toHaveBeenCalledTimes(1);
    // flush() while push is still pending — must NOT enqueue a second call
    const flushPromise = sync.flush();
    resolvePush?.();
    await flushPromise;
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe('runOnce', () => {
  it('runs the function only once per key on success', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    await runOnce('boot:test1', fn);
    await runOnce('boot:test1', fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('allows retry after a failed attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    await expect(runOnce('boot:test2', fn)).rejects.toThrow('boom');
    await runOnce('boot:test2', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
