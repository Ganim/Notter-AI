// src/lib/workspaces/__tests__/fs-migration-v2.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMock = vi.hoisted(() => ({
  exists: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  BaseDirectory: { AppLocalData: 1 },
}));
vi.mock('@tauri-apps/plugin-fs', () => fsMock);

import {
  migrateAccountToWorkspacesIfNeeded,
  SENTINEL_V2_PATH,
} from '@/lib/workspaces/fs-migration-v2';

describe('migrateAccountToWorkspacesIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.exists.mockResolvedValue(false);
    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);
    fsMock.writeTextFile.mockResolvedValue(undefined);
  });

  it('skips when the v2 sentinel already exists', async () => {
    fsMock.exists.mockImplementation(async (p: string) => p === SENTINEL_V2_PATH);
    const r = await migrateAccountToWorkspacesIfNeeded('acc-1', 'ws-1');
    expect(r.skipped).toBe(true);
    expect(r.moved).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(fsMock.rename).not.toHaveBeenCalled();
    expect(fsMock.mkdir).not.toHaveBeenCalled();
    expect(fsMock.writeTextFile).not.toHaveBeenCalled();
  });

  it('moves cache and exports when present', async () => {
    fsMock.exists.mockImplementation(async (p: string) => {
      return p === 'notter-ai/acc-1/cache' || p === 'notter-ai/acc-1/exports';
    });
    const r = await migrateAccountToWorkspacesIfNeeded('acc-1', 'ws-1');
    expect(r.skipped).toBe(false);
    expect(r.moved.sort()).toEqual(['cache', 'exports']);
    expect(r.failed).toEqual([]);
    expect(fsMock.rename).toHaveBeenCalledTimes(2);
    expect(fsMock.rename).toHaveBeenCalledWith(
      'notter-ai/acc-1/cache',
      'notter-ai/acc-1/ws-1/cache',
      expect.any(Object),
    );
    expect(fsMock.rename).toHaveBeenCalledWith(
      'notter-ai/acc-1/exports',
      'notter-ai/acc-1/ws-1/exports',
      expect.any(Object),
    );
    expect(fsMock.writeTextFile).toHaveBeenCalledWith(
      SENTINEL_V2_PATH,
      expect.any(String),
      expect.any(Object),
    );
  });

  it('skips a subdir that does not exist', async () => {
    fsMock.exists.mockImplementation(async (p: string) => p === 'notter-ai/acc-1/cache');
    const r = await migrateAccountToWorkspacesIfNeeded('acc-1', 'ws-1');
    expect(r.moved).toEqual(['cache']);
    expect(r.failed).toEqual([]);
    expect(fsMock.rename).toHaveBeenCalledTimes(1);
    expect(fsMock.rename).toHaveBeenCalledWith(
      'notter-ai/acc-1/cache',
      'notter-ai/acc-1/ws-1/cache',
      expect.any(Object),
    );
  });

  it('skips a subdir when the target already exists (idempotent retry)', async () => {
    fsMock.exists.mockImplementation(async (p: string) => {
      return p === 'notter-ai/acc-1/cache' || p === 'notter-ai/acc-1/ws-1/cache';
    });
    const r = await migrateAccountToWorkspacesIfNeeded('acc-1', 'ws-1');
    expect(r.skipped).toBe(false);
    expect(r.moved).toEqual(['cache']);
    expect(r.failed).toEqual([]);
    // rename was NOT called for cache since target already exists
    expect(fsMock.rename).not.toHaveBeenCalled();
    // sentinel still written (no failures)
    expect(fsMock.writeTextFile).toHaveBeenCalledWith(
      SENTINEL_V2_PATH,
      expect.any(String),
      expect.any(Object),
    );
  });

  it('writes the sentinel only when no failures', async () => {
    fsMock.exists.mockImplementation(async (p: string) => p === 'notter-ai/acc-1/cache');
    fsMock.rename.mockRejectedValueOnce(new Error('locked'));
    const r = await migrateAccountToWorkspacesIfNeeded('acc-1', 'ws-1');
    expect(r.skipped).toBe(false);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0]).toEqual({ path: 'cache', error: 'locked' });
    expect(fsMock.writeTextFile).not.toHaveBeenCalledWith(
      SENTINEL_V2_PATH,
      expect.anything(),
      expect.anything(),
    );
  });

  it('creates the workspace directory before moving subdirs', async () => {
    fsMock.exists.mockImplementation(async (p: string) => p === 'notter-ai/acc-1/cache');
    await migrateAccountToWorkspacesIfNeeded('acc-1', 'ws-1');
    expect(fsMock.mkdir).toHaveBeenCalledWith(
      'notter-ai/acc-1/ws-1',
      expect.objectContaining({ recursive: true }),
    );
  });

  it('sentinel payload includes accountId, workspaceId, and moved list', async () => {
    fsMock.exists.mockImplementation(async (p: string) => {
      return p === 'notter-ai/acc-1/cache' || p === 'notter-ai/acc-1/exports';
    });
    await migrateAccountToWorkspacesIfNeeded('acc-1', 'ws-1');
    const sentinelCall = fsMock.writeTextFile.mock.calls.find(
      (c: any[]) => c[0] === SENTINEL_V2_PATH,
    );
    expect(sentinelCall).toBeDefined();
    const payload = JSON.parse(sentinelCall![1] as string);
    expect(payload.perAccount).toHaveLength(1);
    expect(payload.perAccount[0]).toEqual({
      accountId: 'acc-1',
      workspaceId: 'ws-1',
      moved: expect.arrayContaining(['cache', 'exports']),
    });
    expect(typeof payload.migratedAt).toBe('string');
  });
});
