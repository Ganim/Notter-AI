import { describe, it, expect, beforeEach, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  BaseDirectory: { AppLocalData: 1 },
}));
vi.mock('@tauri-apps/plugin-fs', () => fsMock);

import {
  readAccountIndex, writeAccountIndex,
  readActiveAccount, writeActiveAccount,
} from '@/lib/accounts/account-storage';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readAccountIndex', () => {
  it('returns empty index when file is missing', async () => {
    fsMock.exists.mockResolvedValueOnce(false);
    const idx = await readAccountIndex();
    expect(idx.accounts).toEqual([]);
  });
  it('parses and returns accounts when file exists', async () => {
    fsMock.exists.mockResolvedValueOnce(true);
    fsMock.readTextFile.mockResolvedValueOnce(JSON.stringify({
      accounts: [{ id: 'u1', email: 'a@b.c', displayName: 'A', addedAt: '2026-01-01T00:00:00Z' }],
    }));
    const idx = await readAccountIndex();
    expect(idx.accounts).toHaveLength(1);
    expect(idx.accounts[0].id).toBe('u1');
  });
});

describe('writeAccountIndex', () => {
  it('writes to accounts/index.json under AppLocalData with a tmp+rename atomic swap', async () => {
    fsMock.exists.mockResolvedValue(true);
    await writeAccountIndex({
      accounts: [{ id: 'u1', email: 'a@b.c', displayName: null, addedAt: '2026-05-09T00:00:00Z' }],
    });
    expect(fsMock.writeTextFile).toHaveBeenCalledWith(
      'notter-ai/accounts/index.json.tmp',
      expect.stringContaining('"u1"'),
      { baseDir: fsMock.BaseDirectory.AppLocalData },
    );
    expect(fsMock.rename).toHaveBeenCalledWith(
      'notter-ai/accounts/index.json.tmp',
      'notter-ai/accounts/index.json',
      expect.any(Object),
    );
  });
});

describe('readActiveAccount', () => {
  it('returns { accountId: null } when file is missing', async () => {
    fsMock.exists.mockResolvedValueOnce(false);
    expect((await readActiveAccount()).accountId).toBeNull();
  });
});

describe('writeActiveAccount', () => {
  it('writes the active pointer atomically', async () => {
    fsMock.exists.mockResolvedValue(true);
    await writeActiveAccount({ accountId: 'u1' });
    expect(fsMock.writeTextFile).toHaveBeenCalledWith(
      'notter-ai/accounts/active.json.tmp',
      expect.stringContaining('"u1"'),
      expect.any(Object),
    );
  });
});
