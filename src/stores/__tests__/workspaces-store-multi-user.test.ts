// src/stores/__tests__/workspaces-store-multi-user.test.ts
//
// Plan 1, Task 6 — verifies that useWorkspacesStore derives currentRole
// from the currently active workspace and exposes memberCounts keyed by id.
import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import type { WorkspaceRecord } from '@/lib/sync';

function ws(over: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    id: 'w1',
    userId: 'u1',
    name: 'w',
    isDefault: false,
    createdAt: '2026-05-14T00:00:00Z',
    updatedAt: '2026-05-14T00:00:00Z',
    currentRole: 'owner',
    memberCount: 1,
    ...over,
  };
}

describe('workspaces-store multi-user fields', () => {
  beforeEach(() => {
    useWorkspacesStore.getState().reset();
  });

  it('currentRole is null when there is no current workspace', () => {
    expect(useWorkspacesStore.getState().currentRole).toBeNull();
  });

  it('currentRole follows currentWorkspaceId', () => {
    useWorkspacesStore.getState().applyRemoteWorkspaces([
      ws({ id: 'w1', currentRole: 'owner', memberCount: 1 }),
      ws({ id: 'w2', currentRole: 'viewer', memberCount: 3 }),
    ]);
    useWorkspacesStore.getState().setCurrentWorkspaceId('w1');
    expect(useWorkspacesStore.getState().currentRole).toBe('owner');
    useWorkspacesStore.getState().setCurrentWorkspaceId('w2');
    expect(useWorkspacesStore.getState().currentRole).toBe('viewer');
  });

  it('memberCounts is keyed by workspace id', () => {
    useWorkspacesStore.getState().applyRemoteWorkspaces([
      ws({ id: 'w1', memberCount: 1 }),
      ws({ id: 'w2', memberCount: 4 }),
    ]);
    expect(useWorkspacesStore.getState().memberCounts).toEqual({ w1: 1, w2: 4 });
  });

  it('reset clears currentRole and memberCounts', () => {
    useWorkspacesStore.getState().applyRemoteWorkspaces([ws({ id: 'w1', memberCount: 2 })]);
    useWorkspacesStore.getState().setCurrentWorkspaceId('w1');
    useWorkspacesStore.getState().reset();
    expect(useWorkspacesStore.getState().currentRole).toBeNull();
    expect(useWorkspacesStore.getState().memberCounts).toEqual({});
  });

  it('currentRole is null when currentWorkspaceId references an unknown id', () => {
    useWorkspacesStore.getState().applyRemoteWorkspaces([ws({ id: 'w1', currentRole: 'owner' })]);
    useWorkspacesStore.getState().setCurrentWorkspaceId('w999');
    expect(useWorkspacesStore.getState().currentRole).toBeNull();
  });
});
