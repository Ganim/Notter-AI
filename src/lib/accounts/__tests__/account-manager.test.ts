// src/lib/accounts/__tests__/account-manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storageMock, secureMock, supabaseMock, registryMock, realtimeMock } = vi.hoisted(() => {
  const storageMock = {
    readAccountIndex: vi.fn(),
    writeAccountIndex: vi.fn().mockResolvedValue(undefined),
    readActiveAccount: vi.fn(),
    writeActiveAccount: vi.fn().mockResolvedValue(undefined),
  };
  const secureMock = {
    secureSet: vi.fn().mockResolvedValue(undefined),
    secureDelete: vi.fn().mockResolvedValue(undefined),
    secureGet: vi.fn().mockResolvedValue(null),
    secureRegisterKnownKeys: vi.fn().mockResolvedValue(undefined),
    accountKeys: {
      refreshToken: (id: string) => `notter:account:${id}:refresh_token`,
      mcpToken: (id: string) => `notter:account:${id}:mcp_token`,
    },
  };
  const supabaseMock = {
    supabase: {
      auth: {
        setSession: vi.fn(),
      },
    },
    isSupabaseConfigured: true,
    _bindAccountManager: vi.fn(),
  };
  const registryMock = {
    resetAllStores: vi.fn(),
  };
  const realtimeMock = {
    startRealtimeSync: vi.fn(),
    stopRealtimeSync: vi.fn(),
  };
  return { storageMock, secureMock, supabaseMock, registryMock, realtimeMock };
});

vi.mock('@/lib/accounts/account-storage', () => storageMock);
vi.mock('@/lib/accounts/secure-store', () => secureMock);
vi.mock('@/lib/supabase', () => supabaseMock);
vi.mock('@/lib/accounts/store-registry', () => registryMock);
vi.mock('@/lib/realtime', () => realtimeMock);

import { AccountManager } from '@/lib/accounts/account-manager';

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.readAccountIndex.mockResolvedValue({ accounts: [] });
  storageMock.readActiveAccount.mockResolvedValue({ accountId: null });
});

describe('AccountManager.bootstrap', () => {
  it('loads the index and active pointer', async () => {
    storageMock.readAccountIndex.mockResolvedValueOnce({
      accounts: [{ id: 'u1', email: 'a@b.c', displayName: 'A', addedAt: '2026-05-09T00:00:00Z' }],
    });
    storageMock.readActiveAccount.mockResolvedValueOnce({ accountId: 'u1' });
    const mgr = new AccountManager();
    await mgr.bootstrap();
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.activeAccountId).toBe('u1');
  });

  it('rebuilds the secure-store key index from the loaded accounts', async () => {
    storageMock.readAccountIndex.mockResolvedValueOnce({
      accounts: [
        { id: 'u1', email: 'a@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' },
        { id: 'u2', email: 'b@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' },
      ],
    });
    storageMock.readActiveAccount.mockResolvedValueOnce({ accountId: 'u1' });
    const mgr = new AccountManager();
    await mgr.bootstrap();
    expect(secureMock.secureRegisterKnownKeys).toHaveBeenCalledWith([
      'notter:account:u1:refresh_token', 'notter:account:u1:mcp_token',
      'notter:account:u2:refresh_token', 'notter:account:u2:mcp_token',
    ]);
  });
});

describe('AccountManager.add', () => {
  it('persists the refresh token to secure store and writes the index', async () => {
    // Phase H (Workspaces): the per-account mcp_token is no longer minted at
    // add-time. WorkspaceManager owns the per-workspace bearer surface, so
    // only the refresh token is persisted here.
    const mgr = new AccountManager();
    await mgr.bootstrap();
    await mgr.add({
      id: 'u1',
      email: 'a@b.c',
      displayName: 'A',
      refreshToken: 'rt-xyz',
    });
    expect(secureMock.secureSet).toHaveBeenCalledWith(
      'notter:account:u1:refresh_token', 'rt-xyz',
    );
    // Assert no mcp_token write happened.
    expect(secureMock.secureSet).not.toHaveBeenCalledWith(
      'notter:account:u1:mcp_token',
      expect.anything(),
    );
    expect(storageMock.writeAccountIndex).toHaveBeenCalled();
    expect(mgr.list()).toHaveLength(1);
  });

  it('rejects an account id collision', async () => {
    storageMock.readAccountIndex.mockResolvedValueOnce({
      accounts: [{ id: 'u1', email: 'a@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' }],
    });
    const mgr = new AccountManager();
    await mgr.bootstrap();
    await expect(mgr.add({
      id: 'u1', email: 'a@b.c', displayName: null, refreshToken: 'rt',
    })).rejects.toThrow(/already added/);
  });
});

describe('AccountManager.remove', () => {
  beforeEach(() => {
    storageMock.readAccountIndex.mockResolvedValue({
      accounts: [
        { id: 'u1', email: 'a@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' },
        { id: 'u2', email: 'b@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' },
      ],
    });
    storageMock.readActiveAccount.mockResolvedValue({ accountId: 'u1' });
  });

  it('deletes both secure keys and rewrites the index', async () => {
    const mgr = new AccountManager();
    await mgr.bootstrap();
    await mgr.remove('u2');
    expect(secureMock.secureDelete).toHaveBeenCalledWith('notter:account:u2:refresh_token');
    expect(secureMock.secureDelete).toHaveBeenCalledWith('notter:account:u2:mcp_token');
    expect(mgr.list().map((a) => a.id)).toEqual(['u1']);
  });

  it('refuses to remove the currently-active account', async () => {
    const mgr = new AccountManager();
    await mgr.bootstrap();
    await expect(mgr.remove('u1')).rejects.toThrow(/active/);
  });
});

describe('AccountManager.switchAccount', () => {
  beforeEach(() => {
    storageMock.readAccountIndex.mockResolvedValue({
      accounts: [
        { id: 'u1', email: 'a@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' },
        { id: 'u2', email: 'b@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' },
      ],
    });
    storageMock.readActiveAccount.mockResolvedValue({ accountId: 'u1' });
    // Reset switchAccount-specific mocks
    secureMock.secureGet.mockResolvedValue(null);
    supabaseMock.supabase.auth.setSession.mockResolvedValue({ data: { session: null }, error: null });
    registryMock.resetAllStores.mockReset();
    realtimeMock.startRealtimeSync.mockReset();
    realtimeMock.stopRealtimeSync.mockReset();
    storageMock.writeActiveAccount.mockResolvedValue(undefined);
  });

  it('throws immediately when no refresh token is stored (no state change)', async () => {
    secureMock.secureGet.mockResolvedValue(null);
    const mgr = new AccountManager();
    await mgr.bootstrap();

    await expect(mgr.switchAccount('u2')).rejects.toThrow(/session expired/);

    expect(supabaseMock.supabase.auth.setSession).not.toHaveBeenCalled();
    expect(mgr.activeAccountId).toBe('u1');
  });

  it('throws and leaves state untouched when setSession fails', async () => {
    secureMock.secureGet.mockResolvedValue('rt-u2');
    supabaseMock.supabase.auth.setSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'token expired' },
    });
    const mgr = new AccountManager();
    await mgr.bootstrap();

    await expect(mgr.switchAccount('u2')).rejects.toThrow(/token expired/);

    expect(mgr.activeAccountId).toBe('u1');
  });

  it('on success, resets stores then writes the new active pointer last', async () => {
    secureMock.secureGet.mockResolvedValue('rt-u2');
    supabaseMock.supabase.auth.setSession.mockResolvedValue({
      data: { session: { user: { id: 'u2' } } },
      error: null,
    });

    // Mock the dynamic auth-store import
    vi.doMock('@/stores/auth-store', () => ({
      syncOnLogin: vi.fn().mockResolvedValue(undefined),
    }));

    const callOrder: string[] = [];
    realtimeMock.stopRealtimeSync.mockImplementation(() => callOrder.push('stopRealtimeSync'));
    registryMock.resetAllStores.mockImplementation(() => callOrder.push('resetAllStores'));
    realtimeMock.startRealtimeSync.mockImplementation(() => callOrder.push('startRealtimeSync'));
    storageMock.writeActiveAccount.mockImplementation(async () => callOrder.push('writeActiveAccount'));

    const mgr = new AccountManager();
    await mgr.bootstrap();
    await mgr.switchAccount('u2');

    expect(callOrder).toEqual([
      'stopRealtimeSync',
      'resetAllStores',
      'startRealtimeSync',
      'writeActiveAccount',
    ]);
    expect(realtimeMock.startRealtimeSync).toHaveBeenCalledWith('u2');
    expect(storageMock.writeActiveAccount).toHaveBeenCalledWith({ accountId: 'u2' });
  });
});
