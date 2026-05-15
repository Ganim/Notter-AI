import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchInvitePreviewMock = vi.fn();
const acceptWorkspaceInviteMock = vi.fn();
vi.mock('@/lib/sync', () => ({
  fetchInvitePreview: (...a: unknown[]) => fetchInvitePreviewMock(...a),
  acceptWorkspaceInvite: (...a: unknown[]) => acceptWorkspaceInviteMock(...a),
}));

const authState = { user: null as null | { email: string } };
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ user: authState.user }) },
}));

const bootstrapMock = vi.fn().mockResolvedValue(undefined);
const switchMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/workspaces/workspace-manager', () => ({
  getWorkspaceManager: () => ({ bootstrap: bootstrapMock, switchWorkspace: switchMock }),
}));

const setCurrentMock = vi.fn();
vi.mock('@/stores/workspaces-store', () => ({
  useWorkspacesStore: { getState: () => ({ setCurrentWorkspaceId: setCurrentMock }) },
}));

beforeEach(async () => {
  fetchInvitePreviewMock.mockReset();
  acceptWorkspaceInviteMock.mockReset();
  bootstrapMock.mockClear();
  switchMock.mockClear();
  setCurrentMock.mockClear();
  authState.user = null;
  // clear module-level pendingInvite between tests
  const mod = await import('@/lib/workspaces/invite-acceptor');
  mod.clearPendingInvite();
});

describe('handleInviteDeepLink', () => {
  it('returns signin_required when no user is signed in', async () => {
    fetchInvitePreviewMock.mockResolvedValue({
      ok: true,
      workspaceName: 'Apollo',
      inviteeEmail: 'a@x.com',
    });
    const { handleInviteDeepLink, getPendingInvite } = await import(
      '@/lib/workspaces/invite-acceptor'
    );
    const r = await handleInviteDeepLink('rawtoken');
    expect(r.kind).toBe('signin_required');
    expect(getPendingInvite()?.inviteeEmail).toBe('a@x.com');
  });

  it('returns error when signed-in email mismatches', async () => {
    fetchInvitePreviewMock.mockResolvedValue({
      ok: true,
      workspaceName: 'Apollo',
      inviteeEmail: 'a@x.com',
    });
    authState.user = { email: 'b@x.com' };
    const { handleInviteDeepLink } = await import('@/lib/workspaces/invite-acceptor');
    const r = await handleInviteDeepLink('rawtoken');
    expect(r.kind).toBe('error');
  });

  it('redeems and switches when email matches', async () => {
    fetchInvitePreviewMock.mockResolvedValue({
      ok: true,
      workspaceName: 'Apollo',
      inviteeEmail: 'a@x.com',
    });
    authState.user = { email: 'a@x.com' };
    acceptWorkspaceInviteMock.mockResolvedValue({ ok: true, workspaceId: 'w1' });
    const { handleInviteDeepLink } = await import('@/lib/workspaces/invite-acceptor');
    const r = await handleInviteDeepLink('rawtoken');
    expect(r.kind).toBe('redeemed');
    expect(switchMock).toHaveBeenCalledWith('w1');
    expect(setCurrentMock).toHaveBeenCalledWith('w1');
  });

  it('returns error when fetch_invite_preview fails', async () => {
    fetchInvitePreviewMock.mockResolvedValue({ ok: false, message: 'invite_not_found' });
    const { handleInviteDeepLink } = await import('@/lib/workspaces/invite-acceptor');
    const r = await handleInviteDeepLink('rawtoken');
    expect(r.kind).toBe('error');
  });
});

describe('redeemPendingInviteAfterSignIn', () => {
  it('no-ops when there is no pending invite', async () => {
    const { redeemPendingInviteAfterSignIn } = await import(
      '@/lib/workspaces/invite-acceptor'
    );
    const r = await redeemPendingInviteAfterSignIn();
    expect(r.kind).toBe('none');
  });

  it('redeems the captured invite once a matching user signs in', async () => {
    // first call captures (no user)
    fetchInvitePreviewMock.mockResolvedValueOnce({
      ok: true,
      workspaceName: 'Apollo',
      inviteeEmail: 'a@x.com',
    });
    const mod = await import('@/lib/workspaces/invite-acceptor');
    await mod.handleInviteDeepLink('rawtoken');
    expect(mod.getPendingInvite()?.token).toBe('rawtoken');

    // user signs in and the redeem call runs the second pass
    authState.user = { email: 'a@x.com' };
    fetchInvitePreviewMock.mockResolvedValueOnce({
      ok: true,
      workspaceName: 'Apollo',
      inviteeEmail: 'a@x.com',
    });
    acceptWorkspaceInviteMock.mockResolvedValue({ ok: true, workspaceId: 'w1' });
    const r = await mod.redeemPendingInviteAfterSignIn();
    expect(r.kind).toBe('redeemed');
    expect(mod.getPendingInvite()).toBeNull();
  });
});
