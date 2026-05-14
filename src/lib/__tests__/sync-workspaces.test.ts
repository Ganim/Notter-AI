// src/lib/__tests__/sync-workspaces.test.ts
//
// Plan 1, Task 8 — verifies createWorkspaceWithOwner and fetchWorkspaces (the
// RPC variant — get_my_workspaces) round-trip the expected shape.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

// Short-circuit the auth-store import chain — its real module pulls in
// app-store → window.matchMedia, which jsdom doesn't implement. The sync
// helpers under test don't touch the auth store directly; this mock just
// prevents the transitive load from blowing up (mirrors synced-store.test.ts).
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'u1' } }),
  },
}));

beforeEach(() => {
  rpcMock.mockReset();
});

describe('createWorkspaceWithOwner', () => {
  it('returns ok:true on success', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { createWorkspaceWithOwner } = await import('@/lib/sync');
    const result = await createWorkspaceWithOwner({
      id: 'w1', userId: 'u1', name: 'My workspace', isDefault: false,
    });
    expect(result).toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledWith('create_workspace_with_owner', {
      ws_id: 'w1', ws_name: 'My workspace', ws_is_default: false,
    });
  });

  it('returns duplicate_name on Postgres 23505', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate' } });
    const { createWorkspaceWithOwner } = await import('@/lib/sync');
    const result = await createWorkspaceWithOwner({
      id: 'w1', userId: 'u1', name: 'dup', isDefault: false,
    });
    expect(result).toEqual({ ok: false, code: 'duplicate_name', message: 'duplicate' });
  });

  it('returns not_authenticated on Postgres 42501', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'not_authenticated' } });
    const { createWorkspaceWithOwner } = await import('@/lib/sync');
    const result = await createWorkspaceWithOwner({
      id: 'w1', userId: 'u1', name: 'x', isDefault: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_authenticated');
  });
});

describe('fetchWorkspaces RPC shape', () => {
  it('maps my_role / member_count into the WorkspaceRecord', async () => {
    rpcMock.mockResolvedValue({
      data: [{
        id: 'w1', user_id: 'u1', name: 'w', is_default: true,
        created_at: '2026-05-14T00:00:00Z', updated_at: '2026-05-14T00:00:00Z',
        my_role: 'owner',
        member_count: 1,
      }],
      error: null,
    });
    const { fetchWorkspaces } = await import('@/lib/sync');
    const rows = await fetchWorkspaces('u1');
    expect(rpcMock).toHaveBeenCalledWith('get_my_workspaces');
    expect(rows).toHaveLength(1);
    expect(rows![0].currentRole).toBe('owner');
    expect(rows![0].memberCount).toBe(1);
  });

  it('coerces member_count (bigint → number)', async () => {
    // pg bigint returns as string in some setups; the wrapper must coerce.
    rpcMock.mockResolvedValue({
      data: [{
        id: 'w1', user_id: 'u1', name: 'w', is_default: false,
        created_at: '2026-05-14T00:00:00Z', updated_at: '2026-05-14T00:00:00Z',
        my_role: 'editor',
        member_count: '4',
      }],
      error: null,
    });
    const { fetchWorkspaces } = await import('@/lib/sync');
    const rows = await fetchWorkspaces('u1');
    expect(rows![0].memberCount).toBe(4);
    expect(rows![0].currentRole).toBe('editor');
  });

  it('returns null on Supabase error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { fetchWorkspaces } = await import('@/lib/sync');
    const rows = await fetchWorkspaces('u1');
    expect(rows).toBeNull();
  });

  it('returns empty array when caller is in zero workspaces', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const { fetchWorkspaces } = await import('@/lib/sync');
    const rows = await fetchWorkspaces('u1');
    expect(rows).toEqual([]);
  });
});
