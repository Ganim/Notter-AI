// src/lib/workspaces/__tests__/workspace-manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/workspaces/workspace-storage', () => ({
  readWorkspaceIndex: vi.fn().mockResolvedValue({ workspaces: [] }),
  writeWorkspaceIndex: vi.fn().mockResolvedValue(undefined),
  readActiveWorkspace: vi.fn().mockResolvedValue({ workspaceId: null }),
  writeActiveWorkspace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/accounts/account-manager', () => ({
  getAccountManager: () => ({ activeAccountId: 'acc-1' }),
}));

vi.mock('@/lib/sync', () => ({
  fetchWorkspaces: vi.fn().mockResolvedValue([]),
  pushWorkspace: vi.fn().mockResolvedValue({ ok: true }),
  renameWorkspace: vi.fn().mockResolvedValue({ ok: true }),
  setWorkspaceDefault: vi.fn().mockResolvedValue(undefined),
  deleteWorkspace: vi.fn().mockResolvedValue({ ok: true }),
  moveProjectsBetweenWorkspaces: vi.fn().mockResolvedValue({ ok: true, movedCount: 0 }),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u1' } }) },
}));

// usePlannerStore is consumed by workspace-manager.remove() (move path) to
// optimistically reflect bulk project moves. Mock so the real module — which
// imports the full @/lib/sync surface beyond our partial mock — never loads.
vi.mock('@/stores/planner-store', () => ({
  usePlannerStore: {
    getState: () => ({
      allProjects: [] as { name: string; workspaceId: string }[],
      applyRemoteProjects: vi.fn(),
    }),
  },
}));

// useWorkspacesStore is consumed by workspace-manager's syncStoreFromRemote
// after every mutation. Mock to avoid loading the real store + its zustand setup.
vi.mock('@/stores/workspaces-store', () => ({
  useWorkspacesStore: {
    getState: () => ({
      applyRemoteWorkspaces: vi.fn(),
      setCurrentWorkspaceId: vi.fn(),
    }),
  },
}));

import { getWorkspaceManager, _resetForTests } from '../workspace-manager';
import * as sync from '@/lib/sync';

describe('workspace-manager', () => {
  beforeEach(() => {
    _resetForTests();
    vi.clearAllMocks();
  });

  it('bootstrap creates a default workspace lazily when none exist server-side', async () => {
    (sync.fetchWorkspaces as any).mockResolvedValueOnce([]);
    const mgr = getWorkspaceManager();
    await mgr.bootstrap();
    expect(sync.pushWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "User's workspace", isDefault: true, userId: 'u1' }),
    );
    expect(mgr.list().length).toBe(1);
    expect(mgr.currentWorkspaceId).not.toBeNull();
  });

  it('bootstrap seeds currentWorkspaceId from is_default=true row', async () => {
    (sync.fetchWorkspaces as any).mockResolvedValueOnce([
      { id: 'w1', userId: 'u1', name: 'A', isDefault: false, createdAt: '', updatedAt: '' },
      { id: 'w2', userId: 'u1', name: 'B', isDefault: true,  createdAt: '', updatedAt: '' },
    ]);
    const mgr = getWorkspaceManager();
    await mgr.bootstrap();
    expect(mgr.currentWorkspaceId).toBe('w2');
  });

  it('switchWorkspace updates the active pointer and notifies listeners', async () => {
    (sync.fetchWorkspaces as any).mockResolvedValueOnce([
      { id: 'w1', userId: 'u1', name: 'A', isDefault: true,  createdAt: '', updatedAt: '' },
      { id: 'w2', userId: 'u1', name: 'B', isDefault: false, createdAt: '', updatedAt: '' },
    ]);
    const mgr = getWorkspaceManager();
    await mgr.bootstrap();
    const sub = vi.fn();
    mgr.subscribe(sub);
    await mgr.switchWorkspace('w2');
    expect(mgr.currentWorkspaceId).toBe('w2');
    expect(sub).toHaveBeenCalled();
  });

  it('add creates the row and persists the index', async () => {
    (sync.fetchWorkspaces as any).mockResolvedValueOnce([]);
    const mgr = getWorkspaceManager();
    await mgr.bootstrap();
    const before = mgr.list().length;
    await mgr.add({ name: 'Work' });
    expect(sync.pushWorkspace).toHaveBeenCalled();
    expect(mgr.list().length).toBe(before + 1);
  });

  it('remove with purge:true deletes the workspace row and notifies Rust', async () => {
    (sync.fetchWorkspaces as any).mockResolvedValueOnce([
      { id: 'w1', userId: 'u1', name: 'A', isDefault: true,  createdAt: '', updatedAt: '' },
      { id: 'w2', userId: 'u1', name: 'B', isDefault: false, createdAt: '', updatedAt: '' },
    ]);
    const mgr = getWorkspaceManager();
    await mgr.bootstrap();
    await mgr.remove('w2', { purge: true });
    expect(sync.deleteWorkspace).toHaveBeenCalledWith('w2', 'u1');
  });

  it('remove with moveTargetWorkspaceId moves projects first, then deletes', async () => {
    (sync.fetchWorkspaces as any).mockResolvedValueOnce([
      { id: 'w1', userId: 'u1', name: 'A', isDefault: true,  createdAt: '', updatedAt: '' },
      { id: 'w2', userId: 'u1', name: 'B', isDefault: false, createdAt: '', updatedAt: '' },
    ]);
    const mgr = getWorkspaceManager();
    await mgr.bootstrap();
    await mgr.remove('w2', { moveTargetWorkspaceId: 'w1' });
    expect(sync.moveProjectsBetweenWorkspaces).toHaveBeenCalledWith('u1', 'w2', 'w1');
    expect(sync.deleteWorkspace).toHaveBeenCalledWith('w2', 'u1');
  });
});
