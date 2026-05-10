// src/stores/__tests__/workspaces-store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/accounts/store-registry', () => ({
  registerResettableStore: vi.fn(),
}));

import { useWorkspacesStore } from '@/stores/workspaces-store';

describe('useWorkspacesStore', () => {
  beforeEach(() => {
    useWorkspacesStore.getState().reset();
  });

  it('starts empty', () => {
    const { workspaces, currentWorkspaceId, loading } = useWorkspacesStore.getState();
    expect(workspaces).toEqual([]);
    expect(currentWorkspaceId).toBeNull();
    expect(loading).toBe(false);
  });

  it('applyRemoteWorkspaces replaces the slice', () => {
    const rows = [
      { id: 'w1', userId: 'u1', name: 'A', isDefault: true,  createdAt: '', updatedAt: '' },
      { id: 'w2', userId: 'u1', name: 'B', isDefault: false, createdAt: '', updatedAt: '' },
    ];
    useWorkspacesStore.getState().applyRemoteWorkspaces(rows);
    expect(useWorkspacesStore.getState().workspaces).toEqual(rows);
  });

  it('setCurrentWorkspaceId updates the active id', () => {
    useWorkspacesStore.getState().setCurrentWorkspaceId('w2');
    expect(useWorkspacesStore.getState().currentWorkspaceId).toBe('w2');
  });

  it('reset wipes all slices', () => {
    useWorkspacesStore.getState().applyRemoteWorkspaces([
      { id: 'w1', userId: 'u1', name: 'A', isDefault: true, createdAt: '', updatedAt: '' },
    ]);
    useWorkspacesStore.getState().setCurrentWorkspaceId('w1');
    useWorkspacesStore.getState().reset();
    const s = useWorkspacesStore.getState();
    expect(s.workspaces).toEqual([]);
    expect(s.currentWorkspaceId).toBeNull();
  });
});
