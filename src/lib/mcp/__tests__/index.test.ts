// src/lib/mcp/__tests__/index.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock, listenMock, refreshSessionMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  refreshSessionMock: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { refreshSession: refreshSessionMock } },
}));

import {
  notifyMcpAccountTokenChanged,
  notifyMcpAccountRemoved,
  notifyMcpAccountSignedOut,
  pushMcpSupabaseConfig,
  notifyMcpAccountRegistered,
  readMcpConfigForAccount,
  setupMcpAuthListener,
  teardownMcpAuthListener,
} from '@/lib/mcp';

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  refreshSessionMock.mockReset();
  teardownMcpAuthListener();
  // Silence the console.warn / console.info calls from the swallow-error paths
  // so vitest 4's stderr capture doesn't mark those tests as failed.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
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
