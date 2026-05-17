// src/lib/mcp/__tests__/index.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  invokeMock,
  listenMock,
  refreshSessionMock,
  activeAccountIdMock,
  switchWorkspaceMock,
  workspaceGetMock,
  setCurrentWorkspaceIdMock,
  workspaceStoreState,
  currentWorkspaceIdGetter,
  toastSuccessMock,
  toastErrorMock,
  i18nTMock,
} = vi.hoisted(() => {
  const setCurrentWorkspaceIdMock = vi.fn();
  const workspaceStoreState = { setCurrentWorkspaceId: setCurrentWorkspaceIdMock };
  return {
    invokeMock: vi.fn(),
    listenMock: vi.fn(),
    refreshSessionMock: vi.fn(),
    activeAccountIdMock: vi.fn(),
    switchWorkspaceMock: vi.fn(),
    workspaceGetMock: vi.fn(),
    setCurrentWorkspaceIdMock,
    workspaceStoreState,
    currentWorkspaceIdGetter: vi.fn(),
    toastSuccessMock: vi.fn(),
    toastErrorMock: vi.fn(),
    i18nTMock: vi.fn(
      (key: string, opts?: Record<string, unknown>) =>
        opts?.name ? `${key}:${opts.name}` : key,
    ),
  };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { refreshSession: refreshSessionMock } },
}));
vi.mock('@/lib/accounts/account-manager', () => ({
  getAccountManager: () => ({
    get activeAccountId() {
      return activeAccountIdMock();
    },
  }),
}));
vi.mock('@/lib/workspaces/workspace-manager', () => ({
  getWorkspaceManager: () => ({
    get currentWorkspaceId() {
      return currentWorkspaceIdGetter();
    },
    get: workspaceGetMock,
    switchWorkspace: switchWorkspaceMock,
  }),
}));
vi.mock('@/stores/workspaces-store', () => ({
  useWorkspacesStore: { getState: () => workspaceStoreState },
}));
vi.mock('sonner', () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));
vi.mock('@/i18n', () => ({ default: { t: i18nTMock } }));

import {
  notifyMcpAccountTokenChanged,
  notifyMcpAccountRemoved,
  notifyMcpAccountSignedOut,
  pushMcpSupabaseConfig,
  notifyMcpAccountRegistered,
  readMcpConfigForAccount,
  setupMcpAuthListener,
  teardownMcpAuthListener,
  setupMcpWorkspaceSwitchListener,
  teardownMcpWorkspaceSwitchListener,
} from '@/lib/mcp';

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  refreshSessionMock.mockReset();
  activeAccountIdMock.mockReset();
  switchWorkspaceMock.mockReset();
  workspaceGetMock.mockReset();
  setCurrentWorkspaceIdMock.mockReset();
  currentWorkspaceIdGetter.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  teardownMcpAuthListener();
  teardownMcpWorkspaceSwitchListener();
  // Silence the console.warn / console.info calls from the swallow-error paths
  // so vitest 4's stderr capture doesn't mark those tests as failed.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('mcp glue', () => {
  it('notifyMcpAccountTokenChanged forwards to mcp_update_account_token', async () => {
    invokeMock.mockResolvedValue(undefined);
    await notifyMcpAccountTokenChanged('acc1', 'tok1', 9999);
    expect(invokeMock).toHaveBeenCalledWith('mcp_update_account_token', {
      args: { accountId: 'acc1', accessToken: 'tok1', expiresAt: 9999 },
    });
  });

  it('swallows errors from invoke', async () => {
    invokeMock.mockRejectedValue(new Error('boom'));
    await expect(
      notifyMcpAccountTokenChanged('acc1', 'tok1', 9999),
    ).resolves.toBeUndefined();
  });

  it('notifyMcpAccountRemoved forwards to mcp_remove_account_token (hard revoke)', async () => {
    invokeMock.mockResolvedValue(undefined);
    await notifyMcpAccountRemoved('acc1');
    expect(invokeMock).toHaveBeenCalledWith('mcp_remove_account_token', { accountId: 'acc1' });
  });

  it('notifyMcpAccountSignedOut forwards to mcp_clear_account_access_token (soft clear)', async () => {
    invokeMock.mockResolvedValue(undefined);
    await notifyMcpAccountSignedOut('acc1');
    expect(invokeMock).toHaveBeenCalledWith('mcp_clear_account_access_token', { accountId: 'acc1' });
  });

  it('notifyMcpAccountRegistered forwards to mcp_register_bearer with the camelCase args envelope', async () => {
    invokeMock.mockResolvedValue(undefined);
    await notifyMcpAccountRegistered('acc1', 'tok-bearer');
    expect(invokeMock).toHaveBeenCalledWith('mcp_register_bearer', {
      args: { accountId: 'acc1', bearerToken: 'tok-bearer' },
    });
  });

  it('pushMcpSupabaseConfig forwards to mcp_set_supabase_config', async () => {
    invokeMock.mockResolvedValue(undefined);
    await pushMcpSupabaseConfig('https://x.supabase.co', 'anon-key-xyz');
    expect(invokeMock).toHaveBeenCalledWith('mcp_set_supabase_config', {
      args: { url: 'https://x.supabase.co', anonKey: 'anon-key-xyz' },
    });
  });

  it('readMcpConfigForAccount returns null on error', async () => {
    invokeMock.mockRejectedValue(new Error('not found'));
    expect(await readMcpConfigForAccount('acc1')).toBeNull();
  });

  it('readMcpConfigForAccount forwards args + returns config on success', async () => {
    invokeMock.mockResolvedValue({
      url: 'http://127.0.0.1:1234/mcp',
      bearer_token: 'tok',
      account_id: 'acc1',
      generated_at: '2026-05-10T00:00:00Z',
    });
    const cfg = await readMcpConfigForAccount('acc1');
    expect(invokeMock).toHaveBeenCalledWith('mcp_read_account_config', {
      args: { accountId: 'acc1' },
    });
    expect(cfg?.bearer_token).toBe('tok');
  });
});

describe('mcp:auth-needed listener', () => {
  it('subscribes to mcp:auth-needed once + calls refreshSession on event', async () => {
    // Capture the handler the listener registers.
    let registered: ((e: { payload: { accountId: string } }) => void) | null = null;
    listenMock.mockImplementation(async (_evt: string, handler: any) => {
      registered = handler;
      return () => {};
    });
    refreshSessionMock.mockResolvedValue({ data: { session: {} }, error: null });

    await setupMcpAuthListener();
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledWith('mcp:auth-needed', expect.any(Function));
    expect(registered).toBeTruthy();

    // Simulate an emit from Rust.
    await registered!({ payload: { accountId: 'acc1' } });
    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
  });

  it('debounces concurrent events — only one refreshSession in flight', async () => {
    let registered: ((e: { payload: { accountId: string } }) => void) | null = null;
    listenMock.mockImplementation(async (_evt: string, handler: any) => {
      registered = handler;
      return () => {};
    });
    // Make refresh resolve only after we say so.
    let releaseRefresh: () => void = () => {};
    refreshSessionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRefresh = () => resolve({ data: { session: {} }, error: null });
        }),
    );

    await setupMcpAuthListener();
    // Two events arrive while the first refresh is still pending.
    const p1 = registered!({ payload: { accountId: 'acc1' } });
    const p2 = registered!({ payload: { accountId: 'acc1' } });
    expect(refreshSessionMock).toHaveBeenCalledTimes(1);

    releaseRefresh();
    await Promise.all([p1, p2]);
    // After the first one resolves, the inFlight flag is reset but no second
    // refresh was attempted (the second event was already dropped).
    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — second setup call is a no-op', async () => {
    listenMock.mockResolvedValue(() => {});
    await setupMcpAuthListener();
    await setupMcpAuthListener();
    expect(listenMock).toHaveBeenCalledTimes(1);
  });
});

describe('mcp:workspace-switch listener', () => {
  type SwitchPayload = { accountId: string; workspaceId: string };
  type SwitchHandler = (e: { payload: SwitchPayload }) => Promise<void> | void;

  async function captureHandler(): Promise<SwitchHandler> {
    let registered: SwitchHandler | null = null;
    listenMock.mockImplementation(async (evt: string, handler: SwitchHandler) => {
      if (evt === 'mcp:workspace-switch') registered = handler;
      return () => {};
    });
    await setupMcpWorkspaceSwitchListener();
    expect(listenMock).toHaveBeenCalledWith(
      'mcp:workspace-switch',
      expect.any(Function),
    );
    expect(registered).toBeTruthy();
    return registered!;
  }

  it('switches workspace + toasts when event accountId matches active account', async () => {
    activeAccountIdMock.mockReturnValue('acc1');
    currentWorkspaceIdGetter.mockReturnValue('ws-current');
    workspaceGetMock.mockReturnValue({ id: 'ws-target', name: 'Target', isDefault: false });
    switchWorkspaceMock.mockResolvedValue(undefined);

    const handler = await captureHandler();
    await handler({ payload: { accountId: 'acc1', workspaceId: 'ws-target' } });

    expect(switchWorkspaceMock).toHaveBeenCalledWith('ws-target');
    expect(setCurrentWorkspaceIdMock).toHaveBeenCalledWith('ws-target');
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('drops cross-account events (background account stays untouched)', async () => {
    activeAccountIdMock.mockReturnValue('acc-foreground');
    currentWorkspaceIdGetter.mockReturnValue('ws-current');

    const handler = await captureHandler();
    await handler({
      payload: { accountId: 'acc-background', workspaceId: 'ws-target' },
    });

    expect(switchWorkspaceMock).not.toHaveBeenCalled();
    expect(setCurrentWorkspaceIdMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the requested workspace is already active', async () => {
    activeAccountIdMock.mockReturnValue('acc1');
    currentWorkspaceIdGetter.mockReturnValue('ws-target');

    const handler = await captureHandler();
    await handler({ payload: { accountId: 'acc1', workspaceId: 'ws-target' } });

    expect(switchWorkspaceMock).not.toHaveBeenCalled();
    expect(setCurrentWorkspaceIdMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it('toasts error + skips state update when workspace is unknown', async () => {
    activeAccountIdMock.mockReturnValue('acc1');
    currentWorkspaceIdGetter.mockReturnValue('ws-current');
    workspaceGetMock.mockReturnValue(null);

    const handler = await captureHandler();
    await handler({ payload: { accountId: 'acc1', workspaceId: 'ws-gone' } });

    expect(switchWorkspaceMock).not.toHaveBeenCalled();
    expect(setCurrentWorkspaceIdMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  it('toasts error when switchWorkspace throws', async () => {
    activeAccountIdMock.mockReturnValue('acc1');
    currentWorkspaceIdGetter.mockReturnValue('ws-current');
    workspaceGetMock.mockReturnValue({ id: 'ws-target', name: 'Target', isDefault: false });
    switchWorkspaceMock.mockRejectedValue(new Error('boom'));

    const handler = await captureHandler();
    await handler({ payload: { accountId: 'acc1', workspaceId: 'ws-target' } });

    expect(switchWorkspaceMock).toHaveBeenCalled();
    expect(setCurrentWorkspaceIdMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it('is idempotent — second setup call does not double-attach', async () => {
    listenMock.mockResolvedValue(() => {});
    await setupMcpWorkspaceSwitchListener();
    await setupMcpWorkspaceSwitchListener();
    const wsCalls = listenMock.mock.calls.filter(
      ([evt]) => evt === 'mcp:workspace-switch',
    );
    expect(wsCalls).toHaveLength(1);
  });
});
