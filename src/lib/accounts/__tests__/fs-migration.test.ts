// src/lib/accounts/__tests__/fs-migration.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMock = vi.hoisted(() => ({
  exists: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  BaseDirectory: { AppLocalData: 1 },
}));
vi.mock('@tauri-apps/plugin-fs', () => fsMock);

import { migrateLegacyLayoutIfNeeded, SENTINEL_PATH } from '@/lib/accounts/fs-migration';

beforeEach(() => vi.clearAllMocks());

describe('migrateLegacyLayoutIfNeeded', () => {
  it('skips when the sentinel already exists', async () => {
    fsMock.exists.mockImplementation(async (p: string) => p === SENTINEL_PATH);
    const result = await migrateLegacyLayoutIfNeeded('u1');
    expect(result.skipped).toBe(true);
    expect(fsMock.rename).not.toHaveBeenCalled();
  });

  it('moves NotterProjects, AgentProfiles, exec-state, tmp-prompts into notter-ai/<id>/', async () => {
    fsMock.exists.mockImplementation(async (p: string) => {
      if (p === SENTINEL_PATH) return false;
      return ['NotterProjects', 'AgentProfiles', 'exec-state', 'tmp-prompts', 'actions.json'].includes(p);
    });
    const result = await migrateLegacyLayoutIfNeeded('u1');
    expect(result.skipped).toBe(false);
    expect(result.moved.sort()).toEqual(['AgentProfiles', 'NotterProjects', 'actions.json', 'exec-state', 'tmp-prompts']);
    for (const dir of ['NotterProjects', 'AgentProfiles', 'exec-state', 'tmp-prompts', 'actions.json']) {
      expect(fsMock.rename).toHaveBeenCalledWith(dir, `notter-ai/u1/${dir}`, expect.any(Object));
    }
    // Sentinel written LAST
    const writeOrder = fsMock.writeTextFile.mock.calls.map((c: any[]) => c[0]);
    expect(writeOrder[writeOrder.length - 1]).toBe(SENTINEL_PATH);
  });

  it('does not write sentinel if any rename fails', async () => {
    fsMock.exists.mockImplementation(async (p: string) => p !== SENTINEL_PATH);
    fsMock.rename.mockRejectedValueOnce(new Error('EBUSY'));
    const result = await migrateLegacyLayoutIfNeeded('u1');
    expect(result.skipped).toBe(false);
    expect(result.failed.length).toBeGreaterThan(0);
    const writes = fsMock.writeTextFile.mock.calls.map((c: any[]) => c[0]);
    expect(writes).not.toContain(SENTINEL_PATH);
  });
});
