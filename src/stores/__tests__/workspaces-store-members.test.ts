import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import type { WorkspaceMember, WorkspaceInvite } from '@/lib/sync';

const member = (over: Partial<WorkspaceMember>): WorkspaceMember => ({
  userId: 'u1',
  role: 'owner',
  joinedAt: '2026-05-15T00:00:00Z',
  invitedAt: null,
  email: 'u1@ex.com',
  displayName: 'U1',
  ...over,
});

const invite = (over: Partial<WorkspaceInvite>): WorkspaceInvite => ({
  id: 'i1',
  workspaceId: 'w1',
  email: 'newby@ex.com',
  invitedBy: 'u1',
  role: 'editor',
  expiresAt: '2026-05-22T00:00:00Z',
  revokedAt: null,
  acceptedAt: null,
  acceptedBy: null,
  createdAt: '2026-05-15T00:00:00Z',
  ...over,
});

describe('workspaces-store members + pendingInvites', () => {
  beforeEach(() => {
    useWorkspacesStore.getState().reset();
  });

  it('setWorkspaceMembers stores by workspace id', () => {
    useWorkspacesStore.getState().setWorkspaceMembers('w1', [member({})]);
    expect(useWorkspacesStore.getState().members['w1']).toHaveLength(1);
    expect(useWorkspacesStore.getState().members['w2']).toBeUndefined();
  });

  it('setPendingInvites stores by workspace id', () => {
    useWorkspacesStore.getState().setPendingInvites('w1', [invite({})]);
    expect(useWorkspacesStore.getState().pendingInvites['w1']).toHaveLength(1);
  });

  it('setWorkspaceMembers replaces — does not append — for the same workspace', () => {
    useWorkspacesStore.getState().setWorkspaceMembers('w1', [member({ userId: 'a' })]);
    useWorkspacesStore.getState().setWorkspaceMembers('w1', [member({ userId: 'b' })]);
    const list = useWorkspacesStore.getState().members['w1'];
    expect(list).toHaveLength(1);
    expect(list[0].userId).toBe('b');
  });

  it('reset clears members and pendingInvites', () => {
    useWorkspacesStore.getState().setWorkspaceMembers('w1', [member({})]);
    useWorkspacesStore.getState().setPendingInvites('w1', [invite({})]);
    useWorkspacesStore.getState().reset();
    expect(useWorkspacesStore.getState().members).toEqual({});
    expect(useWorkspacesStore.getState().pendingInvites).toEqual({});
  });
});
