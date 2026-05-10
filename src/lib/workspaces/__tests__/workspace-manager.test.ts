// src/lib/workspaces/__tests__/workspace-manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/workspaces/workspace-storage', () => ({
  readWorkspaceIndex: vi.fn().mockResolvedValue({ workspaces: [] }),
  writeWorkspaceIndex: vi.fn().mockResolvedValue(undefined),
  readActiveWorkspace: vi.fn().mockResolvedValue({ workspaceId: null }),
  writeActiveWorkspace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/accounts/secure-store', () => ({
  secureSet: vi.fn(),
  secureGet: vi.fn().mockResolvedValue(null),
  secureDelete: vi.fn(),
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

vi.mock('@/lib/mcp', () => ({
  notifyMcpWorkspaceAdded: vi.fn(),
  notifyMcpWorkspaceRemoved: vi.fn(),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u1' } }) },
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

  it('add creates the row + token, registers the bearer with Rust', async () => {
    (sync.fetchWorkspaces as any).mockResolvedValueOnce([]);
    const mgr = getWorkspaceManager();
    await mgr.bootstrap();
    const before = mgr.list().length;
    await mgr.add({ name: 'Work' });
    expect(sync.pushWorkspace).toHaveBeenCalled();
    expect(mgr.list().length).toBe(before + 1);
    const { notifyMcpWorkspaceAdded } = await import('@/lib/mcp');
    expect(notifyMcpWorkspaceAdded).toHaveBeenCalled();
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
