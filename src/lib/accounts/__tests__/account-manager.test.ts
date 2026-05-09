// src/lib/accounts/__tests__/account-manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storageMock, secureMock } = vi.hoisted(() => {
  const storageMock = {
    readAccountIndex: vi.fn(),
    writeAccountIndex: vi.fn().mockResolvedValue(undefined),
    readActiveAccount: vi.fn(),
    writeActiveAccount: vi.fn().mockResolvedValue(undefined),
  };
  const secureMock = {
    secureSet: vi.fn().mockResolvedValue(undefined),
    secureDelete: vi.fn().mockResolvedValue(undefined),
    secureRegisterKnownKeys: vi.fn().mockResolvedValue(undefined),
    accountKeys: {
      refreshToken: (id: string) => `notter:account:${id}:refresh_token`,
      mcpToken: (id: string) => `notter:account:${id}:mcp_token`,
    },
  };
  return { storageMock, secureMock };
});

vi.mock('@/lib/accounts/account-storage', () => storageMock);
vi.mock('@/lib/accounts/secure-store', () => secureMock);

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
  it('persists the refresh token + mcp token to secure store and writes the index', async () => {
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
    expect(secureMock.secureSet).toHaveBeenCalledWith(
      'notter:account:u1:mcp_token',
      expect.stringMatching(/^notter_acc_/),
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
